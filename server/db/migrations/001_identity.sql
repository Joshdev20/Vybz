-- VYBZ migration 001: identity, profiles, preferences, interests
-- All tables are additive; migrations never drop existing user data.

CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  username          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  email             TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash     TEXT    NOT NULL,
  password_salt     TEXT    NOT NULL,
  role              TEXT    NOT NULL DEFAULT 'user',      -- user | moderator | admin
  status            TEXT    NOT NULL DEFAULT 'active',    -- active | suspended | banned | deactivated
  age_confirmed_at  TEXT,                                 -- 18+ confirmation timestamp
  age_eligible      INTEGER NOT NULL DEFAULT 0,           -- derived eligibility result only
  email_verified_at TEXT,
  onboarding_step   TEXT    NOT NULL DEFAULT 'welcome',
  onboarded_at      TEXT,
  suspended_until   TEXT,
  status_reason     TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name     TEXT,
  bio              TEXT,
  avatar_kind      TEXT    NOT NULL DEFAULT 'preset',  -- preset | upload
  avatar_value     TEXT,                               -- preset key or media id
  gender           TEXT,
  interested_in    TEXT,
  region           TEXT,                               -- coarse region only; never precise
  show_region      INTEGER NOT NULL DEFAULT 0,
  languages        TEXT    NOT NULL DEFAULT '["en"]',  -- JSON array
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id                    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  discoverable               INTEGER NOT NULL DEFAULT 1,
  show_online_status         INTEGER NOT NULL DEFAULT 1,
  allow_messages_from        TEXT    NOT NULL DEFAULT 'connections', -- connections | everyone
  allow_anonymous_signals    INTEGER NOT NULL DEFAULT 1,
  allow_anonymous_custom     INTEGER NOT NULL DEFAULT 1,
  allow_ai_judge             INTEGER NOT NULL DEFAULT 1,
  notify_matches             INTEGER NOT NULL DEFAULT 1,
  notify_messages            INTEGER NOT NULL DEFAULT 1,
  notify_signals             INTEGER NOT NULL DEFAULT 1,
  notify_rooms               INTEGER NOT NULL DEFAULT 1,
  notify_challenges          INTEGER NOT NULL DEFAULT 1,
  hide_private_notifications INTEGER NOT NULL DEFAULT 1,
  preferred_games            TEXT    NOT NULL DEFAULT '[]', -- JSON array of game keys
  theme                      TEXT    NOT NULL DEFAULT 'violet',
  reduced_motion             INTEGER NOT NULL DEFAULT 0,
  updated_at                 TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS interests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT    NOT NULL UNIQUE,
  label      TEXT    NOT NULL,
  category   TEXT    NOT NULL DEFAULT 'general',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_interests (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interest_id INTEGER NOT NULL REFERENCES interests(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, interest_id)
);
CREATE INDEX IF NOT EXISTS idx_user_interests_interest ON user_interests(interest_id);

CREATE TABLE IF NOT EXISTS user_sessions (
  id            TEXT    PRIMARY KEY,          -- sha256 hash of the raw session token
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent    TEXT,
  ip_hash       TEXT,                          -- hashed, never raw
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT    NOT NULL,
  last_used_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);

CREATE TABLE IF NOT EXISTS media (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  mime_type   TEXT NOT NULL,
  byte_size   INTEGER NOT NULL,
  data        BLOB,
  object_key  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
