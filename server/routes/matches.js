import { Router } from 'express';
import { q } from '../db/index.js';
import { handler, badRequest, conflict, forbidden } from '../lib/http.js';
import { requireAuth, requireActive } from '../middleware.js';
import {
  acceptMatch,
  declineMatch,
  submitAnswer,
  castVote,
  publicMatchState,
  connectAfterMatch,
  rematch,
  abandonMatch,
  matchForUser,
} from '../lib/matches.js';
import { assertNotRestricted } from '../lib/safety.js';
import { enforce } from '../lib/rateLimit.js';
import { screenText } from '../lib/safety.js';
import { judgeAvailability } from '../lib/judge.js';

const router = Router();

/** Solo practice scoring: local rubric only, never affects rank. */
router.post(
  '/practice/score',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const { gameKey, body } = req.body || {};
    if (!gameKey || !body) throw badRequest('A game mode and an answer are required.');
    enforce('practice_score', req.user.id, 40, 60 * 1000);
    const verdict = screenText(String(body));
    if (!verdict.allowed) throw badRequest(verdict.reason || 'That answer is not allowed.');
    const { heuristicJudge } = await import('../lib/judge.js');
    const scored = heuristicJudge('Practice prompt', String(body));
    res.json({
      score: scored.total,
      breakdown: scored.breakdown,
      judgedBy: 'local',
      note: 'Practice scores use the deterministic local rubric and do not change your rank or XP.',
    });
  }),
);

router.get(
  '/:publicId',
  requireAuth,
  handler(async (req, res) => {
    res.json(publicMatchState(req.params.publicId, req.user.id));
  }),
);

router.post(
  '/:publicId/accept',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    assertNotRestricted(req.user.id, 'join matches');
    enforce('match_accept', req.user.id, 30, 60 * 1000);
    const state = acceptMatch(req.params.publicId, req.user.id);
    res.json({ ok: true, state });
  }),
);

router.post(
  '/:publicId/decline',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    res.json(declineMatch(req.params.publicId, req.user.id));
  }),
);

router.post(
  '/:publicId/submit',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    enforce('round_submit', req.user.id, 30, 60 * 1000);
    const { body, eventId } = req.body || {};
    const text = String(body || '');
    const verdict = screenText(text);
    if (!verdict.allowed) throw badRequest(verdict.reason || 'That answer is not allowed.');
    // Duplicate submissions are blocked by the unique constraint in submitAnswer.
    res.json({ ...submitAnswer(req.params.publicId, req.user.id, text, { eventId }), state: publicMatchState(req.params.publicId, req.user.id) });
  }),
);

router.post(
  '/:publicId/vote',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const { targetUserId } = req.body || {};
    if (!targetUserId) throw badRequest('Choose who to vote for.');
    // Self-voting is rejected in the engine; this is the second line of defence.
    if (Number(targetUserId) === Number(req.user.id)) throw forbidden('You cannot vote for yourself.');
    enforce('round_vote', req.user.id, 30, 60 * 1000);
    const result = castVote(req.params.publicId, req.user.id, Number(targetUserId));
    res.json({ ...result, state: publicMatchState(req.params.publicId, req.user.id) });
  }),
);

router.post(
  '/:publicId/connect',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const { conversationId } = connectAfterMatch(req.params.publicId, req.user.id);
    res.json({ ok: true, conversationId });
  }),
);

router.post(
  '/:publicId/rematch',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const invite = Boolean(req.body?.invite);
    const result = rematch(req.params.publicId, req.user.id, { invite });
    res.json({
      ...result,
      state: result.match ? publicMatchState(result.match.id, req.user.id) : null,
    });
  }),
);

router.post(
  '/:publicId/leave',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const { match } = matchForUser(req.params.publicId, req.user.id);
    abandonMatch(match.id, { reason: 'player_left', actorId: req.user.id });
    res.json({ ok: true, status: 'abandoned' });
  }),
);

router.get(
  '/:publicId/result',
  requireAuth,
  handler(async (req, res) => {
    const state = publicMatchState(req.params.publicId, req.user.id);
    if (state.match.status !== 'completed') throw conflict('This match has not finished yet.');
    res.json({ outcome: state.outcome, judge: judgeAvailability() });
  }),
);

export default router;
