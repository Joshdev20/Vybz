import { q, transaction } from '../db/index.js';
import { logger } from './logger.js';

/**
 * Real-time event bus. Handlers are registered by the WebSocket layer so the
 * rest of the server can push events without importing ws directly.
 */
const listeners = new Set();

export function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitToUser(userId, event, payload) {
  for (const fn of listeners) {
    try {
      fn({ userId: Number(userId), event, payload });
    } catch (err) {
      logger.error('event listener failed', { event, error: err.message });
    }
  }
}

export function emitToUsers(userIds, event, payload) {
  for (const id of userIds) emitToUser(id, event, payload);
}

/**
 * Persist a notification and push it over the live bus. Notifications always
 * correspond to real server-side events - never synthetic engagement bait.
 */
export function notify(
  userId,
  { kind, title, body, link, isPrivate = false, data = {} },
  { dedupe = true } = {},
) {
  const prefKey = {
    match_found: 'notify_matches',
    challenge: 'notify_challenges',
    room_invite: 'notify_rooms',
    connection_accepted: 'notify_matches',
    signal: 'notify_signals',
    message: 'notify_messages',
    result: 'notify_matches',
  }[kind];
  const prefs = q.get('SELECT * FROM user_preferences WHERE user_id = ?', userId);
  if (prefKey && prefs && prefs[prefKey] === 0) return null;

  const dataJson = JSON.stringify(data);
  let id;
  try {
    if (dedupe) {
      const info = q.run(
        `INSERT OR IGNORE INTO notifications (user_id, kind, title, body, link, is_private, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        userId,
        kind,
        title,
        body || null,
        link || null,
        isPrivate ? 1 : 0,
        dataJson,
      );
      id = Number(info.lastInsertRowid);
      if (!id) return null; // duplicate suppressed
    } else {
      const info = q.run(
        `INSERT INTO notifications (user_id, kind, title, body, link, is_private, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        userId,
        kind,
        title,
        body || null,
        link || null,
        isPrivate ? 1 : 0,
        dataJson,
      );
      id = Number(info.lastInsertRowid);
    }
  } catch (err) {
    logger.error('notification insert failed', { kind, error: err.message });
    return null;
  }

  const row = q.get('SELECT * FROM notifications WHERE id = ?', id);
  // Lock-screen privacy: private notification bodies are withheld from the push.
  const payload = {
    ...row,
    body: isPrivate ? 'Open VYBZ to view' : row.body,
    data: safeParse(row.data),
  };
  emitToUser(userId, 'notification', payload);
  return payload;
}

export function unreadNotificationCount(userId) {
  return q.get(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL',
    userId,
  ).n;
}

export function markNotificationsRead(userId, ids) {
  return transaction((db) => {
    if (Array.isArray(ids) && ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const info = db
        .prepare(
          `UPDATE notifications SET read_at = datetime('now')
            WHERE user_id = ? AND read_at IS NULL AND id IN (${placeholders})`,
        )
        .run(userId, ...ids.map(Number));
      return info.changes;
    }
    const info = db
      .prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL")
      .run(userId);
    return info.changes;
  });
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
