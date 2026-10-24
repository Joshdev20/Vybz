import { q, transaction } from '../db/index.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword, newSessionToken, hashToken, hashIp } from './crypto.js';
import { badRequest, unauthorized, conflict } from './http.js';
export const SESSION_COOKIE = 'vybz_session';
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_AGE = 18;

export function validateUsername(raw) {
  const username = String(raw || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw badRequest('Username must be 3-20 characters: letters, numbers or underscores only.');
  }
  return username;
}

export function validateEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw badRequest('Enter a valid email address.');
  return email;
}

export function validatePassword(raw) {
  const password = String(raw || '');
  if (password.length < 8) throw badRequest('Password must be at least 8 characters.');
  if (password.length > 200) throw badRequest('Password is too long.');
  return password;
}

export function isReservedUsername(username) {
  return q.get('SELECT 1 AS x FROM users WHERE username = ?', username) !== null;
}

export function createUser({ username, email, password, ageConfirmed, ip, userAgent }) {
  if (!ageConfirmed) {
    throw badRequest('You must confirm you are 18 or older to create a VYBZ account.');
  }
  const uname = validateUsername(username);
  const mail = validateEmail(email);
  const pass = validatePassword(password);

  if (q.get('SELECT 1 AS x FROM users WHERE username = ?', uname)) {
    throw conflict('That username is already taken.');
  }
  if (q.get('SELECT 1 AS x FROM users WHERE email = ?', mail)) {
    throw conflict('An account with that email already exists.');
  }

  const { hash, salt } = hashPassword(pass);
  const isFirstUser = q.get('SELECT COUNT(*) AS n FROM users').n === 0;
  const role = isFirstUser || uname === config.bootstrapAdminUsername ? 'admin' : 'user';

  const userId = transaction((db) => {
    const info = db
      .prepare(
        `INSERT INTO users (username, email, password_hash, password_salt, role, age_confirmed_at, age_eligible)
         VALUES (?, ?, ?, ?, ?, datetime('now'), 1)`,
      )
      .run(uname, mail, hash, salt, role);
    const id = Number(info.lastInsertRowid);
    db.prepare('INSERT INTO user_profiles (user_id, display_name, avatar_value) VALUES (?, ?, ?)').run(
      id,
      uname,
      'preset-1',
    );
    db.prepare('INSERT INTO user_preferences (user_id) VALUES (?)').run(id);
    db.prepare('INSERT INTO player_statistics (user_id) VALUES (?)').run(id);
    db.prepare('INSERT INTO daily_streaks (user_id) VALUES (?)').run(id);
    return id;
  });

  return { id: userId, username: uname, email: mail, role, ageEligible: true };
}

export function authenticate({ identifier, password, ip, userAgent }) {
  const ident = String(identifier || '').trim().toLowerCase();
  if (!ident || !password) throw badRequest('Enter your username/email and password.');
  const user = q.get('SELECT * FROM users WHERE username = ? OR email = ?', ident, ident);
  // Always run a hash comparison to keep timing consistent for unknown users.
  const salt = user ? user.password_salt : 'unknown-salt';
  const expected = user ? user.password_hash : '00'.repeat(64);
  const ok = verifyPassword(String(password), salt, expected);
  if (!user || !ok) throw unauthorized('Incorrect username or password.');

  if (user.status === 'banned') throw unauthorized('This account has been permanently suspended.');
  if (user.status === 'suspended') {
    if (!user.suspended_until || new Date(user.suspended_until) > new Date()) {
      throw unauthorized('This account is temporarily suspended.');
    }
    q.run("UPDATE users SET status = 'active', suspended_until = NULL WHERE id = ?", user.id);
  }
  if (user.status === 'deactivated') throw unauthorized('This account has been deactivated.');

  const session = createSession(user.id, { ip, userAgent });
  return { user, session };
}

export function createSession(userId, { ip, userAgent } = {}) {
  const token = newSessionToken();
  const id = hashToken(token);
  const expires = new Date(Date.now() + config.sessionDays * 86400_000).toISOString();
  q.run(
    'INSERT INTO user_sessions (id, user_id, user_agent, ip_hash, expires_at) VALUES (?, ?, ?, ?, ?)',
    id,
    userId,
    String(userAgent || '').slice(0, 200),
    hashIp(ip),
    expires,
  );
  q.run("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?", userId);
  return { token, expiresAt: expires };
}

export function resolveSession(token) {
  if (!token) return null;
  const id = hashToken(token);
  const row = q.get(
    `SELECT s.id AS session_id, s.expires_at, s.revoked_at, u.*
       FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
    id,
  );
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  if (row.status === 'banned' || row.status === 'deactivated') return null;
  q.run("UPDATE user_sessions SET last_used_at = datetime('now') WHERE id = ?", id);
  return row;
}

export function revokeSession(token) {
  if (!token) return;
  q.run("UPDATE user_sessions SET revoked_at = datetime('now') WHERE id = ?", hashToken(token));
}

export function revokeAllSessions(userId, exceptToken) {
  if (exceptToken) {
    q.run(
      "UPDATE user_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND id <> ? AND revoked_at IS NULL",
      userId,
      hashToken(exceptToken),
    );
  } else {
    q.run(
      "UPDATE user_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
      userId,
    );
  }
}

/** Strip credential fields before a user record leaves the server. */
export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    ageEligible: Boolean(user.age_eligible),
    onboarded: Boolean(user.onboarded_at),
    onboardingStep: user.onboarding_step,
    createdAt: user.created_at,
  };
}
