import { Router } from 'express';
import { q } from '../db/index.js';
import { handler, badRequest, notFound, forbidden } from '../lib/http.js';
import { requireAuth, requireActive } from '../middleware.js';
import { randomId } from '../lib/crypto.js';
import { enforce } from '../lib/rateLimit.js';
import { config } from '../config.js';

const router = Router();

const ALLOWED_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
]);
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB avatar cap

/**
 * Avatars are stored server-side (or in object storage when configured).
 * Access is authenticated: uploads are never world-readable by URL guessing
 * alone, and object keys are opaque.
 */
router.post(
  '/avatar',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    enforce('media_upload', req.user.id, 10, 60 * 60 * 1000);
    const { dataUrl } = req.body || {};
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      throw badRequest('Provide an image as a data URL.');
    }
    const match = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) throw badRequest('That image format is not supported.');
    const [, mimeType, base64] = match;
    if (!ALLOWED_TYPES.has(mimeType)) throw badRequest('Only PNG, JPEG or WebP images are allowed.');

    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > MAX_BYTES) throw badRequest('Images must be 2 MB or smaller.');
    if (buffer.length < 64) throw badRequest('That image looks empty.');

    // Basic signature validation so a renamed file cannot smuggle other data.
    const sig = buffer.subarray(0, 12);
    const isPng = sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47;
    const isJpeg = sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff;
    const isWebp = buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
    if (!isPng && !isJpeg && !isWebp) throw badRequest('That file is not a valid image.');

    const id = randomId(12);
    const previous = q.get('SELECT id FROM media WHERE user_id = ?', req.user.id);
    q.run('INSERT INTO media (id, user_id, mime_type, byte_size, data) VALUES (?, ?, ?, ?, ?)', id, req.user.id, mimeType, buffer.length, buffer);
    if (previous) q.run('DELETE FROM media WHERE id = ?', previous.id);

    q.run(
      "UPDATE user_profiles SET avatar_kind = 'upload', avatar_value = ?, updated_at = datetime('now') WHERE user_id = ?",
      id,
      req.user.id,
    );
    res.status(201).json({ mediaId: id, url: `/api/media/${id}` });
  }),
);

router.get(
  '/:id',
  requireAuth,
  handler(async (req, res) => {
    const row = q.get('SELECT * FROM media WHERE id = ?', String(req.params.id));
    if (!row || !row.data) throw notFound('Image not found.');
    // Avatars are visible to any signed-in player (that is their purpose),
    // but never to unauthenticated callers.
    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(Buffer.from(row.data));
  }),
);

router.delete(
  '/avatar',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    q.run('DELETE FROM media WHERE user_id = ?', req.user.id);
    q.run(
      "UPDATE user_profiles SET avatar_kind = 'preset', avatar_value = 'preset-1', updated_at = datetime('now') WHERE user_id = ?",
      req.user.id,
    );
    res.json({ ok: true });
  }),
);

export default router;
