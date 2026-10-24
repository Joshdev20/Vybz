# VYBZ test report

Run date: 2026-10-24
Environment: local, Node.js v24.21.0, durable SQLite store (`data/vybz.db`), no
external providers configured (no AI judge, no S3, no Postgres).

All three suites were run against a running server on `http://localhost:12000`.

| Suite | Command | Result |
| --- | --- | --- |
| Behavioural end-to-end | `node tests/e2e.mjs` | **114 passed, 0 failed** |
| API contract | `node tests/verify-api.mjs` | **160 passed, 0 failed** |
| Two-account real-time UI | `node tests/ui-realtime.mjs` | **29 passed, 0 failed** |

---

## What each suite proves

### `tests/e2e.mjs` — behavioural

Two independent authenticated accounts exercising real rules, not just status codes.

- **Auth** — registration, login, logout, session invalidation after logout, data
  persisting across sessions, account deletion requiring explicit confirmation and
  the correct password.
- **Matchmaking** — both accounts queue, exactly one match is created, both clients
  agree on the match id, duplicate active matches are prevented.
- **Server-authoritative rounds** — submissions, deadlines, voting eligibility,
  duplicate vote and duplicate submission rejection, server-side score calculation.
- **Blocking and reporting** — blocks prevent later interaction, reports create
  reviewable records.
- **Secret Signal** — signals are delivered, sender identity is not leaked through
  the API response.
- **Blind Vibe** — anonymous chat works, one-sided interest is stored but never
  revealed, the fact that a choice was made is not leaked, mutual interest reveals
  and connects.
- **Admin** — a normal user is denied admin endpoints and cannot grant themselves a
  role.

### `tests/verify-api.mjs` — API contract

Walks the whole route surface with two registered accounts plus an anonymous client.

- Every documented route returns its expected status and payload shape.
- Auth boundaries: protected routes reject anonymous callers; `/api/auth/me` returns
  a null session rather than an error (it is a session probe).
- Match lifecycle: queue → tick → accept → submit → vote → score → complete →
  result → rematch → leave.
- Privacy assertions: public profiles hide email; opponent answers are withheld before
  the reveal; the result payload never contains a raw submission body; signal
  responses never name the sender; a one-sided Blind Vibe interest is not reported as
  mutual and does not reveal the other person.
- Authorization: a stranger cannot read a match or conversation; a blocked account
  cannot open a conversation.
- Admin: normal users are denied all admin reads and writes; the bootstrap admin can
  read overview, users, reports, audit log, prompts, categories, game modes,
  analytics, match diagnostics and room diagnostics.
- All 11 SPA routes serve the shell.

### `tests/ui-realtime.mjs` — two browsers, one match

Two separate headless Chrome instances with separate profile directories, so the two
sessions have genuinely independent cookies. It drives the real UI.

- Both accounts register and complete onboarding through the interface.
- Both join the Rizz Battle queue from the Play screen.
- **Both clients are routed into the match by the WebSocket push**, with no polling
  and no manual reload, and agree on the same match.
- Both are offered the accept button; accepting starts the round.
- Both submit an answer; **the second submission pushes both clients into the voting
  phase in real time**.
- Before the reveal, each player sees their own answer and the opponent's answer is
  hidden.
- Both vote; the round is scored and **both answers are revealed to both players**.
- A player cannot vote again once the round is scored.
- The rubric breakdown renders real numbers, not placeholder dashes.
- Both clients describe the round outcome identically.
- No console errors or uncaught exceptions during the whole session.

---

## Bugs found and fixed during verification

These were found by writing the tests, not assumed:

1. **Onboarding never rendered.** `/api/auth/me` returned raw database preferences
   where `preferred_games` is a JSON string, so the client's `.map()` threw and the
   onboarding view never painted. Fixed with a `publicPreferences()` normalizer.
2. **Play tiles showed "undefined prompts".** The dashboard `modes` payload omitted
   `promptCount`, `categories`, `maxPlayers` and `queue`. Fixed by using the shared
   richer mode builder.
3. **Players got stuck on "Waiting for your opponent".** No `match_update` event was
   emitted on state transitions, and client polling is disabled while the WebSocket is
   connected. Fixed by broadcasting match state on every transition.
