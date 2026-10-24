# VYBZ

**Meet through play. Connect through chemistry.**

VYBZ is a mobile-first, real-time social gaming platform for adults (18+). People meet
by playing short competitive and collaborative games, and only then decide whether to
keep talking.

---

## Quick start

Requires **Node.js 22.5 or newer** (the durable store uses the built-in `node:sqlite`
module). No database server and no credentials are needed to run locally.

```bash
npm install
npm run setup     # apply migrations and seed prompts/categories/achievements
npm start         # http://localhost:3000
```

For development with automatic restarts:

```bash
npm run dev
```

Copy `.env.example` to `.env` to change the port, session secret or any optional
provider. Every value has a working default, so the app boots with no `.env` at all.

---

## What actually works

Everything below is implemented end to end and covered by the automated suites.
Nothing here is a mock or a decorative placeholder.

### Game modes

| Mode | Key | Status |
| --- | --- | --- |
| Rizz Battle | `rizz_battle` | Full real-time 1v1: matchmaking, accept phase, timed rounds, submissions, peer voting, server-side scoring, rematch |
| Word Chemistry | `word_chemistry` | Shared-prompt answers with similarity scoring and daily challenges |
| Secret Signal | `secret_signal` | Consent-based anonymous compliments; sender identity is never disclosed |
| Spill It! | `spill_it` | Multiplayer rooms with join codes, categories, rounds, skip and report |
| Blind Vibe | `blind_vibe` | Staged anonymous chat; profiles revealed only on mutual interest |

### Platform

- **Auth** — register/login/logout, server-side sessions, multi-session listing,
  logout-all, account deletion with password confirmation, 18+ confirmation enforced
  server-side.
- **Profiles** — username, avatar (preset or uploaded), bio, interests, languages,
  privacy toggles, presence visibility.
- **Matchmaking** — quick match, per-mode queues, difficulty and category filters,
  block-aware exclusion, timeout and cancellation, stale-queue cleanup, honest empty
  state when nobody else is waiting.
- **Real-time** — WebSocket push for match state, round transitions, signals,
  messages, typing and presence. Clients reconnect and re-sync from the server.
- **Server-authoritative play** — round transitions, submission deadlines, voting
  eligibility, score calculation, XP and achievements are all computed on the server.
  Client-supplied scores, timers or results are never trusted.
- **Social** — connections, connection requests (accept/decline/cancel), unmatch,
  blocking, reporting, permitted messaging with read state, mute and typing.
- **Progression** — XP, levels, per-game ranks, streaks, achievements, daily and
  weekly challenges, leaderboard.
- **Chemistry** — per-pair connection score derived from real game events. Kept
  separate from competitive score. Resets on unmatch and respects blocks.
- **Moderation** — report queue, severity classification, user actions
  (warn/suspend/ban), audit log, role-gated admin dashboard.
- **Admin** — user management, reports, match and room diagnostics, prompt and
  category management, game configuration, analytics, audit history.

### Judging

Rizz Battle supports two judging paths:

- **Peer voting** (default) — both players vote on the stronger answer. A round with
  equal votes is recorded as a draw, never as a win.
- **Automated rubric** — a documented heuristic scoring creativity, relevance, humour
  and originality.

The heuristic runs locally and is labelled as such in the UI. No model provider is
configured, so the app **never claims an AI judge is active**. Setting the
`AI_JUDGE_*` variables enables the provider path; if the provider fails, the round
falls back to the local rubric rather than breaking.

---

## Configuration

