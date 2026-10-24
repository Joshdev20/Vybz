import { Router } from 'express';
import { q } from '../db/index.js';
import { handler } from '../lib/http.js';
import { requireAuth } from '../middleware.js';
import { markNotificationsRead, unreadNotificationCount } from '../lib/events.js';

const router = Router();

router.get(
  '/',
  requireAuth,
  handler(async (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
    const prefs = q.get('SELECT * FROM user_preferences WHERE user_id = ?', req.user.id);
    const rows = q.all(
      `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
      req.user.id,
      limit,
    );
    res.json({
      notifications: rows.map((n) => {
        const isPrivate = Boolean(n.is_private);
        return {
          id: n.id,
          kind: n.kind,
          title: n.title,
          // Private notification bodies are never sent to lock-screen surfaces.
          body: isPrivate && prefs?.hide_private_notifications ? 'Open VYBZ to view' : n.body,
          link: n.link,
          private: isPrivate,
          read: Boolean(n.read_at),
          at: n.created_at,
        };
      }),
      unread: unreadNotificationCount(req.user.id),
    });
  }),
);

router.post(
  '/read',
  requireAuth,
  handler(async (req, res) => {
    const changed = markNotificationsRead(req.user.id, req.body?.ids);
    res.json({ ok: true, changed, unread: unreadNotificationCount(req.user.id) });
  }),
);

export default router;
