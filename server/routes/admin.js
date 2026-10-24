import { Router } from 'express';
import { q, transaction } from '../db/index.js';
import { handler, badRequest, notFound } from '../lib/http.js';
import { requireAuth, requireRole } from '../middleware.js';
import { applyModerationAction, screenText } from '../lib/safety.js';
import { hashIp } from '../lib/crypto.js';
import { clientIp } from '../lib/http.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * Every route below is gated by requireRole, which reads the role from the
 * server-side user record. Hiding the URL is never the control.
 */
router.use(requireAuth, requireRole('moderator', 'admin'));

/** Append-only audit trail for privileged actions. */
function audit(req, action, { targetType = null, targetId = null, details = {} } = {}) {
  q.run(
    'INSERT INTO admin_audit_log (actor_user_id, action, target_type, target_id, details, ip_hash) VALUES (?, ?, ?, ?, ?, ?)',
    req.user.id,
    action,
    targetType,
    targetId ? String(targetId) : null,
    JSON.stringify(details),
    hashIp(clientIp(req)),
  );
}

router.get(
  '/overview',
  handler(async (req, res) => {
    const counts = {
      users: q.get("SELECT COUNT(*) AS n FROM users WHERE status = 'active'").n,
      suspended: q.get("SELECT COUNT(*) AS n FROM users WHERE status = 'suspended'").n,
      banned: q.get("SELECT COUNT(*) AS n FROM users WHERE status = 'banned'").n,
      openReports: q.get("SELECT COUNT(*) AS n FROM reports WHERE status IN ('open','reviewing')").n,
      criticalReports: q.get("SELECT COUNT(*) AS n FROM reports WHERE severity = 'critical' AND status IN ('open','reviewing')").n,
      activeMatches: q.get("SELECT COUNT(*) AS n FROM matches WHERE status = 'active'").n,
      matchesToday: q.get("SELECT COUNT(*) AS n FROM matches WHERE created_at >= datetime('now','-1 day')").n,
      roomsActive: q.get("SELECT COUNT(*) AS n FROM rooms WHERE status IN ('lobby','active')").n,
      signalsToday: q.get("SELECT COUNT(*) AS n FROM anonymous_signals WHERE created_at >= datetime('now','-1 day')").n,
      messagesToday: q.get("SELECT COUNT(*) AS n FROM messages WHERE created_at >= datetime('now','-1 day')").n,
      queueWaiting: q.get("SELECT COUNT(*) AS n FROM matchmaking_queue WHERE status = 'waiting'").n,
    };
    res.json({ counts });
  }),
);

router.get(
  '/users',
  handler(async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
    const search = req.query.q ? `%${String(req.query.q).toLowerCase()}%` : null;
    const status = req.query.status ? String(req.query.status) : null;

    const params = [];
    let sql = `SELECT u.id, u.username, u.email, u.role, u.status, u.created_at, u.last_seen_at,
                      u.age_eligible, u.onboarded_at,
                      (SELECT COUNT(*) FROM reports r WHERE r.subject_user_id = u.id) AS report_count,
                      (SELECT COUNT(*) FROM moderation_actions ma WHERE ma.target_user_id = u.id) AS action_count
                 FROM users u WHERE 1 = 1`;
    if (search) {
      sql += ' AND (LOWER(u.username) LIKE ? OR LOWER(u.email) LIKE ?)';
      params.push(search, search);
    }
    if (status) {
      sql += ' AND u.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY u.id DESC LIMIT ?';
    params.push(limit);

    res.json({ users: q.all(sql, ...params) });
  }),
);

