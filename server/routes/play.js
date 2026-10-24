import { Router } from 'express';
import { q } from '../db/index.js';
import { handler, badRequest, conflict } from '../lib/http.js';
import { requireAuth, requireActive } from '../middleware.js';
import { joinQueue, leaveQueue, anyActiveQueue, queueStats, activeMatchForUser, findOpponent } from '../lib/matchmaking.js';
import { createMatch, publicMatchState } from '../lib/matches.js';
import { isRoundGame } from '../games/index.js';
import { judgeAvailability } from '../lib/judge.js';
import { assertNotRestricted } from '../lib/safety.js';
import { levelProgress, gameRank } from '../lib/progression.js';
import { unreadCount } from '../lib/connections.js';
import { unreadNotificationCount } from '../lib/events.js';
import { getPresenceSummary } from '../lib/presenceHelpers.js';

const router = Router();

/** Game catalogue with live queue counts and honest availability. */
router.get(
  '/modes',
  requireAuth,
  handler(async (req, res) => {
    res.json({ modes: listModes(req.user.id), judge: judgeAvailability() });
  }),
);

/**
 * Rich game-mode payload shared by /modes and /dashboard so the Play tiles
 * always have prompt counts, categories, player limits and queue state.
 */
function listModes(userId) {
  const modes = q.all('SELECT * FROM game_modes WHERE enabled = 1 ORDER BY sort_order');
  return modes.map((m) => {
    const categories = q.all(
      'SELECT key, label, description, intensity FROM prompt_categories WHERE game_key = ? AND enabled = 1 ORDER BY sort_order',
      m.key,
    );
    const promptCount = q.get(
      'SELECT COUNT(*) AS n FROM game_prompts WHERE game_key = ? AND enabled = 1',
      m.key,
    ).n;
    return {
      key: m.key,
      name: m.name,
      tagline: m.tagline,
      description: m.description,
      minPlayers: m.min_players,
      maxPlayers: m.max_players,
      supportsQueue: Boolean(m.supports_queue),
      supportsRooms: Boolean(m.supports_rooms),
      supportsAsync: Boolean(m.supports_async),
      categories,
      promptCount,
      queue: m.supports_queue ? queueStats(m.key) : null,
      myRank: gameRank(userId, m.key),
    };
  });
}

/** Everything the Play screen needs in one call. */
router.get(
  '/dashboard',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const stats = q.get('SELECT * FROM player_statistics WHERE user_id = ?', req.user.id);
    const active = activeMatchForUser(req.user.id);
    const queue = anyActiveQueue(req.user.id);
    const recent = q.all(
      `SELECT m.public_id, m.game_key, m.status, m.ended_at, m.created_at, p.score, p.result
         FROM match_participants p JOIN matches m ON m.id = p.match_id
        WHERE p.user_id = ? ORDER BY m.id DESC LIMIT 5`,
      req.user.id,
    );
    const day = new Date().toISOString().slice(0, 10);
    const challenges = q.all(
      `SELECT c.title, c.scope, c.target, c.xp_reward, COALESCE(uc.progress,0) AS progress, uc.completed_at
         FROM challenges c
         LEFT JOIN user_challenges uc ON uc.challenge_id = c.id AND uc.user_id = ?
        WHERE c.enabled = 1 AND (c.active_date IS NULL OR c.active_date = ?)
        ORDER BY c.scope, c.id LIMIT 6`,
      req.user.id,
      day,
    );
    const signals = q.get(
      "SELECT COUNT(*) AS n FROM anonymous_signals WHERE recipient_user_id = ? AND status IN ('delivered','reacted')",
      req.user.id,
    ).n;

    res.json({
      statistics: stats,
      progress: levelProgress(stats?.xp || 0),
      activeMatch: active ? { publicId: active.public_id, gameKey: active.game_key, status: active.status } : null,
      queue: queue ? { gameKey: queue.game_key, status: queue.status, since: queue.created_at } : null,
      recentMatches: recent.map((r) => ({
        publicId: r.public_id,
        gameKey: r.game_key,
        status: r.status,
        score: r.score,
        result: r.result,
        at: r.ended_at || r.created_at,
      })),
      challenges: challenges.map((c) => ({
        title: c.title,
        scope: c.scope,
        target: c.target,
        progress: c.progress,
        xpReward: c.xp_reward,
        completed: Boolean(c.completed_at),
      })),
      modes: listModes(req.user.id),
      judge: judgeAvailability(),
      signalsPending: signals,
      unreadMessages: unreadCount(req.user.id),
      unreadNotifications: unreadNotificationCount(req.user.id),
      presence: getPresenceSummary(req.user.id),
    });
  }),
);

