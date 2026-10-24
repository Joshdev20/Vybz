import { q, transaction } from '../db/index.js';
import { badRequest, forbidden, notFound } from './http.js';
import { assertCanMessage, conversationBetween, areConnected, unreadCount } from './connections.js';
import { hasBlocked, screenText } from './safety.js';
import { publicPresence } from './presence.js';
import { emitToUser } from './events.js';
import { enforce } from './rateLimit.js';
import { logger } from './logger.js';

/** Confirm the viewer is a participant of the conversation. */
export function participantOf(conversationId, userId) {
  return q.get(
    'SELECT * FROM conversation_participants WHERE conversation_id = ? AND user_id = ?',
    conversationId,
    userId,
  );
}

export function assertParticipant(conversationId, userId) {
  const part = participantOf(conversationId, userId);
  if (!part) throw forbidden('You are not part of this conversation.');
  return part;
}

export function listConversations(userId) {
  const rows = q.all(
    `SELECT c.id, c.kind, c.last_message_at, c.created_at, cp.muted, cp.last_read_at
       FROM conversations c
       JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = ?
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
      LIMIT 100`,
    userId,
  );

  return rows
    .map((c) => {
      const others = q.all(
        `SELECT u.id, u.username, p.display_name, p.avatar_kind, p.avatar_value
           FROM conversation_participants cp
           JOIN users u ON u.id = cp.user_id
           LEFT JOIN user_profiles p ON p.user_id = u.id
          WHERE cp.conversation_id = ? AND cp.user_id <> ?`,
        c.id,
        userId,
      );
      // Blocked counterparts disappear from the inbox entirely.
      const visibleOthers = others.filter((o) => !hasBlocked(userId, o.id) && !hasBlocked(o.id, userId));
      if (!visibleOthers.length && others.length) return null;

      const last = q.get(
        `SELECT id, sender_user_id, body, created_at, status FROM messages
          WHERE conversation_id = ? AND moderation_status <> 'rejected'
          ORDER BY created_at DESC LIMIT 1`,
        c.id,
      );
      const count = q.get(
        `SELECT COUNT(*) AS n FROM messages m
           JOIN conversation_participants cp
             ON cp.conversation_id = m.conversation_id AND cp.user_id = ?
          WHERE m.conversation_id = ?
            AND m.sender_user_id <> ?
            AND m.moderation_status <> 'rejected'
            AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)`,
        userId,
        c.id,
        userId,
      ).n;

      const participants = visibleOthers.map((o) => ({
        userId: o.id,
        username: o.username,
        displayName: o.display_name,
        avatarKind: o.avatar_kind,
        avatarValue: o.avatar_value,
        presence: publicPresence(o.id),
      }));

      return {
        id: c.id,
        kind: c.kind,
        muted: Boolean(c.muted),
        createdAt: c.created_at,
        lastMessageAt: c.last_message_at,
        participants,
        // `other` is the direct-conversation counterpart, kept for simple clients.
        other: participants[0] || null,
        lastMessage: last
          ? { body: last.body.slice(0, 140), mine: last.sender_user_id === userId, at: last.created_at }
          : null,
        unread: count,
      };
    })
    .filter(Boolean);
}

export function getMessages(userId, conversationId, { before = null, limit = 50 } = {}) {
  assertParticipant(conversationId, userId);
  const capped = Math.min(100, Math.max(1, Number(limit) || 50));
  const params = [conversationId];
  let sql = `SELECT m.id, m.sender_user_id, m.body, m.created_at, m.status
               FROM messages m
              WHERE m.conversation_id = ? AND m.moderation_status <> 'rejected'`;
  if (before) {
    sql += ' AND m.id < ?';
    params.push(Number(before));
  }
  sql += ' ORDER BY m.id DESC LIMIT ?';
  params.push(capped);
  const rows = q.all(sql, ...params).reverse();

  const parts = q.all(
    `SELECT u.id, u.username, p.display_name, p.avatar_kind, p.avatar_value
       FROM conversation_participants cp JOIN users u ON u.id = cp.user_id
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE cp.conversation_id = ?`,
    conversationId,
  );

  const participants = parts.map((p) => ({
    userId: p.id,
    username: p.username,
    displayName: p.display_name,
    avatarKind: p.avatar_kind,
    avatarValue: p.avatar_value,
  }));

  return {
    conversationId,
    conversation: { id: conversationId, other: participants.find((p) => p.userId !== userId) || null },
    participants,
    messages: rows.map((m) => ({
      id: m.id,
      mine: m.sender_user_id === userId,
      senderId: m.sender_user_id,
      body: m.body,
      status: m.status,
      at: m.created_at,
    })),
    hasMore: rows.length === capped,
  };
}

