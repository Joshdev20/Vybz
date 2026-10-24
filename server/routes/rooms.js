import { Router } from 'express';
import { q } from '../db/index.js';
import { handler, badRequest } from '../lib/http.js';
import { requireAuth, requireActive } from '../middleware.js';
import {
  createRoom,
  joinRoom,
  leaveRoom,
  getRoom,
  setReady,
  startRound,
  answerRound,
  skipRound,
  endRoom,
  listPublicRooms,
  inviteToRoom,
} from '../lib/rooms.js';
import { enforce } from '../lib/rateLimit.js';
import { createReport } from '../lib/safety.js';
import { emitToUsers } from '../lib/events.js';

const router = Router();

router.get(
  '/',
  requireAuth,
  handler(async (req, res) => {
    const mine = q.all(
      `SELECT r.*, rm.role, rm.left_at,
              (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id AND m.left_at IS NULL) AS player_count
         FROM rooms r JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = ?
        WHERE r.status IN ('lobby','active','paused') AND rm.left_at IS NULL
        ORDER BY r.updated_at DESC`,
      req.user.id,
    );
    res.json({
      myRooms: mine.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        status: r.status,
        playerCount: r.player_count,
        maxPlayers: r.max_players,
        role: r.role,
      })),
      publicRooms: listPublicRooms(req.user.id),
    });
  }),
);

router.post(
  '/',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    enforce('room_create', req.user.id, 10, 60 * 60 * 1000);
    const { name, visibility, maxPlayers, categories, boundaries } = req.body || {};
    const room = createRoom(req.user.id, { name, visibility, maxPlayers, categories, boundaries });
    res.status(201).json(room);
  }),
);

router.post(
  '/join',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    enforce('room_join', req.user.id, 30, 60 * 1000);
    const { code, roomId } = req.body || {};
    if (!code && !roomId) throw badRequest('Enter a room code.');
    res.json(joinRoom(req.user.id, { code, roomId: roomId ? Number(roomId) : undefined }));
  }),
);

router.get(
  '/:id',
  requireAuth,
  handler(async (req, res) => {
    res.json(getRoom(Number(req.params.id), req.user.id));
  }),
);

router.post(
  '/:id/ready',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    res.json(setReady(req.user.id, Number(req.params.id), Boolean(req.body?.ready)));
  }),
);

router.post(
  '/:id/round',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    enforce('room_round', req.user.id, 60, 60 * 1000);
    const result = startRound(req.user.id, Number(req.params.id), {
      activeUserId: req.body?.activeUserId ? Number(req.body.activeUserId) : null,
    });
    res.json({ ...result, room: getRoom(Number(req.params.id), req.user.id) });
  }),
);

router.post(
  '/:id/round/:roundId/answer',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    enforce('room_answer', req.user.id, 60, 60 * 1000);
    answerRound(req.user.id, Number(req.params.id), Number(req.params.roundId), req.body?.body);
    res.json({ ok: true, room: getRoom(Number(req.params.id), req.user.id) });
  }),
);

router.post(
  '/:id/round/:roundId/skip',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    skipRound(req.user.id, Number(req.params.id), Number(req.params.roundId));
    res.json({ ok: true, room: getRoom(Number(req.params.id), req.user.id) });
  }),
);

router.post(
  '/:id/invite',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const { userId } = req.body || {};
    if (!userId) throw badRequest('Choose someone to invite.');
    res.json(inviteToRoom(req.user.id, Number(req.params.id), Number(userId)));
  }),
);

router.post(
  '/:id/leave',
  requireAuth,
  handler(async (req, res) => {
    res.json(leaveRoom(req.user.id, Number(req.params.id)));
  }),
);

router.post(
  '/:id/end',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    res.json(endRoom(req.user.id, Number(req.params.id)));
  }),
);

/** Report a room (or a participant inside it) for moderator review. */
router.post(
  '/:id/report',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const { reason, details, subjectUserId } = req.body || {};
    const roomId = Number(req.params.id);
    // Membership is required so rooms cannot be reported by outsiders.
    const member = q.get(
      'SELECT 1 AS x FROM room_members WHERE room_id = ? AND user_id = ? AND left_at IS NULL',
      roomId,
      req.user.id,
    );
    if (!member) throw badRequest('You are not in that room.');
    const result = createReport({
      reporterId: req.user.id,
      subjectUserId: subjectUserId ? Number(subjectUserId) : q.get('SELECT host_user_id AS uid FROM rooms WHERE id = ?', roomId).uid,
      targetType: 'room',
      targetId: roomId,
      reason: reason || 'inappropriate_content',
      details: details || '',
    });
    res.status(201).json(result);
  }),
);

export default router;
