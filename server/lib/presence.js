import { q } from '../db/index.js';

/**
 * In-memory presence registry. Presence is inherently ephemeral, so it lives
 * in the process rather than the database; stale entries expire automatically.
 */
const connections = new Map(); // userId -> Set<socket>
const PRESENCE_TTL_MS = 60_000;

export function addConnection(userId, socket) {
  if (!connections.has(userId)) connections.set(userId, new Set());
  connections.get(userId).add(socket);
  q.run("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?", userId);
}

export function removeConnection(userId, socket) {
  const set = connections.get(userId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) connections.delete(userId);
}

export function isOnline(userId) {
  return connections.has(Number(userId));
}

export function onlineUserIds() {
  return [...connections.keys()];
}

export function socketsFor(userId) {
  return [...(connections.get(Number(userId)) || [])];
}

export function connectionCount(userId) {
  return connections.get(Number(userId))?.size || 0;
}

/** Presence is only ever disclosed when the user allows it. */
export function publicPresence(userId) {
  const pref = q.get('SELECT show_online_status FROM user_preferences WHERE user_id = ?', userId);
  if (!pref || !pref.show_online_status) return 'hidden';
  return isOnline(userId) ? 'online' : 'offline';
}

export const PRESENCE_TTL = PRESENCE_TTL_MS;