router.post(
  '/queue',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const { gameKey, format, difficulty, categories } = req.body || {};
    if (!gameKey || !isRoundGame(gameKey)) throw badRequest('Choose a valid game mode.');
    assertNotRestricted(req.user.id, 'join matchmaking');

    const result = joinQueue(req.user.id, gameKey, {
      format: format || 'classic',
      difficulty: difficulty || 'standard',
      filters: { categories: Array.isArray(categories) ? categories.slice(0, 8) : [] },
    });

    // Attempt an immediate pairing; an empty queue stays honestly empty.
    const match = findOpponent(result.entry, { createMatch });
    if (match) {
      return res.json({
        status: 'matched',
        match: { publicId: match.public_id, gameKey: match.game_key, id: match.id },
        state: publicMatchState(match.id, req.user.id),
      });
    }
    res.json({
      status: 'waiting',
      queue: { gameKey, since: result.entry.created_at, expiresAt: result.entry.expires_at },
      waiting: queueStats(gameKey).waiting,
      // Honest empty-queue messaging, no fabricated opponents.
      message:
        queueStats(gameKey).waiting > 1
          ? 'Still searching. Matching happens as soon as a compatible player arrives.'
          : 'Nobody else is queued for this mode right now. You can invite a friend or try a practice round while you wait.',
    });
  }),
);

router.delete(
  '/queue',
  requireAuth,
  handler(async (req, res) => {
    const gameKey = req.body?.gameKey || req.query.gameKey;
    if (!gameKey) throw badRequest('Specify which queue to leave.');
    res.json(leaveQueue(req.user.id, String(gameKey)));
  }),
);

router.get(
  '/queue/status',
  requireAuth,
  handler(async (req, res) => {
    const entry = anyActiveQueue(req.user.id);
    if (!entry) return res.json({ status: 'idle' });
    if (entry.status === 'matched' && entry.match_id) {
      const state = publicMatchState(entry.match_id, req.user.id);
      return res.json({ status: 'matched', state });
    }
    res.json({
      status: entry.status,
      queue: { gameKey: entry.game_key, since: entry.created_at, expiresAt: entry.expires_at },
      waiting: queueStats(entry.game_key).waiting,
    });
  }),
);

/** Poll for a pairing (the WebSocket pushes this too; polling is the fallback). */
router.post(
  '/queue/tick',
  requireAuth,
  handler(async (req, res) => {
    const gameKey = req.body?.gameKey;
    if (!gameKey) throw badRequest('Specify a game mode.');
    const entry = q.get(
      "SELECT * FROM matchmaking_queue WHERE user_id = ? AND game_key = ? AND status = 'waiting'",
      req.user.id,
      String(gameKey),
    );
    if (!entry) {
      const active = activeMatchForUser(req.user.id);
      if (active) return res.json({ status: 'matched', state: publicMatchState(active.match_id, req.user.id) });
      return res.json({ status: 'idle' });
    }
    const match = findOpponent(entry, { createMatch });
    if (match) return res.json({ status: 'matched', state: publicMatchState(match.id, req.user.id) });
    res.json({ status: 'waiting', waiting: queueStats(String(gameKey)).waiting });
  }),
);

/** Solo practice so an empty queue still lets someone play. */
router.post(
  '/practice',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const gameKey = req.body?.gameKey;
    if (!gameKey || !isRoundGame(gameKey)) throw badRequest('Choose a valid game mode.');
    const prompt = q.get(
      'SELECT * FROM game_prompts WHERE game_key = ? AND enabled = 1 ORDER BY RANDOM() LIMIT 1',
      gameKey,
    );
    if (!prompt) throw conflict('No practice prompts are available for this mode yet.');
    res.json({
      practice: {
        gameKey,
        promptId: prompt.id,
        prompt: prompt.text,
        roundSeconds: prompt.round_seconds,
        note: 'Practice rounds are scored locally for feedback and do not affect your rank.',
      },
    });
  }),
);

export default router;