router.get(
  '/users/:id',
  handler(async (req, res) => {
    const userId = Number(req.params.id);
    const user = q.get('SELECT id, username, email, role, status, created_at, last_seen_at, status_reason FROM users WHERE id = ?', userId);
    if (!user) throw notFound('User not found.');
    const profile = q.get('SELECT display_name, bio, avatar_kind, avatar_value, region, show_region FROM user_profiles WHERE user_id = ?', userId);
    const stats = q.get('SELECT * FROM player_statistics WHERE user_id = ?', userId);
    const reports = q.all(
      `SELECT r.id, r.reason, r.severity, r.status, r.created_at, r.details, r.target_type, r.target_id
         FROM reports r WHERE r.subject_user_id = ? ORDER BY r.created_at DESC LIMIT 50`,
      userId,
    );
    const actions = q.all(
      `SELECT ma.id, ma.action, ma.reason, ma.created_at, ma.expires_at, a.username AS actor
         FROM moderation_actions ma LEFT JOIN users a ON a.id = ma.actor_user_id
        WHERE ma.target_user_id = ? ORDER BY ma.created_at DESC LIMIT 50`,
      userId,
    );
    const sessions = q.all(
      `SELECT user_agent, created_at, last_used_at, expires_at, revoked_at
         FROM user_sessions WHERE user_id = ? ORDER BY last_used_at DESC LIMIT 20`,
      userId,
    );
    audit(req, 'view_user', { targetType: 'user', targetId: userId });
    res.json({ user, profile, statistics: stats, reports, moderationActions: actions, sessions });
  }),
);

router.post(
  '/users/:id/action',
  handler(async (req, res) => {
    const userId = Number(req.params.id);
    const { action, reason, expiresInDays, reportId } = req.body || {};
    if (!action) throw badRequest('Specify a moderation action.');
    // Moderators cannot ban or change roles; that is admin-only.
    if (['ban'].includes(action) && req.user.role !== 'admin') {
      throw badRequest('Only administrators can permanently ban accounts.');
    }
    const result = applyModerationAction({
      targetUserId: userId,
      action,
      reason: reason || 'Moderation action.',
      reportId: reportId ? Number(reportId) : null,
      actorUserId: req.user.id,
      expiresInDays: expiresInDays ? Number(expiresInDays) : null,
    });
    audit(req, `moderation_${action}`, {
      targetType: 'user',
      targetId: userId,
      details: { reason, expiresInDays, reportId },
    });
    logger.warn('moderation action applied', { actor: req.user.id, target: userId, action });
    res.json(result);
  }),
);

router.post(
  '/users/:id/role',
  requireRole('admin'),
  handler(async (req, res) => {
    const userId = Number(req.params.id);
    const role = String(req.body?.role || '');
    if (!['user', 'moderator', 'admin'].includes(role)) throw badRequest('Invalid role.');
    if (userId === req.user.id) throw badRequest('You cannot change your own role.');
    q.run("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?", role, userId);
    audit(req, 'change_role', { targetType: 'user', targetId: userId, details: { role } });
    logger.warn('role changed', { actor: req.user.id, target: userId, role });
    res.json({ ok: true, role });
  }),
);

router.get(
  '/reports',
  handler(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    const severity = req.query.severity ? String(req.query.severity) : null;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const params = [];
    let sql = `SELECT r.*, u.username AS subject_username, rep.username AS reporter_username
                 FROM reports r
                 LEFT JOIN users u ON u.id = r.subject_user_id
                 LEFT JOIN users rep ON rep.id = r.reporter_id
                WHERE 1 = 1`;
    if (status) {
      sql += ' AND r.status = ?';
      params.push(status);
    }
    if (severity) {
      sql += ' AND r.severity = ?';
      params.push(severity);
    }
    sql += ` ORDER BY CASE r.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                      r.created_at DESC LIMIT ?`;
    params.push(limit);
    res.json({ reports: q.all(sql, ...params) });
  }),
);

