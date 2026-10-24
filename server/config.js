import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// Minimal .env loader (no dependency) so `node server/index.js` just works.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile(path.join(ROOT, '.env'));

const bool = (v, fallback = false) =>
  v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

export const config = {
  port: Number(process.env.PORT || 3000),
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`,
  isProduction: process.env.NODE_ENV === 'production',

  databaseFile: path.resolve(ROOT, process.env.DATABASE_FILE || './data/vybz.db'),
  dbDriver: process.env.DB_DRIVER || 'sqlite',
  databaseUrl: process.env.DATABASE_URL || '',

  sessionSecret: process.env.SESSION_SECRET || 'vybz-development-secret-do-not-use-in-production',
  sessionDays: Number(process.env.SESSION_DAYS || 30),
  bootstrapAdminUsername: (process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin').toLowerCase(),

  aiJudge: {
    enabled: bool(process.env.AI_JUDGE_ENABLED, false),
    provider: process.env.AI_JUDGE_PROVIDER || '',
    model: process.env.AI_JUDGE_MODEL || '',
    apiKey: process.env.AI_JUDGE_API_KEY || '',
    baseUrl: process.env.AI_JUDGE_BASE_URL || '',
  },

  storage: {
    driver: process.env.STORAGE_DRIVER || 'db',
    s3: {
      bucket: process.env.S3_BUCKET || '',
      region: process.env.S3_REGION || '',
      accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    },
  },

  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
};

if (config.isProduction && config.sessionSecret.includes('development-secret')) {
  // Fail loudly rather than silently shipping a guessable session secret.
  throw new Error('SESSION_SECRET must be set to a strong unique value in production.');
}

export const AI_JUDGE_OPERATIONAL = Boolean(
  config.aiJudge.enabled && config.aiJudge.apiKey && config.aiJudge.baseUrl && config.aiJudge.model,
);
