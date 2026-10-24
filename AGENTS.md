# AGENTS.md

Repository-specific context for agents working on VYBZ.

## What this is

VYBZ is a mobile-first, real-time social gaming platform for adults (18+). People
meet by playing short games rather than by scrolling a feed. Five modes: Rizz Battle,
Word Chemistry, Secret Signal, Spill It!, Blind Vibe.

## Stack

- **Runtime**: Node.js >= 22.5. Plain ESM (`"type": "module"`). No build step.
- **Server**: Express 4 + `ws` for WebSocket. Single process.
- **Database**: Node's built-in `node:sqlite` (`DatabaseSync`). No ORM.
- **Client**: Vanilla JS SPA. No framework, no bundler. Hand-rolled DOM helpers in
  `public/js/dom.js` and components in `public/js/components.js`.
- **Tests**: Plain Node scripts with a `check(name, cond)` helper. No test framework.

## Commands

```bash
npm install
npm run setup      # migrate + seed
npm start          # serves on PORT (default 3000)
npm run dev        # watch mode

npm test           # tests/e2e.mjs        behavioural
npm run test:api   # tests/verify-api.mjs API contract
npm run test:ui    # tests/ui-realtime.mjs two browsers
npm run test:responsive  # tests/responsive-audit.mjs layout at 320-1440px
```

The test suites require a **running server**. `test:ui` and `test:responsive`
require Chromium.

### Responsive layout rules

`body` sets `overflow-x: hidden`, so horizontal overflow is invisible: a label
that is too wide is simply clipped, which looks like content running off both
edges. When adding a grid or flex container, give its children `min-width: 0`
and let text wrap, rather than relying on `nowrap`. `npm run test:responsive`
catches both viewport overflow and content wider than its own box.

## Layout

- `server/lib/*` — domain logic. Routes in `server/routes/*` are thin wrappers.
- `server/games/*` — per-mode rules: prompt selection, round resolution, scoring.
  Add a mode by exporting a module and registering it in `server/games/index.js`.
- `server/db/migrations/*.sql` — versioned, idempotent, never destructive. Applied in
  filename order and recorded in `schema_migrations`.
- `public/js/views/*` — one module per route.

## Conventions and gotchas

- **SQLite cannot drop a table-level UNIQUE constraint.** To change one, rebuild the
  table: create `*_new`, copy rows, drop the original, rename. See migration 006.
  Check for foreign keys referencing the table first — SQLite has
  `PRAGMA foreign_keys = ON`.
- **`public_id` vs `id`.** API routes address matches by `public_id` (opaque), not by
  the integer primary key. Internal lib functions take either.
- **API responses are camelCase.** Do not return raw database rows from a route;
  `snake_case` column names leak. This was a real bug in `/rematch`.
- **`/api/auth/me` returns `{user: null}` with status 200** when unauthenticated — it
  is a session probe, not a protected route. Other protected routes return 401.
- **Never trust client-supplied scores, timers, roles or results.** Round transitions,
  deadlines, voting eligibility and scoring are all server-side.
- **Broadcast on every match state transition.** `broadcastMatch(matchId)` in
  `server/lib/matches.js`. Client polling is disabled while the WebSocket is
  connected, so a missing broadcast leaves players stuck.
- **Peer-voted rounds record draws** with `reason: 'round_draw'` and no `round_win`
  row. Derive the winner from `reason`, never from the highest-points row.
- **Judging**: peer voting by default. `AI_JUDGE_OPERATIONAL` gates the provider path;
  when false the local heuristic rubric runs and is labelled as such. Never present
  heuristic scores as AI scores.
- **Anonymity**: never disclose a signal sender or a one-sided Blind Vibe interest —
  not in payloads, error messages, notifications or logs.

## Environment

Every variable has a working default; the app boots with no `.env`. See
`.env.example`. Not configured here: AI judge provider, S3, Postgres, email, payments.
`DATABASE_URL` is read but not wired to an adapter — the migration path to Postgres is
in the README.

## Verified state

`tests/e2e.mjs` 114 passing, `tests/verify-api.mjs` 160 passing,
`tests/ui-realtime.mjs` 29 passing. See `docs/TEST_REPORT.md` for the full breakdown
and the honest list of what is not yet verified (avatar upload, real-device responsive
checks, provider paths).