All variables are optional locally. See `.env.example` for the full annotated list.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WebSocket port |
| `PUBLIC_URL` | `http://localhost:PORT` | Base URL used for links and origin checks |
| `DATABASE_FILE` | `./data/vybz.db` | Durable SQLite file |
| `DB_DRIVER` | `sqlite` | Store driver |
| `DATABASE_URL` | *(unset)* | Postgres/Neon connection string |
| `SESSION_SECRET` | dev fallback | **Set this in production.** Peppers session tokens |
| `SESSION_DAYS` | `30` | Session lifetime |
| `BOOTSTRAP_ADMIN_USERNAME` | `admin` | Account that always receives the admin role |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window |
| `AI_JUDGE_ENABLED` | `false` | Enable the automated judging provider |
| `AI_JUDGE_PROVIDER` / `AI_JUDGE_MODEL` / `AI_JUDGE_API_KEY` / `AI_JUDGE_BASE_URL` | *(unset)* | Provider credentials for automated judging |
| `STORAGE_DRIVER` | `db` | Avatar storage: `db` or `local` |
| `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | *(unset)* | Object storage for avatars |

### Not configured

These integrations have working code paths but no credentials in this environment.
They are inactive, not simulated:

- **Automated AI judging** — runs the local rubric and labels it as heuristic.
- **S3 object storage** — avatars are validated and stored in the database instead,
  bounded by size. Preset avatars always work.
- **Payment processing** — not implemented. No monetization is wired up.
- **Postgres/Neon** — see below.

### Database

The store is a durable local SQLite file via Node's built-in `node:sqlite`. It
survives restarts and needs no server. Migrations are versioned and idempotent in
`server/db/migrations/`, tracked in a `schema_migrations` table.

`DATABASE_URL` is read and logged about but **not yet wired to a Postgres adapter**.
Migration path to Postgres/Neon:

1. Provision a Neon (or other Postgres) database and set `DATABASE_URL`.
2. Add a `pg`-based driver in `server/db/index.js` exposing the same `q.get`,
   `q.all`, `q.run` and `transaction` interface the rest of the server imports.
3. Translate the SQL in `server/db/migrations/` to Postgres. Most of it is portable;
   the changes needed are `INTEGER PRIMARY KEY AUTOINCREMENT` → `GENERATED ALWAYS AS
   IDENTITY`, `datetime('now')` → `now()`, and partial unique indexes (already
   standard in Postgres).
4. Run the migrations against Postgres and point `DB_DRIVER=postgres`.

---

## Testing

Start the server first, then run any suite.

```bash
npm test           # behavioural end-to-end: auth, games, social, safety, lifecycle
npm run test:api   # API contract: every route, auth boundaries, payload shapes
npm run test:ui    # two independent browsers playing a real-time match
npm run test:all   # all three, sequentially
```

`npm run test:ui` needs a Chromium binary. Override with `CHROME=/path/to/chrome`.
It launches two separate Chrome instances with separate profiles so the two sessions
have genuinely independent cookies, then plays a full Rizz Battle round and asserts
each client is pushed into the next phase without polling.

Current status on a clean database:

| Suite | Result |
| --- | --- |
| `tests/e2e.mjs` | 114 passed, 0 failed |
| `tests/verify-api.mjs` | 160 passed, 0 failed |
| `tests/ui-realtime.mjs` | 29 passed, 0 failed |

See `docs/TEST_REPORT.md` for the detailed breakdown, including what is verified and
what remains unverified.

---

## Project layout

```
server/
  index.js            boot: migrate, seed, serve HTTP + WebSocket
  config.js           environment configuration
  middleware.js       session attach, auth/active guards
  ws.js               WebSocket server, presence heartbeat, event fan-out
  db/
    index.js          node:sqlite connection, query helpers, migration runner
    migrations/       versioned SQL (001-006)
    seedData.js       prompts, categories, interests, achievements
  lib/                domain logic: matches, matchmaking, rooms, signals,
                      connections, messaging, safety, progression, judge, ...
  routes/             thin HTTP layer over lib/
  games/              per-mode rules: prompts, round resolution, scoring
public/
  index.html          SPA shell
  css/app.css         design system
  js/                 router, api client, realtime client, view modules
tests/                e2e, API contract and two-browser realtime suites
docs/                 test report, deployment notes
```

---

## Deployment notes

- Set `SESSION_SECRET` to a long random value and `NODE_ENV=production`.
- Set `PUBLIC_URL` to the real origin; it is used for origin checks on HTTP and
  WebSocket requests.
- Serve over HTTPS. Session cookies are `Secure` when `NODE_ENV=production`.
- Back up `data/vybz.db` (or your Postgres database). Migrations never drop user data.
- The app is single-process. To scale horizontally you would need a shared session
  store and a pub/sub layer for WebSocket fan-out; the current design assumes one
  server process.

---

## Known limitations

- `DATABASE_URL` is not connected to a Postgres adapter yet (see the migration path).
- Avatar uploads are stored in the database, not S3, until storage is configured.
- No payment processing; monetization is deliberately not implemented.
- No email delivery, so there is no email verification or password-reset email flow.
- WebSocket fan-out is in-process, so the app does not scale horizontally as-is.
