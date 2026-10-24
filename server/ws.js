import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { parseCookies, clientIp } from './lib/http.js';
import { SESSION_COOKIE, resolveSession } from './lib/auth.js';
import { addConnection, removeConnection, isOnline } from './lib/presence.js';
import { onEvent } from './lib/events.js';
import { logger } from './lib/logger.js';
import { q } from './db/index.js';
import { cleanupQueue, findOpponent, queueStats } from './lib/matchmaking.js';
import { createMatch, publicMatchState } from './lib/matches.js';
import { expireStaleSessions } from './lib/blindVibe.js';

const clients = new Set();

export function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, config.publicUrl).pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    // Origin check prevents cross-site WebSocket hijacking.
    const origin = req.headers.origin;
    if (origin) {
      try {
        const host = new URL(origin).host;
        if (host !== new URL(config.publicUrl).host && host !== req.headers.host) {
          logger.warn('websocket origin rejected', { origin });
          socket.destroy();
          return;
        }
      } catch {
        socket.destroy();
        return;
      }
    }
    const cookies = parseCookies(req.headers.cookie || '');
    const user = resolveSession(cookies[SESSION_COOKIE]);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (user.status === 'banned' || user.status === 'deactivated') {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = user.id;
      ws.username = user.username;
      ws.role = user.role;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    addConnection(ws.userId, ws);
    logger.debug('websocket connected', { userId: ws.userId });

    send(ws, 'ready', {
      userId: ws.userId,
      serverTime: new Date().toISOString(),
      presence: 'online',
    });

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, 'error', { message: 'Malformed message.' });
      }
      try {
        await handleClientMessage(ws, msg);
      } catch (err) {
        logger.debug('ws message error', { type: msg?.type, error: err.message });
        send(ws, 'error', { code: err.code || 'error', message: err.message, forType: msg?.type });
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      removeConnection(ws.userId, ws);
      logger.debug('websocket disconnected', { userId: ws.userId });
    });

    ws.on('error', (err) => logger.debug('websocket error', { userId: ws.userId, error: err.message }));
  });

  // Push server-side events to the right sockets.
  onEvent(({ userId, event, payload }) => {
    for (const ws of clients) {
      if (ws.userId === userId && ws.readyState === ws.OPEN) {
        send(ws, event, payload);
      }
    }
  });

  // Heartbeat: drop dead sockets so presence stays accurate.
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        clients.delete(ws);
        removeConnection(ws.userId, ws);
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* socket already gone */
      }
    }
  }, 30_000);

  // Queue maintenance: expire stale entries, drop disconnected players.
  const queueTimer = setInterval(() => {
    try {
      cleanupQueue({
        isOnline,
        onExpire: (entry) => {
          pushToUser(entry.user_id, 'queue_expired', { gameKey: entry.game_key });
        },
      });
      expireStaleSessions();
    } catch (err) {
      logger.error('queue cleanup failed', { error: err.message });
    }
  }, 15_000);

  // Attempt pairings for everyone waiting, so matches happen even if a client
  // never polls. This is the server-authoritative source of match creation.
  const matchTimer = setInterval(() => {
    try {
      const waiting = q.all(
        "SELECT * FROM matchmaking_queue WHERE status = 'waiting' AND expires_at > datetime('now') ORDER BY created_at",
      );
      const handled = new Set();
      for (const entry of waiting) {
        if (handled.has(entry.user_id)) continue;
        const match = findOpponent(entry, { createMatch });
        if (match) {
          handled.add(entry.user_id);
          const parts = q.all('SELECT user_id FROM match_participants WHERE match_id = ?', match.id);
          for (const p of parts) {
            pushToUser(p.user_id, 'match_found', {
              matchId: match.id,
              publicId: match.public_id,
              gameKey: match.game_key,
            });
          }
        }
      }
    } catch (err) {
      logger.error('matchmaking tick failed', { error: err.message });
    }
  }, 3000);

  const shutdown = () => {
    clearInterval(heartbeat);
    clearInterval(queueTimer);
    clearInterval(matchTimer);
    for (const ws of clients) {
      try {
        ws.close(1001, 'Server shutting down');
      } catch {
        /* ignore */
      }
    }
  };

  return { wss, shutdown, clients };
}

async function handleClientMessage(ws, msg) {
  switch (msg.type) {
    case 'ping':
      return send(ws, 'pong', { t: Date.now() });
    case 'presence':
      return send(ws, 'presence', { presence: 'online' });
    case 'queue:status': {
      const gameKey = String(msg.gameKey || '');
      if (!gameKey) throw Object.assign(new Error('gameKey required'), { code: 'bad_request' });
      return send(ws, 'queue:status', {
        gameKey,
        waiting: queueStats(gameKey).waiting,
        serverTime: new Date().toISOString(),
      });
    }
    case 'match:state': {
      const state = publicMatchState(String(msg.publicId || ''), ws.userId);
      return send(ws, 'match:state', state);
    }
    case 'typing': {
      const conversationId = Number(msg.conversationId);
      const others = q.all(
        'SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id <> ?',
        conversationId,
        ws.userId,
      );
      // Typing indicators only reach authorized participants.
      const member = q.get(
        'SELECT 1 AS x FROM conversation_participants WHERE conversation_id = ? AND user_id = ?',
        conversationId,
        ws.userId,
      );
      if (!member) throw Object.assign(new Error('Not a participant'), { code: 'forbidden' });
      for (const o of others) pushToUser(o.user_id, 'typing', { conversationId, userId: ws.userId });
      return undefined;
    }
    case 'room:refresh': {
      const roomId = Number(msg.roomId);
      const member = q.get(
        'SELECT 1 AS x FROM room_members WHERE room_id = ? AND user_id = ? AND left_at IS NULL',
        roomId,
        ws.userId,
      );
      if (!member) throw Object.assign(new Error('Not a room member'), { code: 'forbidden' });
      const { getRoom } = await import('./lib/rooms.js');
      return send(ws, 'room:state', getRoom(roomId, ws.userId));
    }
    default:
      return send(ws, 'error', { message: 'Unknown message type.', forType: msg.type });
  }
}

function send(ws, type, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify({ type, payload, at: new Date().toISOString() }));
  } catch (err) {
    logger.debug('ws send failed', { error: err.message });
  }
}

export function pushToUser(userId, type, payload) {
  let sent = 0;
  for (const ws of clients) {
    if (ws.userId === Number(userId) && ws.readyState === ws.OPEN) {
      send(ws, type, payload);
      sent += 1;
    }
  }
  return sent;
}

export function connectedClientCount() {
  return clients.size;
}
