import { SESSION_COOKIE, resolveSession, publicUser } from './lib/auth.js';
import { unauthorized, forbidden, parseCookies } from './lib/http.js';
import { q } from './db/index.js';
import { config } from './config.js';

/** Attach req.user when a valid session cookie is present. */
export function attachUser(req, _res, next) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[SESSION_COOKIE];
  req.sessionToken = token || null;
  const row = resolveSession(token);
  req.user = row || null;
  next();
}

/** Reject unauthenticated requests. */
export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

/** Reject requests from suspended or banned accounts. */
export function requireActive(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.status === 'banned') return next(forbidden('This account has been permanently suspended.'));
  if (req.user.status === 'suspended') {
    if (!req.user.suspended_until || new Date(req.user.suspended_until) > new Date()) {
      return next(forbidden('This account is temporarily restricted.'));
    }
    q.run("UPDATE users SET status = 'active', suspended_until = NULL WHERE id = ?", req.user.id);
    req.user.status = 'active';
  }
  next();
}

/**
 * Role gate. Roles are read from the server-side user record only - a
 * client-supplied role value is never trusted.
 */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden('Administrator access required.'));
    next();
  };
}

/** Reject cross-origin state-changing requests (CSRF hardening). */
export function sameOriginGuard(req, _res, next) {
  const method = req.method.toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next();
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return next(); // non-browser clients (tests, curl) have no Origin
  try {
    const host = new URL(origin).host;
    const expected = new URL(config.publicUrl).host;
    const reqHost = req.headers.host;
    if (host !== expected && host !== reqHost) {
      return next(forbidden('Cross-origin request rejected.'));
    }
  } catch {
    return next(forbidden('Invalid origin header.'));
  }
  next();
}

export function currentUserPayload(req) {
  if (!req.user) return null;
  return publicUser(req.user);
}
