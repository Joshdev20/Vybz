import { Router } from 'express';
import { handler, badRequest } from '../lib/http.js';
import { requireAuth, requireActive } from '../middleware.js';
import {
  createSession,
  publicSession,
  sendMessage,
  advanceStage,
  expressInterest,
  endSession,
  listMySessions,
} from '../lib/blindVibe.js';
import { findOpponent, joinQueue, leaveQueue } from '../lib/matchmaking.js';
import { enforce } from '../lib/rateLimit.js';
import { createReport } from '../lib/safety.js';
import { q } from '../db/index.js';

const router = Router();

router.get(
  '/',
  requireAuth,
  handler(async (req, res) => {
    res.json({ sessions: listMySessions(req.user.id) });
  }),
);

/** Queue for a Blind Vibe partner (reuses the shared matchmaking queue). */
router.post(
  '/queue',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    enforce('blind_queue', req.user.id, 30, 60 * 1000);
    const result = joinQueue(req.user.id, 'blind_vibe', { format: 'staged' });
    const candidates = q.all(
      `SELECT * FROM matchmaking_queue
        WHERE game_key = 'blind_vibe' AND status = 'waiting' AND user_id <> ?
          AND expires_at > datetime('now') ORDER BY created_at ASC LIMIT 10`,
      req.user.id,
    );
    const { isBlockedEitherWay } = await import('../lib/safety.js');
    const partner = candidates.find((c) => !isBlockedEitherWay(req.user.id, c.user_id));
    if (partner) {
      q.run("UPDATE matchmaking_queue SET status = 'matched' WHERE id IN (?, ?)", result.entry.id, partner.id);
      q.run("UPDATE matchmaking_queue SET status = 'matched' WHERE id = ?", result.entry.id);
      leaveQueue(req.user.id, 'blind_vibe');
      q.run("UPDATE matchmaking_queue SET status = 'matched' WHERE id = ?", partner.id);
      const session = createSession(req.user.id, partner.user_id);
      // Response shape is consistent: session/other are always top-level.
      return res.json({ status: 'matched', ...session });
    }
    res.json({
      status: 'waiting',
      message:
        'Searching for someone who also wants a staged, private conversation. You will be notified when a partner is found.',
      queue: { since: result.entry.created_at, expiresAt: result.entry.expires_at },
    });
  }),
);

router.delete(
  '/queue',
  requireAuth,
  handler(async (req, res) => {
    res.json(leaveQueue(req.user.id, 'blind_vibe'));
  }),
);

router.get(
  '/:publicId',
  requireAuth,
  handler(async (req, res) => {
    res.json(publicSession(req.params.publicId, req.user.id));
  }),
);

router.post(
  '/:publicId/message',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    enforce('blind_message_route', req.user.id, 60, 60 * 1000);
    const result = sendMessage(req.params.publicId, req.user.id, req.body?.body);
    res.json({ ...result, ...publicSession(req.params.publicId, req.user.id) });
  }),
);

router.post(
  '/:publicId/stage',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    advanceStage(req.params.publicId, req.user.id);
    res.json(publicSession(req.params.publicId, req.user.id));
  }),
);

router.post(
  '/:publicId/interest',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const interested = req.body?.interested !== false;
    const result = expressInterest(req.params.publicId, req.user.id, interested);
    res.json({ ...result, ...publicSession(req.params.publicId, req.user.id) });
  }),
);

router.post(
  '/:publicId/end',
  requireAuth,
  handler(async (req, res) => {
    res.json(endSession(req.params.publicId, req.user.id));
  }),
);

router.post(
  '/:publicId/report',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const session = publicSession(req.params.publicId, req.user.id);
    // Even while the other player is anonymous, the session record is reportable
    // and moderators can review it server-side.
    const result = createReport({
      reporterId: req.user.id,
      subjectUserId: session.other.userId || null,
      targetType: 'user',
      targetId: session.other.userId || null,
      reason: req.body?.reason || 'harassment',
      details: `Blind Vibe session ${session.session.publicId}. ${req.body?.details || ''}`.trim(),
    });
    res.status(201).json({
      ...result,
      note: session.other.userId
        ? 'Our moderation team will review this report.'
        : 'Your report is recorded against the session. The other player stays anonymous unless moderation requires otherwise.',
    });
  }),
);

export default router;