router.post(
  '/reports/:id/resolve',
  handler(async (req, res) => {
    const reportId = Number(req.params.id);
    const { status, resolution, action, expiresInDays } = req.body || {};
    const report = q.get('SELECT * FROM reports WHERE id = ?', reportId);
    if (!report) throw notFound('Report not found.');
    const validStatus = ['reviewing', 'actioned', 'dismissed', 'escalated'];
    if (status && !validStatus.includes(status)) throw badRequest('Invalid report status.');

    transaction((db) => {
      db.prepare(
        "UPDATE reports SET status = ?, resolution = ?, assigned_to = COALESCE(assigned_to, ?), updated_at = datetime('now') WHERE id = ?",
      ).run(status || 'reviewing', resolution || null, req.user.id, reportId);
    });

    if (action && action !== 'none' && report.subject_user_id) {
      if (action === 'ban' && req.user.role !== 'admin') {
        throw badRequest('Only administrators can permanently ban accounts.');
      }
      applyModerationAction({
        targetUserId: report.subject_user_id,
        action,
        reason: resolution || `Resolved from report #${reportId}.`,
        reportId,
        actorUserId: req.user.id,
        expiresInDays: expiresInDays ? Number(expiresInDays) : null,
      });
    }
    audit(req, 'resolve_report', {
      targetType: 'report',
      targetId: reportId,
      details: { status, action },
    });
    res.json({ ok: true });
  }),
);

/** Inspect reported content. Access is logged and limited to moderators. */
router.get(
  '/reports/:id/content',
  handler(async (req, res) => {
    const report = q.get('SELECT * FROM reports WHERE id = ?', Number(req.params.id));
    if (!report) throw notFound('Report not found.');
    let content = null;
    if (report.target_type === 'message' && report.target_id) {
      content = q.get('SELECT id, body, created_at, sender_user_id FROM messages WHERE id = ?', report.target_id);
    } else if (report.target_type === 'submission' && report.target_id) {
      content = q.get(
        `SELECT s.id, s.body, s.submitted_at AS created_at, s.user_id AS sender_user_id, r.prompt_text
           FROM round_submissions s JOIN game_rounds r ON r.id = s.round_id WHERE s.id = ?`,
        report.target_id,
      );
    } else if (report.target_type === 'signal' && report.target_id) {
      content = q.get('SELECT id, body, kind, created_at FROM anonymous_signals WHERE id = ?', report.target_id);
    } else if (report.target_type === 'room' && report.target_id) {
      content = q.get('SELECT id, name, code, categories, created_at FROM rooms WHERE id = ?', report.target_id);
    }
    audit(req, 'view_reported_content', { targetType: 'report', targetId: Number(req.params.id) });
    res.json({ report, content });
  }),
);

router.get(
  '/matches',
  handler(async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const rows = q.all(
      `SELECT m.id, m.public_id, m.game_key, m.status, m.judged_by, m.total_rounds, m.current_round,
              m.created_at, m.ended_at, m.winner_user_id,
              (SELECT COUNT(*) FROM match_participants p WHERE p.match_id = m.id) AS players,
              (SELECT GROUP_CONCAT(u.username, ', ') FROM match_participants p JOIN users u ON u.id = p.user_id WHERE p.match_id = m.id) AS usernames
         FROM matches m ORDER BY m.id DESC LIMIT ?`,
      limit,
    );
    res.json({ matches: rows });
  }),
);

router.get(
  '/matches/:publicId',
  handler(async (req, res) => {
    const match = q.get('SELECT * FROM matches WHERE public_id = ?', String(req.params.publicId));
    if (!match) throw notFound('Match not found.');
    const participants = q.all(
      `SELECT p.*, u.username FROM match_participants p JOIN users u ON u.id = p.user_id WHERE p.match_id = ?`,
      match.id,
    );
    const rounds = q.all(
      `SELECT r.*,
              (SELECT COUNT(*) FROM round_submissions s WHERE s.round_id = r.id) AS submissions,
              (SELECT COUNT(*) FROM round_votes v WHERE v.round_id = r.id) AS votes
         FROM game_rounds r WHERE r.match_id = ? ORDER BY r.round_number`,
      match.id,
    );
    audit(req, 'view_match', { targetType: 'match', targetId: match.public_id });
    res.json({ match, participants, rounds });
  }),
);

router.get(
  '/rooms',
  handler(async (req, res) => {
    const rows = q.all(
      `SELECT r.*, u.username AS host_username,
              (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id AND m.left_at IS NULL) AS players
         FROM rooms r LEFT JOIN users u ON u.id = r.host_user_id
        ORDER BY r.id DESC LIMIT 60`,
    );
    res.json({ rooms: rows });
  }),
);

