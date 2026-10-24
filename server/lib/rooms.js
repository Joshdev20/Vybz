import { q, transaction } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from './http.js';
import { assertNotRestricted, blockedUserIds, hasBlocked, screenText } from './safety.js';
import { notify, emitToUsers } from './events.js';
import { roomCode } from './crypto.js';
import { awardXp, incrementStat, checkAchievements, progressChallenges } from './progression.js';
import { logger } from './logger.js';

/**
 * Spill It! - multiplayer party rooms.
 *
 * Safety rules baked in:
 *  - every player can leave at any time
 *  - every player can skip a question with no penalty
 *  - private rooms are only readable by members
 *  - bold categories require explicit opt-in via room boundaries
 */

const ROOM_PROMPTS = () => q.all("SELECT * FROM game_prompts WHERE game_key = 'spill_it' AND enabled = 1");

export function createRoom(hostId, { name, visibility = 'private', maxPlayers = 6, categories = [], boundaries = {} }) {
  assertNotRestricted(hostId, 'create rooms');
  const cleanName = String(name || '').trim().slice(0, 60) || 'Spill It! room';
  const max = Math.max(2, Math.min(10, Number(maxPlayers) || 6));
  const vis = ['public', 'private', 'invite'].includes(visibility) ? visibility : 'private';

  // Bold content is opt-in, never on by default.
  const safeBoundaries = {
    allowImages: false,
    allowBoldQuestions: Boolean(boundaries.allowBoldQuestions),
    allowPersonalQuestions: boundaries.allowPersonalQuestions !== false,
    ...boundaries,
  };
  safeBoundaries.allowImages = false; // VYBZ never collects images inside game rooms.

  let code = roomCode();
  for (let i = 0; i < 5 && q.get('SELECT 1 AS x FROM rooms WHERE code = ?', code); i += 1) {
    code = roomCode();
  }

  const roomId = transaction((db) => {
    const info = db
      .prepare(
        `INSERT INTO rooms (code, host_user_id, game_key, name, visibility, max_players, categories, boundaries)
         VALUES (?, ?, 'spill_it', ?, ?, ?, ?, ?)`,
      )
      .run(code, hostId, cleanName, vis, max, JSON.stringify(categories || []), JSON.stringify(safeBoundaries));
    const id = Number(info.lastInsertRowid);
    db.prepare("INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, 'host')").run(id, hostId);
    return id;
  });
  logger.info('room created', { roomId, code, hostId, visibility: vis });
  return getRoom(roomId, hostId);
}

export function joinRoom(userId, { code, roomId }) {
  assertNotRestricted(userId, 'join rooms');
  const room = code
    ? q.get('SELECT * FROM rooms WHERE code = ?', String(code).toUpperCase().trim())
    : q.get('SELECT * FROM rooms WHERE id = ?', roomId);
  if (!room) throw notFound('That room code does not exist.');
  if (room.status === 'ended') throw conflict('That room has already ended.');

  if (hasBlocked(room.host_user_id, userId) || hasBlocked(userId, room.host_user_id)) {
    throw forbidden('You cannot join this room.');
  }

  const members = q.all("SELECT * FROM room_members WHERE room_id = ? AND left_at IS NULL", room.id);
  const already = members.find((m) => m.user_id === userId);
  if (already) return getRoom(room.id, userId);
  if (members.length >= room.max_players) throw conflict('That room is full.');

  // Private/invite rooms still require the code, which is the invitation.
  transaction((db) => {
    db.prepare("INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, 'player')").run(room.id, userId);
  });
  broadcastRoom(room.id, { type: 'member_joined', userId });
  return getRoom(room.id, userId);
}