export function sendMessage(userId, conversationId, body, { recipientHint = null } = {}) {
  assertParticipant(conversationId, userId);
  enforce('message_send', userId, 60, 60 * 1000);

  const text = String(body || '').trim();
  if (!text) throw badRequest('Type a message first.');
  if (text.length > 2000) throw badRequest('Keep messages under 2000 characters.');

  const others = q
    .all('SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id <> ?', conversationId, userId)
    .map((r) => r.user_id);
  if (!others.length) throw badRequest('This conversation has no other participant.');

  for (const otherId of others) {
    // Every send re-checks consent: blocks and connection rules always win.
    assertCanMessage(userId, otherId);
  }

  const verdict = screenText(text);
  if (!verdict.allowed) throw badRequest(verdict.reason || 'That message is not allowed.');

  const info = transaction((db) => {
    const res = db
      .prepare('INSERT INTO messages (conversation_id, sender_user_id, body, moderation_status) VALUES (?, ?, ?, ?)')
      .run(conversationId, userId, text, verdict.status);
    db.prepare("UPDATE conversations SET last_message_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(
      conversationId,
    );
    db.prepare(
      "UPDATE conversation_participants SET last_read_at = datetime('now') WHERE conversation_id = ? AND user_id = ?",
    ).run(conversationId, userId);
    return Number(res.lastInsertRowid);
  });

  const message = {
    id: info,
    mine: false,
    senderId: userId,
    body: text,
    status: 'sent',
    at: new Date().toISOString(),
  };
  for (const otherId of others) {
    const muted = q.get(
      'SELECT muted FROM conversation_participants WHERE conversation_id = ? AND user_id = ?',
      conversationId,
      otherId,
    );
    emitToUser(otherId, 'message', { conversationId, message: { ...message, mine: false } });
    if (!muted?.muted) {
      emitToUser(otherId, 'unread', { conversationId, total: unreadCount(otherId) });
    }
  }
  return { message: { ...message, mine: true } };
}

export function markRead(userId, conversationId) {
  assertParticipant(conversationId, userId);
  q.run(
    "UPDATE conversation_participants SET last_read_at = datetime('now') WHERE conversation_id = ? AND user_id = ?",
    conversationId,
    userId,
  );
  emitToUser(userId, 'unread', { conversationId, total: unreadCount(userId) });
  return { ok: true, total: unreadCount(userId) };
}

export function setMuted(userId, conversationId, muted) {
  assertParticipant(conversationId, userId);
  q.run(
    'UPDATE conversation_participants SET muted = ? WHERE conversation_id = ? AND user_id = ?',
    muted ? 1 : 0,
    conversationId,
    userId,
  );
  return { ok: true, muted: Boolean(muted) };
}

export function typing(userId, conversationId) {
  assertParticipant(conversationId, userId);
  const others = q.all(
    'SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id <> ?',
    conversationId,
    userId,
  );
  for (const o of others) emitToUser(o.user_id, 'typing', { conversationId, userId });
  return { ok: true };
}

/** Open (or create) the direct conversation with a permitted recipient. */
export function openConversation(userId, recipientId) {
  assertCanMessage(userId, recipientId);
  const existing = conversationBetween(userId, recipientId);
  if (existing) return { conversationId: existing.id, created: false };
  const id = transaction((db) => {
    const res = db.prepare("INSERT INTO conversations (kind) VALUES ('direct')").run();
    const cid = Number(res.lastInsertRowid);
    db.prepare('INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)').run(cid, userId);
    db.prepare('INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?)').run(cid, recipientId);
    return cid;
  });
  logger.info('conversation opened', { id, userId, recipientId });
  return { conversationId: id, created: true };
}

export function conversationSummary(userId) {
  return { unread: unreadCount(userId), conversations: listConversations(userId) };
}