router.get(
  '/prompts',
  handler(async (req, res) => {
    const gameKey = req.query.game ? String(req.query.game) : null;
    const rows = gameKey
      ? q.all(
          `SELECT p.*, c.key AS category_key, c.label AS category_label
             FROM game_prompts p LEFT JOIN prompt_categories c ON c.id = p.category_id
            WHERE p.game_key = ? ORDER BY p.usage_count DESC LIMIT 300`,
          gameKey,
        )
      : q.all(
          `SELECT p.*, c.key AS category_key, c.label AS category_label
             FROM game_prompts p LEFT JOIN prompt_categories c ON c.id = p.category_id
            ORDER BY p.usage_count DESC LIMIT 300`,
        );
    res.json({ prompts: rows });
  }),
);

router.post(
  '/prompts',
  handler(async (req, res) => {
    const { gameKey, categoryKey, text, difficulty, roundSeconds } = req.body || {};
    if (!gameKey || !text) throw badRequest('A game mode and prompt text are required.');
    const verdict = screenText(text);
    if (!verdict.allowed) throw badRequest(verdict.reason || 'That prompt is not allowed.');
    const category = categoryKey
      ? q.get('SELECT id FROM prompt_categories WHERE game_key = ? AND key = ?', gameKey, categoryKey)
      : null;
    const info = q.run(
      `INSERT INTO game_prompts (game_key, category_id, text, difficulty, round_seconds)
       VALUES (?, ?, ?, ?, ?)`,
      gameKey,
      category?.id || null,
      String(text).slice(0, 400),
      ['easy', 'standard', 'spicy'].includes(difficulty) ? difficulty : 'standard',
      Number(roundSeconds) || 30,
    );
    audit(req, 'create_prompt', { targetType: 'prompt', targetId: Number(info.lastInsertRowid), details: { gameKey } });
    res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
  }),
);

router.patch(
  '/prompts/:id',
  handler(async (req, res) => {
    const id = Number(req.params.id);
    const prompt = q.get('SELECT * FROM game_prompts WHERE id = ?', id);
    if (!prompt) throw notFound('Prompt not found.');
    const { enabled, text, difficulty } = req.body || {};
    if (text !== undefined) {
      const verdict = screenText(text);
      if (!verdict.allowed) throw badRequest(verdict.reason || 'That prompt is not allowed.');
    }
    q.run(
      `UPDATE game_prompts SET
         enabled = COALESCE(?, enabled),
         text = COALESCE(?, text),
         difficulty = COALESCE(?, difficulty),
         updated_at = datetime('now')
       WHERE id = ?`,
      enabled === undefined ? null : enabled ? 1 : 0,
      text === undefined ? null : String(text).slice(0, 400),
      difficulty === undefined ? null : String(difficulty),
      id,
    );
    audit(req, 'update_prompt', { targetType: 'prompt', targetId: id, details: { enabled, difficulty } });
    res.json({ ok: true });
  }),
);

router.get(
  '/categories',
  handler(async (req, res) => {
    const rows = q.all('SELECT * FROM prompt_categories ORDER BY game_key, sort_order');
    res.json({ categories: rows });
  }),
);

router.patch(
  '/categories/:id',
  handler(async (req, res) => {
    const id = Number(req.params.id);
    const { enabled, intensity, label } = req.body || {};
    q.run(
      `UPDATE prompt_categories SET
         enabled = COALESCE(?, enabled),
         intensity = COALESCE(?, intensity),
         label = COALESCE(?, label)
       WHERE id = ?`,
      enabled === undefined ? null : enabled ? 1 : 0,
      intensity === undefined ? null : Math.max(1, Math.min(3, Number(intensity))),
      label === undefined ? null : String(label).slice(0, 60),
      id,
    );
    audit(req, 'update_category', { targetType: 'category', targetId: id, details: { enabled, intensity } });
    res.json({ ok: true });
  }),
);

router.get(
  '/game-modes',
  handler(async (req, res) => {
    res.json({ modes: q.all('SELECT * FROM game_modes ORDER BY sort_order') });
  }),
);