export function leaveRoom(userId, roomId) {
  const member = q.get(
    'SELECT * FROM room_members WHERE room_id = ? AND user_id = ? AND left_at IS NULL',
    roomId,
    userId,
  );
  if (!member) throw notFound('You are not in that room.');
  const room = q.get('SELECT * FROM rooms WHERE id = ?', roomId);
  transaction((db) => {
    db.prepare("UPDATE room_members SET left_at = datetime('now') WHERE id = ?").run(member.id);
    const remaining = db
      .prepare('SELECT * FROM room_members WHERE room_id = ? AND left_at IS NULL')
      .all(roomId);
    if (remaining.length === 0) {
      db.prepare("UPDATE rooms SET status = 'ended', ended_at = datetime('now') WHERE id = ?").run(roomId);
    } else if (member.role === 'host' && room.status !== 'ended') {
      // Host migration keeps the room usable instead of silently orphaning it.
      db.prepare("UPDATE room_members SET role = 'host' WHERE id = ?").run(remaining[0].id);
      db.prepare('UPDATE rooms SET host_user_id = ? WHERE id = ?').run(remaining[0].user_id, roomId);
    }
  });
  broadcastRoom(roomId, { type: 'member_left', userId });
  return { ok: true };
}

export function getRoom(roomId, viewerId) {
  const room = q.get('SELECT * FROM rooms WHERE id = ?', roomId);
  if (!room) throw notFound('Room not found.');
  const membership = q.get(
    'SELECT * FROM room_members WHERE room_id = ? AND user_id = ? AND left_at IS NULL',
    roomId,
    viewerId,
  );
  // Only members can see the room contents.
  if (!membership) throw forbidden('You are not a member of this room.');
  return roomView(room, viewerId, membership);
}

export function roomView(room, viewerId, membership) {
  const members = q.all(
    `SELECT rm.*, u.username, p.display_name, p.avatar_kind, p.avatar_value
       FROM room_members rm
       JOIN users u ON u.id = rm.user_id
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE rm.room_id = ? AND rm.left_at IS NULL
      ORDER BY rm.joined_at`,
    room.id,
  );
  const rounds = q.all('SELECT * FROM room_rounds WHERE room_id = ? ORDER BY round_number DESC LIMIT 20', room.id);
  const active = rounds.find((r) => r.round_number === room.current_round) || null;
  return {
    room: {
      id: room.id,
      code: room.code,
      name: room.name,
      gameKey: room.game_key,
      visibility: room.visibility,
      status: room.status,
      maxPlayers: room.max_players,
      categories: safeJson(room.categories, []),
      boundaries: safeJson(room.boundaries, {}),
      currentRound: room.current_round,
      hostUserId: room.host_user_id,
      isHost: room.host_user_id === viewerId,
      createdAt: room.created_at,
    },
    members: members.map((m) => ({
      userId: m.user_id,
      username: m.username,
      displayName: m.display_name,
      avatarKind: m.avatar_kind,
      avatarValue: m.avatar_value,
      role: m.role,
      ready: Boolean(m.ready),
      score: m.score,
      isMe: m.user_id === viewerId,
    })),
    current: active ? roundView(active, viewerId) : null,
    history: rounds.filter((r) => r.phase === 'revealed').map((r) => roundView(r, viewerId)),
  };
}

function roundView(round, viewerId) {
  const reveal = round.phase === 'revealed';
  const isActive = round.active_user_id === viewerId;
  return {
    id: round.id,
    roundNumber: round.round_number,
    prompt: round.prompt_text,
    category: round.category,
    phase: round.phase,
    activeUserId: round.active_user_id,
    isMyTurn: isActive,
    deadline: round.deadline,
    // Answers are hidden from everyone except the answerer until reveal.
    answer: reveal || isActive ? round.answer : null,
    answered: Boolean(round.answer),
  };
}

export function setReady(userId, roomId, ready) {
  const member = q.get(
    'SELECT * FROM room_members WHERE room_id = ? AND user_id = ? AND left_at IS NULL',
    roomId,
    userId,
  );
  if (!member) throw forbidden('You are not in that room.');
  q.run('UPDATE room_members SET ready = ? WHERE id = ?', ready ? 1 : 0, member.id);
  broadcastRoom(roomId, { type: 'ready', userId, ready: Boolean(ready) });
  return { ok: true };
}

