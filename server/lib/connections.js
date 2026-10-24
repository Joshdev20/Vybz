import { q, transaction } from '../db/index.js';
import { badRequest, forbidden, notFound, conflict } from './http.js';
import { notify } from './events.js';
import { assertCanInteract, hasBlocked } from './safety.js';
import { refreshChemistry, incrementStat } from './progression.js';
import { publicPresence } from './presence.js';
import { logger } from './logger.js';

export function orderedPair(a, b) {
  return Number(a) < Number(b) ? [Number(a), Number(b)] : [Number(b), Number(a)];
}

export function getConnection(a, b) {
  const [x, y] = orderedPair(a, b);
  return q.get('SELECT * FROM connections WHERE user_a_id = ? AND user_b_id = ?', x, y) || null;
}

export function areConnected(a, b) {
  return getConnection(a, b) !== null;
}

export function sendConnectionRequest(fromId, toId, { source = 'manual', contextId = null, message = '' } = {}) {
  assertCanInteract(fromId, toId, { context: 'connection' });
  if (areConnected(fromId, toId)) throw conflict('You are already connected.');
  const existing = q.get(
    "SELECT * FROM connection_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'",
    fromId,
    toId,
  );
  if (existing) return { id: existing.id, status: 'pending', duplicate: true };

  // If they already invited you, accepting is the natural action.
  const reverse = q.get(
    "SELECT * FROM connection_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'",
    toId,
    fromId,
  );
  if (reverse) return acceptConnectionRequest(toId, fromId, reverse.id);

  const info = q.run(
    `INSERT INTO connection_requests (from_user_id, to_user_id, source, context_id, message)
     VALUES (?, ?, ?, ?, ?)`,
    fromId,
    toId,
    source,
    contextId,
    String(message || '').slice(0, 300) || null,
  );
  const sender = q.get('SELECT username FROM users WHERE id = ?', fromId);
  notify(toId, {
    kind: 'connection_accepted',
    title: 'New connection request',
    body: `${sender.username} would like to connect.`,
    link: '/connections',
    isPrivate: true,
    data: { requestId: Number(info.lastInsertRowid), from: fromId },
  });
  return { id: Number(info.lastInsertRowid), status: 'pending' };
}

export function acceptConnectionRequest(viewerId, fromUserId, requestId) {
  assertCanInteract(viewerId, fromUserId, { context: 'connection' });
  const req = q.get(
    "SELECT * FROM connection_requests WHERE id = ? AND to_user_id = ? AND status = 'pending'",
    requestId,
    viewerId,
  );
  if (!req) throw notFound('That connection request is no longer pending.');

  const result = transaction((db) => {
    db.prepare("UPDATE connection_requests SET status = 'accepted', responded_at = datetime('now') WHERE id = ?").run(
      req.id,
    );
    const [x, y] = orderedPair(req.from_user_id, req.to_user_id);
    db.prepare(
      `INSERT INTO connections (user_a_id, user_b_id, kind) VALUES (?, ?, 'mutual')
       ON CONFLICT(user_a_id, user_b_id) DO NOTHING`,
    ).run(x, y);
    const conv = ensureConversation(db, x, y, 'direct');
    return { x, y, conversationId: conv };
  });

  incrementStat(viewerId, 'connections_count');
  incrementStat(fromUserId, 'connections_count');
  refreshChemistry(viewerId, fromUserId);

  const accepter = q.get('SELECT username FROM users WHERE id = ?', viewerId);
  notify(fromUserId, {
    kind: 'connection_accepted',
    title: 'Connection accepted',
    body: `${accepter.username} accepted your request. You can chat now.`,
    link: `/inbox?c=${result.conversationId}`,
    isPrivate: true,
    data: { userId: viewerId, conversationId: result.conversationId },
  });
  logger.info('connection created', { a: result.x, b: result.y });
  return { status: 'accepted', conversationId: result.conversationId };
}

export function declineConnectionRequest(viewerId, requestId) {
  const req = q.get(
    "SELECT * FROM connection_requests WHERE id = ? AND to_user_id = ? AND status = 'pending'",
    requestId,
    viewerId,
  );
  if (!req) throw notFound('That connection request is no longer pending.');
  q.run(
    "UPDATE connection_requests SET status = 'declined', responded_at = datetime('now') WHERE id = ?",
    req.id,
  );
  // Declining is never disclosed to the sender as a rejection notification.
  return { status: 'declined' };
}

export function cancelConnectionRequest(viewerId, requestId) {
  const req = q.get(
    "SELECT * FROM connection_requests WHERE id = ? AND from_user_id = ? AND status = 'pending'",
    requestId,
    viewerId,
  );
  if (!req) throw notFound('That request is no longer pending.');
  q.run(
    "UPDATE connection_requests SET status = 'cancelled', responded_at = datetime('now') WHERE id = ?",
    req.id,
  );
  return { status: 'cancelled' };
}

/** Remove a connection (unmatch). History is preserved for moderation. */
export function removeConnection(viewerId, otherId) {
  const [x, y] = orderedPair(viewerId, otherId);
  const existing = q.get('SELECT * FROM connections WHERE user_a_id = ? AND user_b_id = ?', x, y);
  if (!existing) throw notFound('You are not connected with that account.');
  transaction((db) => {
    db.prepare('DELETE FROM connections WHERE id = ?').run(existing.id);
    db.prepare(
      `UPDATE conversation_participants SET joined_at = joined_at
        WHERE user_id IN (?, ?)`,
    ).run(x, y);
    db.prepare('UPDATE chemistry_scores SET score = 0 WHERE user_a_id = ? AND user_b_id = ?').run(x, y);
    db.prepare(
      `UPDATE connection_requests SET status = 'cancelled'
        WHERE status = 'pending'
          AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))`,
    ).run(viewerId, otherId, otherId, viewerId);
  });
  return { ok: true };
}

