import { Router } from 'express';
import { q } from '../db/index.js';
import { handler, badRequest } from '../lib/http.js';
import { requireAuth, requireActive } from '../middleware.js';
import { enforce } from '../lib/rateLimit.js';

const router = Router();

const ALLOWED_EVENTS = new Set([
  'page_view',
  'game_open',
  'queue_join',
  'queue_cancel',
  'match_start',
  'match_complete',
  'round_submit',
  'vote_cast',
  'rematch_request',
  'signal_send',
  'signal_react',
  'room_create',
  'room_join',
  'blind_vibe_start',
  'blind_vibe_interest',
  'connection_request',
  'connection_accept',
  'message_send',
  'report_filed',
  'block_user',
  'error_client',
  'error_network',
]);

/**
 * Privacy-conscious client analytics. Only whitelisted event names are stored,
 * and no message content is ever accepted here.
 */
router.post(
  '/event',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    enforce('analytics_event', req.user.id, 120, 60 * 1000);
    const { event, gameKey, value, metadata } = req.body || {};
    if (!event || !ALLOWED_EVENTS.has(String(event))) throw badRequest('Unknown analytics event.');
    const safeMeta = {};
    if (metadata && typeof metadata === 'object') {
      for (const [k, v] of Object.entries(metadata)) {
        if (/body|message|content|text|email|password/i.test(k)) continue;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          safeMeta[k] = typeof v === 'string' ? v.slice(0, 80) : v;
        }
      }
    }
    q.run(
      'INSERT INTO analytics_events (user_id, event, game_key, value, metadata) VALUES (?, ?, ?, ?, ?)',
      req.user.id,
      String(event),
      gameKey ? String(gameKey).slice(0, 40) : null,
      typeof value === 'number' ? value : null,
      JSON.stringify(safeMeta),
    );
    res.status(202).json({ ok: true });
  }),
);

export default router;
