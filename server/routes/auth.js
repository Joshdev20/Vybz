import { Router } from 'express';
import {
  createUser,
  authenticate,
  revokeSession,
  revokeAllSessions,
  publicUser,
  SESSION_COOKIE,
  createSession,
} from '../lib/auth.js';
import { hashToken } from '../lib/crypto.js';
import { handler, setCookie, clearCookie, unauthorized, badRequest, forbidden } from '../lib/http.js';
import { requireAuth } from '../middleware.js';
import { q, transaction } from '../db/index.js';
import { enforce } from '../lib/rateLimit.js';
import { hashIp } from '../lib/crypto.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { clientIp } from '../lib/http.js';
import { publicPreferences } from '../lib/preferences.js';

const router = Router();

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'Lax',
  secure: config.isProduction,
  maxAge: config.sessionDays * 86400,
});

function issueSession(res, session) {
  setCookie(res, SESSION_COOKIE, session.token, cookieOptions());
}

router.post(
  '/register',
  handler(async (req, res) => {
    enforce('register', hashIp(clientIp(req)), 10, 60 * 60 * 1000);
    const { username, email, password, ageConfirmed } = req.body || {};
    const user = createUser({
      username,
      email,
      password,
      ageConfirmed: ageConfirmed === true || ageConfirmed === 'true',
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
    });
    const session = createSession(user.id, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
    issueSession(res, session);
    logger.info('account created', { userId: user.id });
    res.status(201).json({ user: publicUser(q.get('SELECT * FROM users WHERE id = ?', user.id)), sessionExpiresAt: session.expiresAt });
  }),
);

router.post(
  '/login',
  handler(async (req, res) => {
    const { identifier, password } = req.body || {};
    enforce('login', hashIp(clientIp(req)), 20, 15 * 60 * 1000);
    const { user, session } = authenticate({
      identifier,
      password,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
    });
    issueSession(res, session);
    res.json({ user: publicUser(user), sessionExpiresAt: session.expiresAt });
  }),
);

router.post(
  '/logout',
  handler(async (req, res) => {
    revokeSession(req.sessionToken);
    clearCookie(res, SESSION_COOKIE, { httpOnly: true, sameSite: 'Lax', secure: config.isProduction });
    res.json({ ok: true });
  }),
);

router.get(
  '/me',
  handler(async (req, res) => {
    if (!req.user) return res.json({ user: null });
    const profile = q.get('SELECT * FROM user_profiles WHERE user_id = ?', req.user.id);
    const prefs = q.get('SELECT * FROM user_preferences WHERE user_id = ?', req.user.id);
    const stats = q.get('SELECT * FROM player_statistics WHERE user_id = ?', req.user.id);
    res.json({
      user: publicUser(req.user),
      profile,
      preferences: publicPreferences(prefs),
      statistics: stats,
    });
  }),
);

router.post(
  '/logout-all',
  requireAuth,
  handler(async (req, res) => {
    revokeAllSessions(req.user.id, null);
    clearCookie(res, SESSION_COOKIE, { httpOnly: true, sameSite: 'Lax', secure: config.isProduction });
    res.json({ ok: true });
  }),
);

router.get(
  '/sessions',
  requireAuth,
  handler(async (req, res) => {
    const rows = q.all(
      `SELECT id, user_agent, created_at, last_used_at, expires_at
         FROM user_sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
        ORDER BY last_used_at DESC`,
      req.user.id,
    );
    const current = req.sessionToken
      ? q.get('SELECT id FROM user_sessions WHERE id = ?', hashToken(req.sessionToken))
      : null;
    res.json({
      sessions: rows.map((r) => ({
        id: r.id.slice(0, 8),
        current: current ? r.id === current.id : false,
        userAgent: r.user_agent,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        expiresAt: r.expires_at,
      })),
    });
  }),
);

router.delete(
  '/account',
  requireAuth,
  handler(async (req, res) => {
    const { password, confirm } = req.body || {};
    if (confirm !== 'DELETE') throw badRequest('Type DELETE to confirm account deletion.');
    const { verifyPassword } = await import('../lib/crypto.js');
    const ok = verifyPassword(String(password || ''), req.user.password_salt, req.user.password_hash);
    if (!ok) throw forbidden('Password is incorrect.');

    // Retention policy: personal content is removed, moderation records are retained
    // (anonymised) because they are required for abuse handling.
    transaction((db) => {
      const uid = req.user.id;
      db.prepare('DELETE FROM messages WHERE sender_user_id = ?').run(uid);
      db.prepare('DELETE FROM anonymous_signals WHERE sender_user_id = ? OR recipient_user_id = ?').run(uid, uid);
      db.prepare('DELETE FROM round_submissions WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM media WHERE user_id = ?').run(uid);
      db.prepare('UPDATE users SET status = ?, status_reason = ? WHERE id = ?').run(
        'deactivated',
        'Account deleted at user request.',
        uid,
      );
      db.prepare(
        `UPDATE user_profiles SET display_name = NULL, bio = NULL, avatar_value = NULL, region = NULL WHERE user_id = ?`,
      ).run(uid);
      db.prepare("UPDATE users SET username = 'deleted_' || id, email = 'deleted_' || id || '@vybz.invalid' WHERE id = ?").run(uid);
      db.prepare('UPDATE user_sessions SET revoked_at = datetime(\'now\') WHERE user_id = ?').run(uid);
      db.prepare("UPDATE matchmaking_queue SET status = 'cancelled' WHERE user_id = ?").run(uid);
    });
    clearCookie(res, SESSION_COOKIE, { httpOnly: true, sameSite: 'Lax', secure: config.isProduction });
    logger.info('account deleted', { userId: req.user.id });
    res.json({ ok: true });
  }),
);

export default router;
