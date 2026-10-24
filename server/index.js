import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './routes/index.js';
import { attachWebSocket } from './ws.js';
import { config } from './config.js';
import { migrate, getDb } from './db/index.js';
import { seed, seedChallengesForToday } from './db/seedData.js';
import { logger } from './lib/logger.js';
import { pruneRateLimits } from './lib/rateLimit.js';
import { AI_JUDGE_OPERATIONAL } from './config.js';

/** Boot: verify the database, apply migrations, then start serving. */
function bootstrap() {
  getDb();
  const applied = migrate({ quiet: true });
  if (applied) logger.info('migrations applied', { count: applied });
  seed({ quiet: true });
  seedChallengesForToday();
  logger.info('database ready', { file: config.databaseFile, driver: config.dbDriver });
  if (config.databaseUrl && config.dbDriver !== 'postgres') {
    logger.warn(
      'DATABASE_URL is set but DB_DRIVER is not "postgres"; continuing with the local SQLite store.',
    );
  }
}

export function startServer() {
  bootstrap();
  const app = createApp();
  const server = http.createServer(app);
  const ws = attachWebSocket(server);

  const maintenance = setInterval(() => {
    try {
      pruneRateLimits();
      seedChallengesForToday();
    } catch (err) {
      logger.error('maintenance task failed', { error: err.message });
    }
  }, 60 * 60 * 1000);

  server.listen(config.port, () => {
    logger.info('VYBZ server listening', {
      url: config.publicUrl,
      port: config.port,
      aiJudge: AI_JUDGE_OPERATIONAL ? 'configured' : 'heuristic-fallback',
      storage: config.storage.driver,
    });
    if (!AI_JUDGE_OPERATIONAL) {
      logger.info(
        'Automated judging will use the deterministic local rubric and label results as such. Set AI_JUDGE_* to enable a model provider.',
      );
    }
  });

  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    clearInterval(maintenance);
    ws.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { server, app, ws };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer();
}
