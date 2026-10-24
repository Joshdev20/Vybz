import crypto from 'node:crypto';
import { config } from '../config.js';

const KEY_LEN = 64;

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt + config.sessionSecret, KEY_LEN).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Random opaque token; only its hash is ever stored server-side. */
export function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token + config.sessionSecret).digest('hex');
}

/** Hash an IP address for abuse signals without retaining the raw value. */
export function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip || '') + config.sessionSecret).digest('hex').slice(0, 32);
}

export function randomId(bytes = 9) {
  return crypto.randomBytes(bytes).toString('base64url');
}

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
export function roomCode(length = 6) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
  }
  return out;
}

export function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
