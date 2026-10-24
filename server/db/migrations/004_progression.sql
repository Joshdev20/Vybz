-- VYBZ migration 004: progression, statistics, challenges, audit log, telemetry

CREATE TABLE IF NOT EXISTS achievements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL,
  icon        TEXT    NOT NULL DEFAULT 'trophy',
  category    TEXT    NOT NULL DEFAULT 'general',
  threshold   INTEGER NOT NULL DEFAULT 1,
  metric      TEXT    NOT NULL DEFAULT 'matches_played',
  xp_reward   INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS user_achievements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id INTEGER NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  progress       INTEGER NOT NULL DEFAULT 0,
  unlocked_at    TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, achievement_id)
);

CREATE TABLE IF NOT EXISTS experience_transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      INTEGER NOT NULL,
  reason      TEXT    NOT NULL,
  event_key   TEXT,                    -- idempotency key; unique per user when present
  metadata    TEXT    NOT NULL DEFAULT '{}',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_xp_user ON experience_transactions(user_id, created_at DESC);
-- Prevents duplicate awards for the same logical event.
CREATE UNIQUE INDEX IF NOT EXISTS idx_xp_event_unique
  ON experience_transactions(user_id, event_key) WHERE event_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS player_statistics (
  user_id              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  xp                   INTEGER NOT NULL DEFAULT 0,
  level                INTEGER NOT NULL DEFAULT 1,
  games_played         INTEGER NOT NULL DEFAULT 0,
  games_won            INTEGER NOT NULL DEFAULT 0,
  games_drawn          INTEGER NOT NULL DEFAULT 0,
  rounds_played        INTEGER NOT NULL DEFAULT 0,
  rounds_won           INTEGER NOT NULL DEFAULT 0,
  best_round_score     INTEGER NOT NULL DEFAULT 0,
  current_streak       INTEGER NOT NULL DEFAULT 0,
  longest_streak       INTEGER NOT NULL DEFAULT 0,
  last_played_date     TEXT,
  signals_received     INTEGER NOT NULL DEFAULT 0,
  signals_mutual       INTEGER NOT NULL DEFAULT 0,
  connections_count    INTEGER NOT NULL DEFAULT 0,
  chemistry_total      INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS game_ranks (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_key    TEXT    NOT NULL,
  rating      INTEGER NOT NULL DEFAULT 1000,
  wins        INTEGER NOT NULL DEFAULT 0,
  losses      INTEGER NOT NULL DEFAULT 0,
  draws       INTEGER NOT NULL DEFAULT 0,
  best_score  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, game_key)
);

CREATE TABLE IF NOT EXISTS challenges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scope        TEXT    NOT NULL DEFAULT 'daily',  -- daily | weekly
  game_key     TEXT,
  title        TEXT    NOT NULL,
  description  TEXT    NOT NULL,
  metric       TEXT    NOT NULL DEFAULT 'matches_played',
  target       INTEGER NOT NULL DEFAULT 1,
  xp_reward    INTEGER NOT NULL DEFAULT 25,
  active_date  TEXT,                              -- YYYY-MM-DD for daily
  active_week  TEXT,                              -- YYYY-Www for weekly
  enabled      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_challenges_date ON challenges(scope, active_date, active_week);

CREATE TABLE IF NOT EXISTS user_challenges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  progress     INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  claimed_at   TEXT,
  period_key   TEXT    NOT NULL DEFAULT '',
  UNIQUE (user_id, challenge_id, period_key)
);

CREATE TABLE IF NOT EXISTS daily_streaks (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current_days INTEGER NOT NULL DEFAULT 0,
  longest_days INTEGER NOT NULL DEFAULT 0,
  last_day     TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chemistry_scores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score       INTEGER NOT NULL DEFAULT 0,
  components  TEXT    NOT NULL DEFAULT '{}',  -- JSON breakdown for transparency
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (user_a_id < user_b_id),
  UNIQUE (user_a_id, user_b_id)
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT    NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  details       TEXT    NOT NULL DEFAULT '{}',
  ip_hash       TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON admin_audit_log(actor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS analytics_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event      TEXT    NOT NULL,
  game_key   TEXT,
  value      REAL,
  metadata   TEXT    NOT NULL DEFAULT '{}',  -- aggregated, no private message content
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_analytics_event ON analytics_events(event, created_at DESC);

CREATE TABLE IF NOT EXISTS rate_limit_hits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket     TEXT    NOT NULL,
  subject    TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rate_limit ON rate_limit_hits(bucket, subject, created_at DESC);

CREATE TABLE IF NOT EXISTS blind_vibe_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id    TEXT    NOT NULL UNIQUE,
  user_a_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage        INTEGER NOT NULL DEFAULT 1,
  status       TEXT    NOT NULL DEFAULT 'active', -- active | revealed | ended | expired
  a_interested INTEGER,                            -- NULL = undecided, never disclosed unilaterally
  b_interested INTEGER,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT    NOT NULL,
  CHECK (user_a_id < user_b_id)
);
CREATE INDEX IF NOT EXISTS idx_blind_user_a ON blind_vibe_sessions(user_a_id, status);
CREATE INDEX IF NOT EXISTS idx_blind_user_b ON blind_vibe_sessions(user_b_id, status);
