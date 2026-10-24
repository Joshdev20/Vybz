import { q, transaction } from '../db/index.js';
import { HttpError, badRequest, forbidden } from './http.js';
import { notify } from './events.js';
import { logger } from './logger.js';

/* ------------------------------- blocks ------------------------------- */

export function blockUser(blockerId, blockedId) {
  if (Number(blockerId) === Number(blockedId)) throw badRequest('You cannot block yourself.');
  const target = q.get('SELECT id, username FROM users WHERE id = ?', blockedId);
  if (!target) throw badRequest('That account does not exist.');

  transaction((db) => {
    db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(blockerId, blockedId);
    // Blocking tears down every live interaction between the two accounts.
    db.prepare(
      `UPDATE connection_requests SET status = 'cancelled', responded_at = datetime('now')
        WHERE status = 'pending'
          AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))`,
    ).run(blockerId, blockedId, blockedId, blockerId);
    db.prepare(
      `DELETE FROM connections
        WHERE (user_a_id = MIN(?, ?) AND user_b_id = MAX(?, ?))`,
    ).run(blockerId, blockedId, blockerId, blockedId);
    db.prepare(
      `UPDATE anonymous_signals SET status = 'blocked'
        WHERE status IN ('delivered','reacted')
          AND ((sender_user_id = ? AND recipient_user_id = ?) OR (sender_user_id = ? AND recipient_user_id = ?))`,
    ).run(blockerId, blockedId, blockedId, blockerId);
    db.prepare(
      `UPDATE matchmaking_queue SET status = 'cancelled'
        WHERE user_id = ? AND status = 'waiting'`,
    ).run(blockedId);
    db.prepare(
      `UPDATE chemistry_scores SET score = 0 WHERE user_a_id = MIN(?, ?) AND user_b_id = MAX(?, ?)`,
    ).run(blockerId, blockedId, blockerId, blockedId);
  });
  logger.info('user blocked', { blockerId, blockedId });
  return { ok: true };
}

export function unblockUser(blockerId, blockedId) {
  q.run('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', blockerId, blockedId);
  return { ok: true };
}

export function isBlockedEitherWay(a, b) {
  if (!a || !b) return false;
  return (
    q.get('SELECT 1 AS x FROM blocks WHERE blocker_id = ? AND blocked_id = ?', a, b) !== null ||
    q.get('SELECT 1 AS x FROM blocks WHERE blocker_id = ? AND blocked_id = ?', b, a) !== null
  );
}

export function hasBlocked(blockerId, blockedId) {
  return q.get('SELECT 1 AS x FROM blocks WHERE blocker_id = ? AND blocked_id = ?', blockerId, blockedId) !== null;
}

export function blockedUserIds(userId) {
  const rows = q.all(
    'SELECT blocked_id AS id FROM blocks WHERE blocker_id = ? UNION SELECT blocker_id AS id FROM blocks WHERE blocked_id = ?',
    userId,
    userId,
  );
  return rows.map((r) => r.id);
}

/* ------------------------------ reporting ------------------------------ */

const REPORT_REASONS = new Set([
  'harassment',
  'hate_speech',
  'threats',
  'spam',
  'impersonation',
  'underage',
  'non_consensual_content',
  'privacy_violation',
  'inappropriate_content',
  'other',
]);

const SEVERITY = {
  threats: 'critical',
  non_consensual_content: 'critical',
  underage: 'critical',
  harassment: 'high',
  hate_speech: 'high',
  privacy_violation: 'high',
  impersonation: 'normal',
  spam: 'low',
  inappropriate_content: 'normal',
  other: 'low',
};

