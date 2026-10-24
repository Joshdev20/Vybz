-- VYBZ migration 006: allow a connection to be requested again.
--
-- 003 declared UNIQUE (from_user_id, to_user_id, status). Responded rows are
-- kept as history, so once a pair had an 'accepted' request they could never
-- request again: re-requesting after an unmatch or connection removal collided
-- with the retained 'accepted' row and surfaced as an unhandled 500.
-- Only *pending* requests need to be unique, so that becomes a partial index.
--
-- SQLite cannot drop a table-level UNIQUE constraint, so the table is rebuilt
-- with its rows copied across. No other table references connection_requests,
-- so dropping it cannot cascade.

CREATE TABLE IF NOT EXISTS connection_requests_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source       TEXT    NOT NULL DEFAULT 'manual',  -- manual | signal | blind_vibe | game
  context_id   TEXT,
  status       TEXT    NOT NULL DEFAULT 'pending', -- pending | accepted | declined | cancelled | expired
  message      TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT
);

INSERT INTO connection_requests_new
  (id, from_user_id, to_user_id, source, context_id, status, message, created_at, responded_at)
SELECT
   id, from_user_id, to_user_id, source, context_id, status, message, created_at, responded_at
  FROM connection_requests;

DROP TABLE connection_requests;

ALTER TABLE connection_requests_new RENAME TO connection_requests;

-- At most one live request per direction; history rows are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conn_req_unique_pending
  ON connection_requests(from_user_id, to_user_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_conn_req_to ON connection_requests(to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_conn_req_from ON connection_requests(from_user_id, status);
