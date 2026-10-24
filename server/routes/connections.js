import { Router } from 'express';
import { handler, badRequest } from '../lib/http.js';
import { requireAuth, requireActive } from '../middleware.js';
import {
  listConnections,
  listPendingRequests,
  sendConnectionRequest,
  acceptConnectionRequest,
  declineConnectionRequest,
  cancelConnectionRequest,
  removeConnection,
} from '../lib/connections.js';
import { enforce } from '../lib/rateLimit.js';

const router = Router();

router.get(
  '/',
  requireAuth,
  handler(async (req, res) => {
    res.json({ connections: listConnections(req.user.id), requests: listPendingRequests(req.user.id) });
  }),
);

router.post(
  '/requests',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    enforce('connection_request', req.user.id, 30, 60 * 60 * 1000);
    const { userId, message } = req.body || {};
    if (!userId) throw badRequest('Choose someone to connect with.');
    const result = sendConnectionRequest(req.user.id, Number(userId), {
      source: 'manual',
      message: message || '',
    });
    res.status(201).json(result);
  }),
);

router.post(
  '/requests/:id/accept',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const { q } = await import('../db/index.js');
    const request = q.get('SELECT * FROM connection_requests WHERE id = ?', Number(req.params.id));
    if (!request) throw badRequest('That request no longer exists.');
    res.json(acceptConnectionRequest(req.user.id, request.from_user_id, request.id));
  }),
);

router.post(
  '/requests/:id/decline',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    res.json(declineConnectionRequest(req.user.id, Number(req.params.id)));
  }),
);

router.post(
  '/requests/:id/cancel',
  requireAuth,
  handler(async (req, res) => {
    res.json(cancelConnectionRequest(req.user.id, Number(req.params.id)));
  }),
);

router.delete(
  '/:userId',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    res.json(removeConnection(req.user.id, Number(req.params.userId)));
  }),
);

export default router;
