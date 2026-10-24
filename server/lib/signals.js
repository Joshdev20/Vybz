import { q, transaction } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from './http.js';
import { assertCanInteract, assertNotRestricted, screenText, blockedUserIds, hasBlocked } from './safety.js';
import { notify } from './events.js';
import { awardXp, incrementStat, refreshChemistry, XP_RULES } from './progression.js';
import { acceptConnectionRequest, getConnection, ensureConversation } from './connections.js';
import { enforce } from './rateLimit.js';
import { logger } from './logger.js';

/**
 * Secret Signal - consent-based anonymous interest.
 *
 * Privacy guarantees enforced here:
 *  - the sender identity is never included in any recipient-facing payload
 *  - signals to people who blocked you, or who disabled signals, are rejected
 *  - a one-sided "yes" is never disclosed to the other person
 */

export function signalTemplates(kind) {
  const rows = kind
    ? q.all('SELECT key, kind, body FROM signal_templates WHERE enabled = 1 AND kind = ?', kind)
    : q.all('SELECT key, kind, body FROM signal_templates WHERE enabled = 1');
  return rows;
}

export function sendSignal(senderId, recipientId, { templateKey = null, body = null, kind = 'compliment' } = {}) {
  assertNotRestricted(senderId, 'send signals');
  assertCanInteract(senderId, recipientId, { context: 'anonymous' });
  enforce('signal_send', senderId, 20, 60 * 60 * 1000); // 20 signals/hour

  if (getConnection(senderId, recipientId)) {
    throw conflict('You are already connected with this person. Send them a message instead.');
  }

  const prefs = q.get('SELECT * FROM user_preferences WHERE user_id = ?', recipientId);
  if (!prefs || prefs.allow_anonymous_signals === 0) {
    throw forbidden('This person is not accepting anonymous signals right now.');
  }

  let text = null;
  let resolvedKind = kind;
  let moderationStatus = 'approved';

  if (body) {
    if (!prefs.allow_anonymous_custom) {
      throw forbidden('This person only accepts curated compliments.');
    }
    const verdict = screenText(body, { channel: 'anonymous' });
    if (!verdict.allowed) throw badRequest(verdict.reason || 'That message is not allowed.');
    text = String(body).trim().slice(0, 300);
    moderationStatus = verdict.status;
    resolvedKind = 'custom';
  } else {
    if (!templateKey) throw badRequest('Choose a compliment to send.');
    const tpl = q.get('SELECT * FROM signal_templates WHERE key = ? AND enabled = 1', templateKey);
    if (!tpl) throw badRequest('That compliment is no longer available.');
    text = tpl.body;
    resolvedKind = tpl.kind;
    q.run('UPDATE signal_templates SET usage_count = usage_count + 1 WHERE id = ?', tpl.id);
  }

  // Rate limit / duplicate guard: the unique index enforces one per pair per kind per day.
  try {
    const info = q.run(
      `INSERT INTO anonymous_signals (sender_user_id, recipient_user_id, kind, template_key, body, moderation_status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      senderId,
      recipientId,
      resolvedKind,
      templateKey,
      text,
      moderationStatus,
    );
    const signalId = Number(info.lastInsertRowid);
    awardXp(senderId, XP_RULES.signal_sent, 'signal_sent', `signal:${signalId}:sent`);
    // The recipient is told a signal arrived, never who sent it.
    notify(recipientId, {
      kind: 'signal',
      title: 'You received a Secret Signal',
      body: 'Someone sent you an anonymous compliment.',
      link: '/signals',
      isPrivate: true,
      data: { signalId },
    });
    return { id: signalId, status: 'delivered' };
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw conflict('You have already sent this person a signal today.');
    }
    throw err;
  }
}

/** Recipient-facing inbox. Sender identity is deliberately absent. */
export function listSignals(userId) {
  const rows = q.all(
    `SELECT id, kind, body, moderation_status, status, created_at
       FROM anonymous_signals
      WHERE recipient_user_id = ? AND status IN ('delivered','reacted')
      ORDER BY created_at DESC LIMIT 50`,
    userId,
  );
  const sent = q.all(
    `SELECT id, kind, status, created_at FROM anonymous_signals
      WHERE sender_user_id = ? ORDER BY created_at DESC LIMIT 50`,
    userId,
  );
  return {
    received: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      body: r.body,
      status: r.status,
      createdAt: r.created_at,
      // Explicitly no sender field exists in this payload.
      sender: null,
    })),
    sent: sent.map((s) => ({ id: s.id, kind: s.kind, status: s.status, createdAt: s.created_at })),
  };
}

export function reactToSignal(userId, signalId, { action }) {
  const signal = q.get(
    "SELECT * FROM anonymous_signals WHERE id = ? AND recipient_user_id = ? AND status IN ('delivered','reacted')",
    signalId,
    userId,
  );
  if (!signal) throw notFound('That signal is no longer available.');

  if (action === 'dismiss') {
    q.run(
      "UPDATE anonymous_signals SET status = 'dismissed', updated_at = datetime('now') WHERE id = ?",
      signalId,
    );
    // Dismissing closes the channel: the sender cannot keep contacting you here.
    return { status: 'dismissed' };
  }

  if (action === 'block') {
    q.run(
      "UPDATE anonymous_signals SET status = 'blocked', updated_at = datetime('now') WHERE id = ?",
      signalId,
    );
    return { status: 'blocked', senderId: signal.sender_user_id };
  }

  if (action === 'report') {
    q.run(
      "UPDATE anonymous_signals SET status = 'reported', updated_at = datetime('now') WHERE id = ?",
      signalId,
    );
    return { status: 'reported', senderId: signal.sender_user_id };
  }

  if (action === 'react') {
    q.run("UPDATE anonymous_signals SET status = 'reacted', updated_at = datetime('now') WHERE id = ?", signalId);
    return { status: 'reacted' };
  }

  if (action === 'mutual') {
    // Expressing interest back. Identity is revealed only at this consent point.
    if (hasBlocked(userId, signal.sender_user_id) || hasBlocked(signal.sender_user_id, userId)) {
      throw forbidden('This interaction is no longer available.');
    }
    const result = transaction((db) => {
      db.prepare(
        "UPDATE anonymous_signals SET status = 'mutual', updated_at = datetime('now') WHERE id = ?",
      ).run(signalId);
      // Look for a reciprocal signal from the sender side to pair them.
      const reciprocal = db
        .prepare(
          `SELECT * FROM anonymous_signals
            WHERE sender_user_id = ? AND recipient_user_id = ? AND id <> ?
              AND status IN ('delivered','reacted','mutual')
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(userId, signal.sender_user_id, signalId);
      if (reciprocal) {
        db.prepare(
          "UPDATE anonymous_signals SET status = 'mutual', mutual_signal_id = ?, updated_at = datetime('now') WHERE id = ?",
        ).run(signalId, reciprocal.id);
        db.prepare(
          "UPDATE anonymous_signals SET status = 'mutual', mutual_signal_id = ?, updated_at = datetime('now') WHERE id = ?",
        ).run(reciprocal.id, signalId);
      }
      return { reciprocal: Boolean(reciprocal) };
    });

    incrementStat(userId, 'signals_mutual');
    incrementStat(signal.sender_user_id, 'signals_mutual');
    awardXp(userId, XP_RULES.signal_mutual, 'signal_mutual', `signal:${signalId}:${userId}:mutual`);

    if (result.reciprocal) {
      // Both sides opted in, so a connection request is safe to create.
      const existing = getConnection(userId, signal.sender_user_id);
      if (!existing) {
        const pending = q.get(
          "SELECT * FROM connection_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'",
          signal.sender_user_id,
          userId,
        );
        if (pending) {
          // An existing invitation is honoured rather than duplicated.
          acceptConnectionRequest(userId, signal.sender_user_id, pending.id);
        } else {
          const [x, y] =
            userId < signal.sender_user_id
              ? [userId, signal.sender_user_id]
              : [signal.sender_user_id, userId];
          transaction((db) => {
            db.prepare(
              `INSERT INTO connection_requests (from_user_id, to_user_id, source, context_id, status, responded_at)
               VALUES (?, ?, 'signal', ?, 'accepted', datetime('now'))`,
            ).run(signal.sender_user_id, userId, String(signalId));
            db.prepare(
              `INSERT INTO connections (user_a_id, user_b_id, kind) VALUES (?, ?, 'mutual')
               ON CONFLICT(user_a_id, user_b_id) DO NOTHING`,
            ).run(x, y);
            ensureConversation(db, x, y, 'direct');
          });
          incrementStat(userId, 'connections_count');
          incrementStat(signal.sender_user_id, 'connections_count');
          notify(signal.sender_user_id, {
            kind: 'connection_accepted',
            title: 'A Secret Signal went both ways',
            body: 'You both showed interest. You can chat now.',
            link: '/connections',
            isPrivate: true,
            data: { userId },
          });
        }
      }
      refreshChemistry(userId, signal.sender_user_id);
      return { status: 'mutual', connected: true, reveal: signal.sender_user_id };
    }

    // One-sided interest stays private. The other person is never told.
    return { status: 'mutual', connected: false, reveal: signal.sender_user_id };
  }

  throw badRequest('Unsupported signal action.');
}

