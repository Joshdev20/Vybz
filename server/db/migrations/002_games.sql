-- VYBZ migration 002: game catalog, prompts, matchmaking, matches, rounds

CREATE TABLE IF NOT EXISTS game_modes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key          TEXT    NOT NULL UNIQUE,       -- rizz_battle | word_chemistry | ...
  name         TEXT    NOT NULL,
  tagline      TEXT,
  description  TEXT,
  min_players  INTEGER NOT NULL DEFAULT 2,
  max_players  INTEGER NOT NULL DEFAULT 2,
  supports_queue  INTEGER NOT NULL DEFAULT 1,
  supports_rooms  INTEGER NOT NULL DEFAULT 0,
  supports_async  INTEGER NOT NULL DEFAULT 0,
  enabled      INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game_key   TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  label      TEXT    NOT NULL,
  description TEXT,
  intensity  INTEGER NOT NULL DEFAULT 1,       -- 1 mild .. 3 bold
  enabled    INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (game_key, key)
);

CREATE TABLE IF NOT EXISTS game_prompts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  game_key      TEXT    NOT NULL,
  category_id   INTEGER REFERENCES prompt_categories(id) ON DELETE SET NULL,
  text          TEXT    NOT NULL,
  difficulty    TEXT    NOT NULL DEFAULT 'standard',  -- easy | standard | spicy
  round_seconds INTEGER NOT NULL DEFAULT 30,
  locale        TEXT    NOT NULL DEFAULT 'en',
  enabled       INTEGER NOT NULL DEFAULT 1,
  usage_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prompts_game_cat ON game_prompts(game_key, category_id, enabled);

CREATE TABLE IF NOT EXISTS matchmaking_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_key   TEXT    NOT NULL,
  format     TEXT    NOT NULL DEFAULT 'classic',
  difficulty TEXT    NOT NULL DEFAULT 'standard',
  filters    TEXT    NOT NULL DEFAULT '{}',   -- JSON: language, categories, prefs
  status     TEXT    NOT NULL DEFAULT 'waiting', -- waiting | matched | cancelled | expired
  match_id   INTEGER,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_lookup ON matchmaking_queue(game_key, status, created_at);
CREATE INDEX IF NOT EXISTS idx_queue_user ON matchmaking_queue(user_id, status);
-- One live waiting entry per user+game: prevents duplicate active matches.
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_single_waiting
  ON matchmaking_queue(user_id, game_key) WHERE status = 'waiting';

CREATE TABLE IF NOT EXISTS matches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id     TEXT    NOT NULL UNIQUE,
  game_key      TEXT    NOT NULL,
  format        TEXT    NOT NULL DEFAULT 'classic',
  difficulty    TEXT    NOT NULL DEFAULT 'standard',
  status        TEXT    NOT NULL DEFAULT 'pending', -- pending | active | completed | abandoned | expired
  judged_by     TEXT    NOT NULL DEFAULT 'peer',    -- peer | ai | hybrid
  total_rounds  INTEGER NOT NULL DEFAULT 3,
  current_round INTEGER NOT NULL DEFAULT 0,
  room_id       INTEGER,
  winner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_rematch_of INTEGER REFERENCES matches(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT,
  ended_at      TEXT,
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status, game_key);
CREATE INDEX IF NOT EXISTS idx_matches_recent ON matches(created_at DESC);

CREATE TABLE IF NOT EXISTS match_participants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id     INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot         INTEGER NOT NULL,               -- 1..n deterministic ordering
  accepted     INTEGER NOT NULL DEFAULT 0,
  declined     INTEGER NOT NULL DEFAULT 0,
  score        INTEGER NOT NULL DEFAULT 0,
  result       TEXT,                            -- win | loss | draw | abandoned
  xp_awarded   INTEGER NOT NULL DEFAULT 0,
  connected    INTEGER NOT NULL DEFAULT 0,
  joined_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  UNIQUE (match_id, user_id),
  UNIQUE (match_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_participants_user ON match_participants(user_id, match_id);

CREATE TABLE IF NOT EXISTS game_rounds (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id      INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  round_number  INTEGER NOT NULL,
  prompt_id     INTEGER REFERENCES game_prompts(id) ON DELETE SET NULL,
  prompt_text   TEXT    NOT NULL,
  phase         TEXT    NOT NULL DEFAULT 'submitting', -- submitting | voting | revealed | scored
  round_seconds INTEGER NOT NULL DEFAULT 30,
  started_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  submission_deadline TEXT NOT NULL,
  voting_deadline     TEXT,
  scored_at     TEXT,
  UNIQUE (match_id, round_number)
);
CREATE INDEX IF NOT EXISTS idx_rounds_match ON game_rounds(match_id, round_number);

CREATE TABLE IF NOT EXISTS round_submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id     INTEGER NOT NULL REFERENCES game_rounds(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body         TEXT    NOT NULL,
  submitted_at TEXT    NOT NULL DEFAULT (datetime('now')),
  judge_score  INTEGER,                          -- 0..100 automated score when applicable
  judge_source TEXT,                             -- heuristic | ai
  judge_notes  TEXT,
  UNIQUE (round_id, user_id)
);

CREATE TABLE IF NOT EXISTS round_votes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id        INTEGER NOT NULL REFERENCES game_rounds(id) ON DELETE CASCADE,
  voter_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (round_id, voter_user_id),              -- one vote per voter per round
  CHECK (voter_user_id <> target_user_id)        -- cannot vote for yourself
);

CREATE TABLE IF NOT EXISTS game_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id      INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  round_id      INTEGER REFERENCES game_rounds(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  points        INTEGER NOT NULL DEFAULT 0,
  reason        TEXT    NOT NULL DEFAULT 'round',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (match_id, round_id, user_id, reason)   -- idempotent awards
);
CREATE INDEX IF NOT EXISTS idx_results_user ON game_results(user_id, created_at DESC);