/** Draw the next prompt and put one player on the spot. */
export function startRound(userId, roomId, { activeUserId = null } = {}) {
  const room = q.get('SELECT * FROM rooms WHERE id = ?', roomId);
  if (!room) throw notFound('Room not found.');
  const member = q.get(
    'SELECT * FROM room_members WHERE room_id = ? AND user_id = ? AND left_at IS NULL',
    roomId,
    userId,
  );
  if (!member) throw forbidden('You are not in that room.');
  if (room.status === 'ended') throw conflict('That room has ended.');

  const members = q.all('SELECT * FROM room_members WHERE room_id = ? AND left_at IS NULL ORDER BY joined_at', roomId);
  if (members.length < 2) throw badRequest('You need at least two players to start a round.');

  const boundaries = safeJson(room.boundaries, {});
  const categories = safeJson(room.categories, []);
  let pool = ROOM_PROMPTS();
  if (categories.length) {
    pool = pool.filter((p) => {
      const cat = q.get('SELECT key FROM prompt_categories WHERE id = ?', p.category_id);
      return cat && categories.includes(cat.key);
    });
  }
  if (!boundaries.allowBoldQuestions) {
    pool = pool.filter((p) => p.difficulty !== 'spicy');
  }
  if (!boundaries.allowPersonalQuestions) {
    pool = pool.filter((p) => {
      const cat = q.get('SELECT key FROM prompt_categories WHERE id = ?', p.category_id);
      return !cat || cat.key !== 'bold_questions';
    });
  }
  if (!pool.length) throw conflict('No prompts match this room’s settings. Enable more categories.');

  const prompt = pool[Math.floor(Math.random() * pool.length)];
  const nextRound = room.current_round + 1;
  const turnUserId = activeUserId && members.some((m) => m.user_id === activeUserId)
    ? activeUserId
    : members[nextRound % members.length].user_id;
  const seconds = prompt.round_seconds || 60;
  const deadline = new Date(Date.now() + seconds * 1000).toISOString();

  const roundId = transaction((db) => {
    const info = db
      .prepare(
        `INSERT INTO room_rounds (room_id, round_number, prompt_text, category, active_user_id, phase, round_seconds, deadline)
         VALUES (?, ?, ?, ?, ?, 'answering', ?, ?)`,
      )
      .run(roomId, nextRound, prompt.text, null, turnUserId, seconds, deadline);
    db.prepare("UPDATE rooms SET status = 'active', current_round = ?, updated_at = datetime('now') WHERE id = ?").run(
      nextRound,
      roomId,
    );
    db.prepare('UPDATE game_prompts SET usage_count = usage_count + 1 WHERE id = ?').run(prompt.id);
    return Number(info.lastInsertRowid);
  });
  broadcastRoom(roomId, { type: 'round_started', roundId, roundNumber: nextRound });
  return { roundId, roundNumber: nextRound };
}

export function answerRound(userId, roomId, roundId, body) {
  const round = q.get('SELECT * FROM room_rounds WHERE id = ? AND room_id = ?', roundId, roomId);
  if (!round) throw notFound('Round not found.');
  if (round.phase !== 'answering') throw conflict('This round is closed.');
  if (round.active_user_id !== userId) throw forbidden('It is not your turn.');
  const text = String(body || '').trim();
  if (text.length < 1) throw badRequest('Type an answer or skip.');
  if (text.length > 600) throw badRequest('Keep answers under 600 characters.');

  const verdict = screenText(text);
  if (!verdict.allowed) throw badRequest(verdict.reason || 'That answer is not allowed.');

  q.run(
    "UPDATE room_rounds SET answer = ?, phase = 'revealed', completed_at = datetime('now') WHERE id = ?",
    text,
    roundId,
  );
  q.run('UPDATE room_members SET score = score + 5 WHERE room_id = ? AND user_id = ?', roomId, userId);
  // XP rewards participation only, never pressure or repeated low-effort spam.
  awardXp(userId, 5, 'room_round', `room_round:${roundId}:${userId}`, { roomId });
  progressChallenges(userId, 'rounds_played', 1);
  checkAchievements(userId);
  broadcastRoom(roomId, { type: 'round_revealed', roundId });
  return { ok: true };
}

