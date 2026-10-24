import { Router } from 'express';
import { handler, badRequest } from '../lib/http.js';
import { requireAuth, requireActive } from '../middleware.js';
import {
  listSignals,
  sendSignal,
  reactToSignal,
  signalTemplates,
  signalQuota,
  eligibleSignalTargets,
} from '../lib/signals.js';
import { createReport } from '../lib/safety.js';
import { blockUser } from '../lib/safety.js';
import { enforce } from '../lib/rateLimit.js';

const router = Router();

router.get(
  '/',
  requireAuth,
  handler(async (req, res) => {
    res.json({ ...listSignals(req.user.id), quota: signalQuota(req.user.id) });
  }),
);

router.get(
  '/templates',
  requireAuth,
  handler(async (req, res) => {
    res.json({ templates: signalTemplates(req.query.kind ? String(req.query.kind) : undefined) });
  }),
);

router.get(
  '/targets',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    res.json({ targets: eligibleSignalTargets(req.user.id) });
  }),
);

router.post(
  '/',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const { recipientId, templateKey, body } = req.body || {};
    if (!recipientId) throw badRequest('Choose someone to send a signal to.');
    enforce('signal_post', req.user.id, 20, 60 * 60 * 1000);
    const result = sendSignal(req.user.id, Number(recipientId), {
      templateKey: templateKey || null,
      body: body || null,
    });
    res.status(201).json({ ...result, quota: signalQuota(req.user.id) });
  }),
);

router.post(
  '/:id/react',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const { action } = req.body || {};
    if (!['react', 'dismiss', 'mutual', 'block', 'report'].includes(action)) {
      throw badRequest('Unsupported signal action.');
    }
    enforce('signal_react', req.user.id, 60, 60 * 1000);
    const result = reactToSignal(req.user.id, Number(req.params.id), { action });

    // Blocking or reporting a signal is escalated into the safety pipeline.
    if (action === 'block' && result.senderId) {
      blockUser(req.user.id, result.senderId);
    }
    if (action === 'report' && result.senderId) {
      createReport({
        reporterId: req.user.id,
        subjectUserId: result.senderId,
        targetType: 'signal',
        targetId: Number(req.params.id),
        reason: 'harassment',
        details: 'Reported from an anonymous signal.',
      });
    }
    res.json(result);
  }),
);

export default router;