router.patch(
  '/game-modes/:key',
  handler(async (req, res) => {
    const key = String(req.params.key);
    const { enabled, totalRounds } = req.body || {};
    q.run(
      'UPDATE game_modes SET enabled = COALESCE(?, enabled) WHERE key = ?',
      enabled === undefined ? null : enabled ? 1 : 0,
      key,
    );
    audit(req, 'update_game_mode', { targetType: 'game_mode', targetId: key, details: { enabled, totalRounds } });
    res.json({ ok: true });
  }),
);

router.get(
  '/analytics',
  handler(async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const since = `-${days} days`;

    const dau = q.all(
      `SELECT date(created_at) AS day, COUNT(DISTINCT user_id) AS users
         FROM analytics_events WHERE created_at >= datetime('now', ?) GROUP BY day ORDER BY day`,
      since,
    );
    const matchesByDay = q.all(
      `SELECT date(created_at) AS day, COUNT(*) AS matches,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status = 'abandoned' THEN 1 ELSE 0 END) AS abandoned
         FROM matches WHERE created_at >= datetime('now', ?) GROUP BY day ORDER BY day`,
      since,
    );
    const modePopularity = q.all(
      `SELECT game_key, COUNT(*) AS matches FROM matches
        WHERE created_at >= datetime('now', ?) GROUP BY game_key ORDER BY matches DESC`,
      since,
    );
    const queueMetrics = q.all(
      `SELECT game_key,
              COUNT(*) AS queued,
              SUM(CASE WHEN status = 'matched' THEN 1 ELSE 0 END) AS matched,
              SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired,
              SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
         FROM matchmaking_queue WHERE created_at >= datetime('now', ?) GROUP BY game_key`,
      since,
    );
    const connectionMetrics = q.all(
      `SELECT date(created_at) AS day,
              COUNT(*) AS requests,
              SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted
         FROM connection_requests WHERE created_at >= datetime('now', ?) GROUP BY day ORDER BY day`,
      since,
    );
    const reportMetrics = q.all(
      `SELECT date(created_at) AS day, COUNT(*) AS reports,
              SUM(CASE WHEN severity IN ('high','critical') THEN 1 ELSE 0 END) AS serious
         FROM reports WHERE created_at >= datetime('now', ?) GROUP BY day ORDER BY day`,
      since,
    );
    const promptEngagement = q.all(
      `SELECT p.id, p.text, p.game_key, p.usage_count
         FROM game_prompts p ORDER BY p.usage_count DESC LIMIT 15`,
    );
    const errors = q.all(
      `SELECT event, COUNT(*) AS n FROM analytics_events
        WHERE created_at >= datetime('now', ?) AND event LIKE 'error%' GROUP BY event ORDER BY n DESC LIMIT 20`,
      since,
    );
    const rematchRate = q.get(
      `SELECT
         (SELECT COUNT(*) FROM matches WHERE is_rematch_of IS NOT NULL AND created_at >= datetime('now', ?)) AS rematches,
         (SELECT COUNT(*) FROM matches WHERE status = 'completed' AND created_at >= datetime('now', ?)) AS completed`,
      since,
      since,
    );

    // Aggregated only - no private message content is ever surfaced here.
    res.json({
      days,
      dau,
      matchesByDay,
      modePopularity,
      queueMetrics,
      connectionMetrics,
      reportMetrics,
      promptEngagement,
      errors,
      rematchRate: {
        rematches: rematchRate.rematches || 0,
        completed: rematchRate.completed || 0,
        rate: rematchRate.completed ? rematchRate.rematches / rematchRate.completed : 0,
      },
    });
  }),
);

router.get(
  '/audit-log',
  handler(async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const rows = q.all(
      `SELECT a.*, u.username AS actor_username FROM admin_audit_log a
        LEFT JOIN users u ON u.id = a.actor_user_id ORDER BY a.id DESC LIMIT ?`,
      limit,
    );
    res.json({ entries: rows });
  }),
);

export default router;