export function listConnections(userId) {
  const rows = q.all(
    `SELECT c.*,
            CASE WHEN c.user_a_id = ? THEN c.user_b_id ELSE c.user_a_id END AS other_id
       FROM connections c
      WHERE c.user_a_id = ? OR c.user_b_id = ?
      ORDER BY c.updated_at DESC`,
    userId,
    userId,
    userId,
  );
  return rows
    .filter((r) => !hasBlocked(userId, r.other_id))
    .map((r) => {
      const profile = q.get(
        `SELECT u.id AS user_id, u.username, u.last_seen_at, p.display_name, p.avatar_kind,
                p.avatar_value, p.bio,
                (SELECT COUNT(*) FROM user_interests WHERE user_id = u.id) AS interest_count
           FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.id = ?`,
        r.other_id,
      );
      const chem = q.get(
        'SELECT score FROM chemistry_scores WHERE user_a_id = MIN(?, ?) AND user_b_id = MAX(?, ?)',
        userId,
        r.other_id,
        userId,
        r.other_id,
      );
      return {
        connectionId: r.id,
        kind: r.kind,
        chemistry: chem?.score || 0,
        connectedAt: r.created_at,
        user: {
          userId: profile?.user_id ?? r.other_id,
          username: profile?.username,
          displayName: profile?.display_name,
          avatarKind: profile?.avatar_kind,
          avatarValue: profile?.avatar_value,
          bio: profile?.bio,
          interestCount: profile?.interest_count || 0,
          presence: publicPresence(r.other_id),
        },
      };
    });
}

export function listPendingRequests(userId) {
  const incoming = q.all(
    `SELECT cr.*, u.username, p.display_name, p.avatar_kind, p.avatar_value
       FROM connection_requests cr
       JOIN users u ON u.id = cr.from_user_id
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE cr.to_user_id = ? AND cr.status = 'pending'
      ORDER BY cr.created_at DESC`,
    userId,
  ).filter((r) => !hasBlocked(userId, r.from_user_id));

  const outgoing = q.all(
    `SELECT cr.*, u.username, p.display_name, p.avatar_kind, p.avatar_value
       FROM connection_requests cr
       JOIN users u ON u.id = cr.to_user_id
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE cr.from_user_id = ? AND cr.status = 'pending'
      ORDER BY cr.created_at DESC`,
    userId,
  ).filter((r) => !hasBlocked(userId, r.to_user_id));

  return {
    incoming: incoming.map((r) => ({
      id: r.id,
      message: r.message,
      createdAt: r.created_at,
      source: r.source,
      user: {
        userId: r.from_user_id,
        username: r.username,
        displayName: r.display_name,
        avatarKind: r.avatar_kind,
        avatarValue: r.avatar_value,
      },
    })),
    outgoing: outgoing.map((r) => ({
      id: r.id,
      message: r.message,
      createdAt: r.created_at,
      source: r.source,
      user: {
        userId: r.to_user_id,
        username: r.username,
        displayName: r.display_name,
        avatarKind: r.avatar_kind,
        avatarValue: r.avatar_value,
      },
    })),
  };
}

/** Find or create the direct conversation between exactly two people. */
export function ensureConversation(db, userA, userB, kind = 'direct') {
  const [x, y] = orderedPair(userA, userB);
  const existing = db
    .prepare(
      `SELECT c.id FROM conversations c
        JOIN conversation_participants p1 ON p1.conversation_id = c.id AND p1.user_id = ?
        JOIN conversation_participants p2 ON p2.conversation_id = c.id AND p2.user_id = ?
       WHERE c.kind = 'direct'
         AND (SELECT COUNT(*) FROM conversation_participants WHERE conversation_id = c.id) = 2
       LIMIT 1`,
    )
    .get(x, y);
  if (existing) return existing.id;
  const info = db.prepare('INSERT INTO conversations (kind) VALUES (?)').run(kind);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)').run(id, x);
  db.prepare('INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)').run(id, y);
  return id;
}

export function conversationBetween(a, b) {
  const [x, y] = orderedPair(a, b);
  return q.get(
    `SELECT c.id FROM conversations c
      JOIN conversation_participants p1 ON p1.conversation_id = c.id AND p1.user_id = ?
      JOIN conversation_participants p2 ON p2.conversation_id = c.id AND p2.user_id = ?
     WHERE (SELECT COUNT(*) FROM conversation_participants WHERE conversation_id = c.id) = 2
     LIMIT 1`,
    x,
    y,
  );
}

export function assertCanMessage(senderId, recipientId) {
  assertCanInteract(senderId, recipientId, { context: 'message' });
  const connected = areConnected(senderId, recipientId);
  const pref = q.get('SELECT allow_messages_from FROM user_preferences WHERE user_id = ?', recipientId);
  const allowFrom = pref?.allow_messages_from || 'connections';
  if (allowFrom === 'connections' && !connected) {
    throw forbidden('You can only message people you are connected with.');
  }
  return true;
}

export function unreadCount(userId) {
  return q.get(
    `SELECT COUNT(*) AS n FROM messages m
       JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.user_id = ?
      WHERE m.sender_user_id <> ?
        AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)
        AND m.moderation_status <> 'rejected'`,
    userId,
    userId,
  ).n;
}