/** Skipping is always free and never penalised. */
export function skipRound(userId, roomId, roundId) {
  const round = q.get('SELECT * FROM room_rounds WHERE id = ? AND room_id = ?', roundId, roomId);
  if (!round) throw notFound('Round not found.');
  if (round.phase !== 'answering') throw conflict('This round is already closed.');
  if (round.active_user_id !== userId) {
    // Any member may skip on the active player's behalf to keep the game moving.
    const member = q.get(
      'SELECT 1 AS x FROM room_members WHERE room_id = ? AND user_id = ? AND left_at IS NULL',
      roomId,
      userId,
    );
    if (!member) throw forbidden('You are not in that room.');
  }
  q.run(
    "UPDATE room_rounds SET phase = 'skipped', answer = NULL, completed_at = datetime('now') WHERE id = ?",
    roundId,
  );
  broadcastRoom(roomId, { type: 'round_skipped', roundId });
  return { ok: true };
}

export function endRoom(userId, roomId) {
  const room = q.get('SELECT * FROM rooms WHERE id = ?', roomId);
  if (!room) throw notFound('Room not found.');
  const member = q.get(
    "SELECT * FROM room_members WHERE room_id = ? AND user_id = ? AND left_at IS NULL",
    roomId,
    userId,
  );
  if (!member) throw forbidden('You are not in that room.');
  if (member.role !== 'host') throw forbidden('Only the host can end the room.');
  q.run("UPDATE rooms SET status = 'ended', ended_at = datetime('now') WHERE id = ?", roomId);
  broadcastRoom(roomId, { type: 'room_ended' });
  for (const m of q.all('SELECT user_id FROM room_members WHERE room_id = ?', roomId)) {
    incrementStat(m.user_id, 'games_played');
    checkAchievements(m.user_id);
  }
  return { ok: true };
}

export function listPublicRooms(viewerId) {
  const blocked = blockedUserIds(viewerId);
  const rows = q.all(
    `SELECT r.*, (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id AND m.left_at IS NULL) AS player_count
       FROM rooms r
      WHERE r.visibility = 'public' AND r.status IN ('lobby','active')
      ORDER BY r.updated_at DESC LIMIT 30`,
  );
  return rows
    .filter((r) => !blocked.includes(r.host_user_id))
    .map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      status: r.status,
      playerCount: r.player_count,
      maxPlayers: r.max_players,
      categories: safeJson(r.categories, []),
      createdAt: r.created_at,
    }));
}

export function inviteToRoom(userId, roomId, inviteeId) {
  const room = q.get('SELECT * FROM rooms WHERE id = ?', roomId);
  if (!room) throw notFound('Room not found.');
  const member = q.get(
    'SELECT 1 AS x FROM room_members WHERE room_id = ? AND user_id = ? AND left_at IS NULL',
    roomId,
    userId,
  );
  if (!member) throw forbidden('You are not in that room.');
  if (hasBlocked(inviteeId, userId) || hasBlocked(userId, inviteeId)) {
    throw forbidden('You cannot invite this account.');
  }
  const inviter = q.get('SELECT username FROM users WHERE id = ?', userId);
  notify(inviteeId, {
    kind: 'room_invite',
    title: `${inviter.username} invited you to ${room.name}`,
    body: `Join code: ${room.code}`,
    link: `/rooms?join=${room.code}`,
    data: { roomId, code: room.code, from: userId },
  });
  return { ok: true };
}

/** Live room updates go over the event bus only - never persisted as notifications. */
function broadcastRoom(roomId, payload) {
  const members = q.all('SELECT user_id FROM room_members WHERE room_id = ? AND left_at IS NULL', roomId);
  emitToUsers(
    members.map((m) => m.user_id),
    'room_update',
    { roomId, ...payload },
  );
}

function safeJson(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}
