import { q, transaction } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from './http.js';
import { assertNotRestricted, isBlockedEitherWay, blockedUserIds } from './safety.js';
import { notify } from './events.js';
import { logger } from './logger.js';

const QUEUE_TTL_MS = 120_000; // a waiting entry expires after 2 minutes

function parseJson(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

export function queueEntry(userId, gameKey) {
  return q.get(
    "SELECT * FROM matchmaking_queue WHERE user_id = ? AND game_key = ? AND status = 'waiting'",
    userId,
    gameKey,
  );
}

export function anyActiveQueue(userId) {
  return q.get(
    "SELECT * FROM matchmaking_queue WHERE user_id = ? AND status IN ('waiting','matched')",
    userId,
  );
}

/** Add the player to a queue. Idempotent: returns the existing entry if present. */
export function joinQueue(userId, gameKey, { format = 'classic', difficulty = 'standard', filters = {} } = {}) {
  assertNotRestricted(userId, 'join matchmaking');
  const mode = q.get('SELECT * FROM game_modes WHERE key = ? AND enabled = 1', gameKey);
  if (!mode) throw badRequest('That game mode is not available.');
  if (!mode.supports_queue) throw badRequest('That game mode does not use matchmaking.');

  const activeMatch = activeMatchForUser(userId);
  if (activeMatch) {
    throw conflict('You already have a match in progress.', { matchId: activeMatch.match_id, publicId: activeMatch.public_id });
  }

  const existing = queueEntry(userId, gameKey);
  if (existing) return { entry: existing, created: false };

  const expires = new Date(Date.now() + QUEUE_TTL_MS).toISOString();
  const info = q.run(
    `INSERT INTO matchmaking_queue (user_id, game_key, format, difficulty, filters, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    userId,
    gameKey,
    format,
    difficulty,
    JSON.stringify(filters || {}),
    expires,
  );
  return { entry: q.get('SELECT * FROM matchmaking_queue WHERE id = ?', Number(info.lastInsertRowid)), created: true };
}

export function leaveQueue(userId, gameKey) {
  const info = q.run(
    "UPDATE matchmaking_queue SET status = 'cancelled', updated_at = datetime('now') WHERE user_id = ? AND game_key = ? AND status = 'waiting'",
    userId,
    gameKey,
  );
  return { cancelled: info.changes > 0 };
}

export function cancelAllQueues(userId) {
  return q.run(
    "UPDATE matchmaking_queue SET status = 'cancelled', updated_at = datetime('now') WHERE user_id = ? AND status IN ('waiting','matched')",
    userId,
  ).changes;
}

export function activeMatchForUser(userId) {
  return q.get(
    `SELECT m.id AS match_id, m.public_id, m.game_key, m.status
       FROM matches m
       JOIN match_participants p ON p.match_id = m.id AND p.user_id = ?
      WHERE m.status IN ('pending','active')
      ORDER BY m.id DESC LIMIT 1`,
    userId,
  );
}

/**
 * Try to pair a waiting player. Pairs only users who have not blocked each
 * other, and never invents synthetic opponents - an empty queue stays empty.
 */
export function findOpponent(entry, { createMatch }) {
  const candidates = q.all(
    `SELECT * FROM matchmaking_queue
      WHERE game_key = ? AND status = 'waiting' AND user_id <> ?
        AND expires_at > datetime('now')
      ORDER BY created_at ASC
      LIMIT 25`,
    entry.game_key,
    entry.user_id,
  );

  const blocked = new Set(blockedUserIds(entry.user_id));
  for (const candidate of candidates) {
    if (blocked.has(candidate.user_id)) continue;
    if (isBlockedEitherWay(entry.user_id, candidate.user_id)) continue;

    // Only pair users who are not already busy.
    if (activeMatchForUser(candidate.user_id)) continue;

    const other = q.get('SELECT id, status FROM users WHERE id = ?', candidate.user_id);
    if (!other || other.status === 'banned') continue;

    const claimed = transaction((db) => {
      // Conditional update makes the claim atomic: only one process wins.
      const a = db
        .prepare("UPDATE matchmaking_queue SET status = 'matched', updated_at = datetime('now') WHERE id = ? AND status = 'waiting'")
        .run(entry.id);
      if (a.changes === 0) return false;
      const b = db
        .prepare("UPDATE matchmaking_queue SET status = 'matched', updated_at = datetime('now') WHERE id = ? AND status = 'waiting'")
        .run(candidate.id);
      if (b.changes === 0) {
        db.prepare("UPDATE matchmaking_queue SET status = 'waiting' WHERE id = ?").run(entry.id);
        return false;
      }
      return true;
    });
    if (!claimed) continue;

    const filters = { ...parseJson(entry.filters, {}), ...parseJson(candidate.filters, {}) };
    const match = createMatch({
      gameKey: entry.game_key,
      format: entry.format,
      difficulty: entry.difficulty,
      userIds: [entry.user_id, candidate.user_id],
      filters,
    });

    q.run('UPDATE matchmaking_queue SET match_id = ? WHERE id IN (?, ?)', match.id, entry.id, candidate.id);
    return match;
  }
  return null;
}

/** Expire stale waiting entries and cancel queues for disconnected players. */
export function cleanupQueue({ isOnline, onExpire } = {}) {
  const expired = q.all(
    "SELECT * FROM matchmaking_queue WHERE status = 'waiting' AND expires_at <= datetime('now')",
  );
  for (const entry of expired) {
    q.run("UPDATE matchmaking_queue SET status = 'expired', updated_at = datetime('now') WHERE id = ?", entry.id);
    if (onExpire) onExpire(entry);
  }
  if (isOnline) {
    const waiting = q.all("SELECT * FROM matchmaking_queue WHERE status = 'waiting'");
    for (const entry of waiting) {
      if (!isOnline(entry.user_id)) {
        q.run(
          "UPDATE matchmaking_queue SET status = 'expired', updated_at = datetime('now') WHERE id = ?",
          entry.id,
        );
        if (onExpire) onExpire(entry);
      }
    }
  }
  // Prune very old rows so the table does not grow without bound.
  q.run("DELETE FROM matchmaking_queue WHERE created_at < datetime('now', '-7 days')");
  return expired.length;
}

export function queueStats(gameKey) {
  const waiting = q.get(
    "SELECT COUNT(*) AS n FROM matchmaking_queue WHERE game_key = ? AND status = 'waiting' AND expires_at > datetime('now')",
    gameKey,
  ).n;
  return { gameKey, waiting };
}