export function signalQuota(userId) {
  const used = q.get(
    "SELECT COUNT(*) AS n FROM anonymous_signals WHERE sender_user_id = ? AND created_at >= datetime('now','-1 day')",
    userId,
  ).n;
  return { used, limit: 20, remaining: Math.max(0, 20 - used) };
}

export function eligibleSignalTargets(userId, limit = 20) {
  const blocked = blockedUserIds(userId);
  const placeholders = blocked.length ? blocked.map(() => '?').join(',') : 'NULL';
  const rows = q.all(
    `SELECT u.id, u.username, p.display_name, p.avatar_kind, p.avatar_value
       FROM users u
       JOIN user_profiles p ON p.user_id = u.id
       JOIN user_preferences pref ON pref.user_id = u.id
      WHERE u.id <> ?
        AND u.status = 'active'
        AND u.onboarded_at IS NOT NULL
        AND pref.allow_anonymous_signals = 1
        AND pref.discoverable = 1
        AND u.id NOT IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1 FROM connections c
           WHERE (c.user_a_id = MIN(u.id, ?) AND c.user_b_id = MAX(u.id, ?))
        )
      ORDER BY RANDOM() LIMIT ?`,
    userId,
    ...blocked,
    userId,
    userId,
    limit,
  );
  return rows;
}