4. **Rubric breakdown always showed dashes.** Peer-voted rounds stored a plain note
   string while the client parsed a JSON envelope, so the four rubric values were
   always missing. Fixed by persisting the same JSON shape on both paths.
5. **A drawn round was reported as a win and a loss.** The client assumed the
   highest-points result row won, so both players were told they won/lost
   contradictorily. Fixed by deriving the winner from the recorded `reason`.
6. **Reconnecting after unmatch crashed with a 500.** `UNIQUE (from_user_id,
   to_user_id, status)` meant a pair could only ever have one `accepted` request, so
   re-requesting collided with retained history and surfaced as an unhandled SQLite
   error. Fixed with migration 006, which rebuilds the table and replaces the
   constraint with a partial unique index on `pending` rows only. Existing rows are
   preserved (verified: 27 rows and 10 accepted history rows retained).
7. **`/rematch` returned a raw snake_case database row** while every other match
   endpoint returns camelCase. Fixed to match the rest of the API.
8. **`npm test` was broken.** The script pointed at `node --test tests/`, which does
   not match `tests/e2e.mjs`, so it failed with `MODULE_NOT_FOUND`. Fixed, and the
   API and UI suites were added as separate scripts.

---

## Verified against the requirements

| Requirement | Status | Evidence |
| --- | --- | --- |
| 18+ confirmation enforced | Pass | Register without `ageConfirmed` returns 400 with an explicit message |
| Bootstrap admin | Pass | First registered user receives `admin`; `BOOTSTRAP_ADMIN_USERNAME` always gets it |
| Admin access denied to normal users | Pass | 7 negative admin checks |
| Admin dashboard usable | Pass | 10 positive admin reads |
| Real-time multiplayer | Pass | 29 UI assertions across two browsers |
| Server-authoritative scoring | Pass | Duplicate submission/vote rejected; scores computed server-side |
| Draw handling | Pass | Both clients report "Round drawn" |
| Opponent answers hidden pre-reveal | Pass | API and UI assertions |
| Blocking prevents later contact | Pass | Connection removed, conversation refused |
| Reporting creates records | Pass | Reports and report-reason validation |
| Anonymous sender identity protected | Pass | Signal responses never name the sender |
| One-sided Blind Vibe interest not leaked | Pass | Not reported as mutual, identity withheld |
| Migration preserves existing data | Pass | 27 request rows and 10 accepted rows retained |
| Session lifecycle | Pass | Logout invalidates, data persists across sessions |
| Account deletion | Pass | Requires confirmation and correct password |
| Responsive layout | Partially verified | CSS is mobile-first with breakpoints; no automated visual regression |
| Media upload | Unverified | No avatar upload exercised end to end |

---

## Not verified / blocked

These are honest gaps, not claims of completion.

1. **Avatar upload end to end.** The route, validation and size limits exist, but no
   binary upload was exercised in the suites. Needs a multipart test.
2. **Responsive layout across real devices.** The layout is mobile-first with
   breakpoints and no horizontal overflow by design, but this was not verified with
   automated visual regression on real phone, tablet and desktop viewports.
3. **Automated AI judging.** No provider credentials, so the provider path is
   unexercised. The local rubric fallback is tested and labelled as heuristic.
4. **Postgres/Neon.** Not configured and no adapter exists, so `DATABASE_URL` is
   inert. The migration path is documented in the README.
5. **S3 storage.** Not configured; avatars use the database driver.
6. **Email delivery.** No mail provider, so there is no email verification or
   password-reset email flow.
7. **Horizontal scaling.** WebSocket fan-out is in-process; multi-instance deployment
   is untested and would need shared sessions and pub/sub.
8. **Load and soak testing.** No concurrency or long-running soak test was run.
9. **Payment processing.** Deliberately not implemented.

---

## How to reproduce

```bash
npm install
npm run setup
npm start &                 # http://localhost:3000

BASE=http://localhost:3000 node tests/e2e.mjs
BASE=http://localhost:3000 node tests/verify-api.mjs
BASE=http://localhost:3000 node tests/ui-realtime.mjs
```

`tests/ui-realtime.mjs` requires Chromium; set `CHROME=/path/to/chrome` if it is not
at `/usr/bin/chromium`.
