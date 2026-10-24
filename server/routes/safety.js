import { Router } from 'express';
import { q } from '../db/index.js';
import { handler, badRequest } from '../lib/http.js';
import { requireAuth, requireActive } from '../middleware.js';
import { blockUser, unblockUser, createReport, blockedUserIds, REPORT_REASON_LIST } from '../lib/safety.js';
import { enforce } from '../lib/rateLimit.js';

const router = Router();

router.get(
  '/blocks',
  requireAuth,
  handler(async (req, res) => {
    const ids = blockedUserIds(req.user.id);
    const rows = ids.length
      ? q.all(
          `SELECT u.id, u.username, p.display_name, p.avatar_kind, p.avatar_value
             FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id
            WHERE u.id IN (${ids.map(() => '?').join(',')})`,
          ...ids,
        )
      : [];
    const mine = q.all('SELECT blocked_id FROM blocks WHERE blocker_id = ?', req.user.id).map((r) => r.blocked_id);
    res.json({
      blocked: rows.map((r) => ({
        userId: r.id,
        username: r.username,
        displayName: r.display_name,
        avatarKind: r.avatar_kind,
        avatarValue: r.avatar_value,
        blockedByMe: mine.includes(r.id),
      })),
    });
  }),
);

router.post(
  '/blocks',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const { userId } = req.body || {};
    if (!userId) throw badRequest('Choose someone to block.');
    enforce('block', req.user.id, 40, 60 * 60 * 1000);
    res.status(201).json(blockUser(req.user.id, Number(userId)));
  }),
);

router.delete(
  '/blocks/:userId',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    res.json(unblockUser(req.user.id, Number(req.params.userId)));
  }),
);

router.get(
  '/report-reasons',
  requireAuth,
  handler(async (req, res) => {
    res.json({ reasons: REPORT_REASON_LIST });
  }),
);

router.post(
  '/reports',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    enforce('report', req.user.id, 20, 60 * 60 * 1000);
    const { subjectUserId, targetType, targetId, reason, details } = req.body || {};
    if (!reason) throw badRequest('Choose a reason for the report.');
    const result = createReport({
      reporterId: req.user.id,
      subjectUserId: subjectUserId ? Number(subjectUserId) : null,
      targetType: targetType || 'user',
      targetId: targetId ? Number(targetId) : null,
      reason,
      details: details || '',
    });
    res.status(201).json({ ...result, note: 'Thank you. Our moderation team will review this report.' });
  }),
);

router.get(
  '/reports/mine',
  requireAuth,
  handler(async (req, res) => {
    const rows = q.all(
      `SELECT id, target_type, reason, status, created_at, updated_at
         FROM reports WHERE reporter_id = ? ORDER BY created_at DESC LIMIT 50`,
      req.user.id,
    );
    res.json({
      reports: rows.map((r) => ({
        id: r.id,
        targetType: r.target_type,
        reason: r.reason,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  }),
);

export default router;
