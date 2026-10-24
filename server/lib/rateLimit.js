import { q, transaction } from '../db/index.js';
import { config } from '../config.js';

/**
 * Sliding-window rate limiter backed by the database so limits survive
 * restarts and are shared across processes.
 */
export function rateLimit({ bucket, subject, limit, windowMs }) {
  const win = windowMs || config.rateLimitWindowMs;
  return transaction((db) => {
    const since = new Date(Date.now() - win).toISOString();
    const row = db
      .prepare(
        'SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket = ? AND subject = ? AND created_at >= ?',
      )
      .get(bucket, String(subject), since);
    if (row.n >= limit) {
      return { allowed: false, remaining: 0, retryAfterMs: win };
    }
    db.prepare('INSERT INTO rate_limit_hits (bucket, subject) VALUES (?, ?)').run(
      bucket,
      String(subject),
    );
    return { allowed: true, remaining: Math.max(0, limit - row.n - 1), retryAfterMs: 0 };
  });
}

/** Opportunistic cleanup of old limiter rows (called on a timer). */
export function pruneRateLimits(maxAgeMs = 24 * 60 * 60 * 1000) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  q.run('DELETE FROM rate_limit_hits WHERE created_at < ?', cutoff);
}

/**
 * Enforce a named limit per subject, throwing a typed error the HTTP layer
 * converts into a 429.
 */
export function enforce(bucketName, subject, limit, windowMs) {
  const res = rateLimit({ bucket: bucketName, subject, limit, windowMs });
  if (!res.allowed) {
    const err = new Error('Too many requests. Please slow down and try again shortly.');
    err.status = 429;
    err.code = 'rate_limited';
    throw err;
  }
  return res;
}
