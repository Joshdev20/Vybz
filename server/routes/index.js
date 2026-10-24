import express from 'express';
import path from 'node:path';
import { config, ROOT } from '../config.js';
import { attachUser, requireAuth, requireActive, sameOriginGuard } from '../middleware.js';
import { handler } from '../lib/http.js';
import { logger } from '../lib/logger.js';

import authRoutes from './auth.js';
import profileRoutes from './profile.js';
import playRoutes from './play.js';
import matchRoutes from './matches.js';
import signalRoutes from './signals.js';
import roomRoutes from './rooms.js';
import blindVibeRoutes from './blindVibe.js';
import inboxRoutes from './inbox.js';
import connectionRoutes from './connections.js';
import safetyRoutes from './safety.js';
import notificationRoutes from './notifications.js';
import adminRoutes from './admin.js';
import mediaRoutes from './media.js';
import analyticsRoutes from './analytics.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '256kb' }));
  app.use(attachUser);
  app.use(sameOriginGuard);

  // Security headers suitable for a self-contained SPA.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self' ws: wss:",
        "font-src 'self' data:",
        "base-uri 'none'",
        "form-action 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    next();
  });

  const api = express.Router();
  api.use('/auth', authRoutes);
  api.use('/profile', profileRoutes);
  api.use('/play', playRoutes);
  api.use('/matches', matchRoutes);
  api.use('/signals', signalRoutes);
  api.use('/rooms', roomRoutes);
  api.use('/blind-vibe', blindVibeRoutes);
  api.use('/inbox', inboxRoutes);
  api.use('/connections', connectionRoutes);
  api.use('/safety', safetyRoutes);
  api.use('/notifications', notificationRoutes);
  api.use('/admin', adminRoutes);
  api.use('/media', mediaRoutes);
  api.use('/analytics', analyticsRoutes);

  api.get('/health', (req, res) => {
    res.json({ ok: true, service: 'vybz', time: new Date().toISOString() });
  });

  app.use('/api', api);

  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

  // SPA fallback for client-side routes (excluding API and asset paths).
  app.get(/^\/(?!api\/|assets\/|css\/|js\/).*/, (req, res) => {
    res.sendFile('index.html', { root: path.join(ROOT, 'public') });
  });

  // Central error handler: never leak internals, always answer with JSON.
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) {
      logger.error('unhandled request error', {
        path: req.path,
        method: req.method,
        error: err.message,
        stack: err.stack?.split('\n').slice(0, 4).join(' | '),
      });
    }
    if (res.headersSent) return;
    res.status(status).json({
      error: {
        code: err.code || (status >= 500 ? 'internal_error' : 'error'),
        message:
          status >= 500 && config.isProduction
            ? 'Something went wrong on our side. Please try again.'
            : err.message || 'Request failed.',
        details: err.details,
      },
    });
  });

  return app;
}

export { requireAuth, requireActive, handler };
