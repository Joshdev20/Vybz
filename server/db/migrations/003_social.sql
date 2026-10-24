-- VYBZ migration 003: rooms, connections, anonymous signals, messaging

CREATE TABLE IF NOT EXISTS rooms (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,          -- join code
  host_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_key      TEXT    NOT NULL DEFAULT 'spill_it',
  name          TEXT    NOT NULL,
  visibility    TEXT    NOT NULL DEFAULT 'private', -- public | private | invite
  max_players   INTEGER NOT NULL DEFAULT 6,
  categories    TEXT    NOT NULL DEFAULT '[]',     -- JSON array of category keys
  boundaries    TEXT    NOT NULL DEFAULT '{}',     -- JSON: allow_images, allow_bold, etc.
  status        TEXT    NOT NULL DEFAULT 'lobby',  -- lobby | active | paused | ended
  current_round INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_rooms_visibility ON rooms(visibility, status);

CREATE TABLE IF NOT EXISTS room_members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id     INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT    NOT NULL DEFAULT 'player',  -- host | player
  ready       INTEGER NOT NULL DEFAULT 0,
  score       INTEGER NOT NULL DEFAULT 0,
  joined_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  left_at     TEXT,
  last_seen_at TEXT,
  UNIQUE (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);

CREATE TABLE IF NOT EXISTS room_rounds (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id       INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  round_number  INTEGER NOT NULL,
  prompt_text   TEXT    NOT NULL,
  category      TEXT,
  active_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  phase         TEXT    NOT NULL DEFAULT 'answering', -- answering | revealed | skipped
  answer        TEXT,
  round_seconds INTEGER NOT NULL DEFAULT 60,
  started_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  deadline      TEXT,
  completed_at  TEXT,
  UNIQUE (room_id, round_number)
);

CREATE TABLE IF NOT EXISTS connection_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source       TEXT    NOT NULL DEFAULT 'manual',  -- manual | signal | blind_vibe | game
  context_id   TEXT,
  status       TEXT    NOT NULL DEFAULT 'pending', -- pending | accepted | declined | cancelled | expired
  message      TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT,
  UNIQUE (from_user_id, to_user_id, status)
);
CREATE INDEX IF NOT EXISTS idx_conn_req_to ON connection_requests(to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_conn_req_from ON connection_requests(from_user_id, status);

CREATE TABLE IF NOT EXISTS connections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL DEFAULT 'mutual',  -- mutual | friend
  chemistry    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (user_a_id < user_b_id),
  UNIQUE (user_a_id, user_b_id)
);
CREATE INDEX IF NOT EXISTS idx_connections_a ON connections(user_a_id);
CREATE INDEX IF NOT EXISTS idx_connections_b ON connections(user_b_id);

CREATE TABLE IF NOT EXISTS anonymous_signals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL DEFAULT 'compliment', -- compliment | interest | custom
  template_key   TEXT,
  body           TEXT,                                   -- moderated custom text
  moderation_status TEXT NOT NULL DEFAULT 'approved',    -- approved | pending | rejected
  status         TEXT    NOT NULL DEFAULT 'delivered',   -- delivered | reacted | dismissed | mutual | blocked | reported
  mutual_signal_id INTEGER REFERENCES anonymous_signals(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signals_recipient ON anonymous_signals(recipient_user_id, status);
-- Rate limiting / duplicate protection: one signal per sender->recipient per day per kind.
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_daily_unique
  ON anonymous_signals(sender_user_id, recipient_user_id, kind, date(created_at));

CREATE TABLE IF NOT EXISTS conversations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT    NOT NULL DEFAULT 'direct',  -- direct | match
  match_id     INTEGER REFERENCES matches(id) ON DELETE SET NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversations_recent ON conversations(last_message_at DESC);

CREATE TABLE IF NOT EXISTS conversation_participants (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted           INTEGER NOT NULL DEFAULT 0,
  last_read_at    TEXT,
  joined_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_part_user ON conversation_participants(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'sent', -- sent | delivered | read | removed
  moderation_status TEXT  NOT NULL DEFAULT 'approved',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS blocks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);

CREATE TABLE IF NOT EXISTS reports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_type    TEXT    NOT NULL,        -- user | message | submission | room | signal
  target_id      INTEGER,
  reason         TEXT    NOT NULL,
  details        TEXT,
  severity       TEXT    NOT NULL DEFAULT 'normal', -- low | normal | high | critical
  status         TEXT    NOT NULL DEFAULT 'open',   -- open | reviewing | actioned | dismissed | escalated
  assigned_to    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolution     TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_subject ON reports(subject_user_id);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id     INTEGER REFERENCES reports(id) ON DELETE SET NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT    NOT NULL,      -- warn | restrict | suspend | ban | dismiss | content_remove
  reason        TEXT,
  expires_at    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mod_actions_target ON moderation_actions(target_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL,   -- match_found | room_invite | connection_accepted | signal | message | result | challenge
  title       TEXT    NOT NULL,
  body        TEXT,
  link        TEXT,
  is_private  INTEGER NOT NULL DEFAULT 0,   -- hidden on lock screens when set
  data        TEXT    NOT NULL DEFAULT '{}',
  read_at     TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, kind, data)              -- coarse idempotency guard
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at DESC);
