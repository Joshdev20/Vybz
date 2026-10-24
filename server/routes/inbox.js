import { Router } from 'express';
import { handler, badRequest, forbidden } from '../lib/http.js';
import { requireAuth, requireActive } from '../middleware.js';
import {
  listConversations,
  getMessages,
  sendMessage,
  markRead,
  setMuted,
  typing,
  openConversation,
} from '../lib/messaging.js';
import { unreadCount, assertCanMessage } from '../lib/connections.js';
import { enforce } from '../lib/rateLimit.js';
import { q } from '../db/index.js';

const router = Router();

router.get(
  '/',
  requireAuth,
  handler(async (req, res) => {
    res.json({ conversations: listConversations(req.user.id), unread: unreadCount(req.user.id) });
  }),
);

router.post(
  '/open',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const { userId } = req.body || {};
    if (!userId) throw badRequest('Choose who to message.');
    assertCanMessage(req.user.id, Number(userId));
    res.json(openConversation(req.user.id, Number(userId)));
  }),
);

router.get(
  '/:id',
  requireAuth,
  handler(async (req, res) => {
    res.json(getMessages(req.user.id, Number(req.params.id), {
      before: req.query.before,
      limit: req.query.limit,
    }));
  }),
);

router.post(
  '/:id/messages',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    enforce('message_send_route', req.user.id, 60, 60 * 1000);
    const result = sendMessage(req.user.id, Number(req.params.id), req.body?.body);
    res.status(201).json(result);
  }),
);

router.post(
  '/:id/read',
  requireAuth,
  handler(async (req, res) => {
    res.json(markRead(req.user.id, Number(req.params.id)));
  }),
);

router.post(
  '/:id/mute',
  requireAuth,
  handler(async (req, res) => {
    res.json(setMuted(req.user.id, Number(req.params.id), Boolean(req.body?.muted)));
  }),
);

router.post(
  '/:id/typing',
  requireAuth,
  handler(async (req, res) => {
    res.json(typing(req.user.id, Number(req.params.id)));
  }),
);

/** Report a specific message. */
router.post(
  '/:id/messages/:messageId/report',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const conversationId = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    const participant = q.get(
      'SELECT 1 AS x FROM conversation_participants WHERE conversation_id = ? AND user_id = ?',
      conversationId,
      req.user.id,
    );
    if (!participant) throw forbidden('You are not part of this conversation.');
    const message = q.get(
      'SELECT * FROM messages WHERE id = ? AND conversation_id = ?',
      messageId,
      conversationId,
    );
    if (!message) throw badRequest('That message could not be found.');
    if (message.sender_user_id === req.user.id) throw badRequest('You cannot report your own message.');

    const { createReport } = await import('../lib/safety.js');
    const result = createReport({
      reporterId: req.user.id,
      subjectUserId: message.sender_user_id,
      targetType: 'message',
      targetId: messageId,
      reason: req.body?.reason || 'harassment',
      details: req.body?.details || '',
    });
    res.status(201).json(result);
  }),
);

export default router;