export function createReport({
  reporterId,
  subjectUserId = null,
  targetType,
  targetId = null,
  reason,
  details = '',
}) {
  if (!REPORT_REASONS.has(reason)) throw badRequest('Select a valid report reason.');
  if (!['user', 'message', 'submission', 'room', 'signal'].includes(targetType)) {
    throw badRequest('Unsupported report target.');
  }
  const subject =
    subjectUserId ||
    inferSubject({ targetType, targetId });
  if (!subject) throw badRequest('Could not identify the account being reported.');
  if (Number(subject) === Number(reporterId)) throw badRequest('You cannot report yourself.');

  const severity = SEVERITY[reason] || 'normal';
  const info = q.run(
    `INSERT INTO reports (reporter_id, subject_user_id, target_type, target_id, reason, details, severity)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    reporterId,
    subject,
    targetType,
    targetId,
    reason,
    String(details || '').slice(0, 2000),
    severity,
  );
  const reportId = Number(info.lastInsertRowid);

  // Repeat-offender signal: counts open/actioned reports against this account.
  const priorCount = q.get(
    `SELECT COUNT(*) AS n FROM reports
      WHERE subject_user_id = ? AND status IN ('open','reviewing','actioned')`,
    subject,
  ).n;

  if (severity === 'critical') {
    logger.warn('critical report filed', { reportId, reason, subject });
  }
  if (priorCount >= 5) {
    applyModerationAction({
      targetUserId: subject,
      action: 'restrict',
      reason: `Automatic restriction after ${priorCount} reports pending review.`,
      reportId,
      actorUserId: null,
      expiresInDays: 3,
    });
  }
  return { id: reportId, severity, status: 'open' };
}

function inferSubject({ targetType, targetId }) {
  if (!targetId) return null;
  if (targetType === 'message') {
    return q.get('SELECT sender_user_id AS uid FROM messages WHERE id = ?', targetId)?.uid;
  }
  if (targetType === 'submission') {
    return q.get('SELECT user_id AS uid FROM round_submissions WHERE id = ?', targetId)?.uid;
  }
  if (targetType === 'room') {
    return q.get('SELECT host_user_id AS uid FROM rooms WHERE id = ?', targetId)?.uid;
  }
  if (targetType === 'signal') {
    return q.get('SELECT sender_user_id AS uid FROM anonymous_signals WHERE id = ?', targetId)?.uid;
  }
  if (targetType === 'user') return targetId;
  return null;
}

/* --------------------------- moderation actions --------------------------- */

export function applyModerationAction({
  targetUserId,
  action,
  reason,
  reportId = null,
  actorUserId = null,
  expiresInDays = null,
}) {
  const valid = new Set(['warn', 'restrict', 'suspend', 'ban', 'dismiss', 'content_remove']);
  if (!valid.has(action)) throw badRequest('Unsupported moderation action.');
  const target = q.get('SELECT * FROM users WHERE id = ?', targetUserId);
  if (!target) throw badRequest('Target account not found.');

  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86400_000).toISOString()
    : null;

  transaction((db) => {
    db.prepare(
      `INSERT INTO moderation_actions (report_id, actor_user_id, target_user_id, action, reason, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(reportId, actorUserId, targetUserId, action, reason || null, expiresAt);

    if (action === 'ban') {
      db.prepare("UPDATE users SET status = 'banned', status_reason = ?, updated_at = datetime('now') WHERE id = ?").run(
        reason || 'Community guidelines violation.',
        targetUserId,
      );
      db.prepare("UPDATE user_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL").run(
        targetUserId,
      );
    } else if (action === 'suspend') {
      db.prepare(
        "UPDATE users SET status = 'suspended', suspended_until = ?, status_reason = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(expiresAt, reason || 'Temporary suspension.', targetUserId);
      db.prepare("UPDATE user_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL").run(
        targetUserId,
      );
    } else if (action === 'restrict') {
      db.prepare(
        "UPDATE users SET status = 'suspended', suspended_until = ?, status_reason = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(expiresAt || new Date(Date.now() + 86400_000).toISOString(), reason || 'Restricted pending review.', targetUserId);
      db.prepare(
        "UPDATE matchmaking_queue SET status = 'cancelled' WHERE user_id = ? AND status = 'waiting'",
      ).run(targetUserId);
    } else if (action === 'content_remove' && reportId) {
      db.prepare("UPDATE reports SET status = 'actioned', updated_at = datetime('now') WHERE id = ?").run(reportId);
    }
  });

  if (action !== 'dismiss' && action !== 'content_remove') {
    notify(targetUserId, {
      kind: 'result',
      title: 'Account notice',
      body: reason || 'A moderation action was applied to your account.',
      link: '/profile',
      isPrivate: true,
      data: { moderation: action },
    });
  }
  return { ok: true, action, expiresAt };
}

/** Automatic abuse detection on user-generated text. */
const HARD_BLOCK_PATTERNS = [
  /\b(kill|murder|shoot|stab)\s+(you|u|him|her|them)\b/i,
  /\bi\s+will\s+find\s+you\b/i,
  /\b(dox|doxx)\b/i,
  /\b(send|show)\s+(me\s+)?(nudes?|your\s+body)\b/i,
  /\bunder\s?age\b|\bi\s+am\s+1[0-7]\b/i,
];
const CONTACT_PATTERNS = [
  /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/,
  /\b(?:\+?\d[\s-]?){9,}\b/,
  // Platform names must match as whole words: a prefix match would reject
  // ordinary sentences ("I was thinking", "water", "watching").
  /\b(?:whatsapp|snapchat|telegram|instagram|wa\.me)\b/i,
  // Short forms are only meaningful when followed by a handle separator,
  // so "snapshot" and "instantly" are left alone.
  /\b(?:snap|insta|wa|tg)\b\s*[:@/]/i,
];

/**
 * Screen user-generated text. Returns a decision plus flags; anonymous
 * channels get stricter treatment to protect sender anonymity.
 */
export function screenText(text, { channel = 'general' } = {}) {
  const value = String(text || '');
  const flags = [];
  if (HARD_BLOCK_PATTERNS.some((re) => re.test(value))) flags.push('prohibited_content');
  const hasContact = CONTACT_PATTERNS.some((re) => re.test(value));
  if (hasContact) flags.push('contact_details');
  const linkCount = (value.match(/https?:\/\//gi) || []).length;
  if (linkCount > 1) flags.push('link_spam');
  const capsRatio = value.length > 12 ? (value.replace(/[^A-Z]/g, '').length / value.length) : 0;
  if (capsRatio > 0.7) flags.push('shouting');
  if (/(.)\1{9,}/.test(value)) flags.push('repeated_chars');

  if (flags.includes('prohibited_content')) {
    return { allowed: false, flags, status: 'rejected', reason: 'This content breaks our community rules.' };
  }
  // Anonymous channels must not leak contact details.
  if (channel === 'anonymous' && hasContact) {
    return {
      allowed: false,
      flags,
      status: 'rejected',
      reason: 'Anonymous signals cannot include contact details or links.',
    };
  }
  if (flags.length) return { allowed: true, flags, status: 'pending', reason: null };
  return { allowed: true, flags: [], status: 'approved', reason: null };
}

/* ------------------------------- guards ------------------------------- */

/** Central authorization gate used before any interactive pairing. */
export function assertCanInteract(viewerId, targetId, { context = 'interaction' } = {}) {
  if (Number(viewerId) === Number(targetId)) throw badRequest('You cannot do that with yourself.');
  const target = q.get('SELECT id, status FROM users WHERE id = ?', targetId);
  if (!target) throw new HttpError(404, 'That account no longer exists.', 'not_found');
  if (target.status === 'banned') throw forbidden('That account is not available.');
  if (hasBlocked(targetId, viewerId)) throw forbidden('You cannot interact with this account.');
  if (hasBlocked(viewerId, targetId)) throw forbidden('You have blocked this account. Unblock to interact.');
  const viewer = q.get('SELECT status FROM users WHERE id = ?', viewerId);
  if (viewer?.status === 'banned') throw forbidden('Your account cannot perform this action.');
  if (context === 'anonymous') {
    const pref = q.get('SELECT allow_anonymous_signals FROM user_preferences WHERE user_id = ?', targetId);
    if (pref && pref.allow_anonymous_signals === 0) {
      throw forbidden('This person is not accepting anonymous signals right now.');
    }
  }
  return true;
}

export function assertNotRestricted(userId, action = 'do that') {
  const user = q.get('SELECT status, suspended_until, status_reason FROM users WHERE id = ?', userId);
  if (!user) throw forbidden('Account not found.');
  if (user.status === 'banned') throw forbidden('Your account has been permanently suspended.');
  if (user.status === 'suspended') {
    if (!user.suspended_until || new Date(user.suspended_until) > new Date()) {
      throw forbidden(`Your account is temporarily restricted and cannot ${action}.`);
    }
    q.run("UPDATE users SET status = 'active', suspended_until = NULL WHERE id = ?", userId);
  }
}

export const REPORT_REASON_LIST = [...REPORT_REASONS];
