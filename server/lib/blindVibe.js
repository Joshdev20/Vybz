import { q, transaction } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from './http.js';
import { assertCanInteract, assertNotRestricted, isBlockedEitherWay, screenText } from './safety.js';
import { notify, emitToUser } from './events.js';
import { randomId } from './crypto.js';
import { ensureConversation, getConnection, sendConnectionRequest } from './connections.js';
import { refreshChemistry } from './progression.js';
import { enforce } from './rateLimit.js';
import { logger } from './logger.js';

/**
 * Blind Vibe - staged discovery with mutually-consensual reveals.
 *
 * Privacy rules:
 *  - photos, region and contact details stay hidden until stage 3 AND mutual interest
 *  - a one-sided "yes" is stored but never disclosed to the other player
 *  - either player can exit at any stage
 */

export const STAGES = [
  { stage: 1, label: 'Icebreaker', description: 'A light question to break the ice.' },
  { stage: 2, label: 'Deeper', description: 'Something with a bit more substance.' },
  { stage: 3, label: 'Values', description: 'What you actually care about.' },
  { stage: 4, label: 'Choose', description: 'Decide privately whether to reveal more.' },
];

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function createSession(userAId, userBId) {
  assertCanInteract(userAId, userBId, { context: 'blind_vibe' });
  const [a, b] = Number(userAId) < Number(userBId) ? [Number(userAId), Number(userBId)] : [Number(userBId), Number(userAId)];
  const existing = q.get(
    "SELECT * FROM blind_vibe_sessions WHERE user_a_id = ? AND user_b_id = ? AND status = 'active'",
    a,
    b,
  );
  if (existing) return publicSession(existing.id, userAId);

  const publicId = randomId(12);
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const info = q.run(
    `INSERT INTO blind_vibe_sessions (public_id, user_a_id, user_b_id, stage, status, expires_at)
     VALUES (?, ?, ?, 1, 'active', ?)`,
    publicId,
    a,
    b,
    expires,
  );
  const id = Number(info.lastInsertRowid);
  const conv = transaction((db) => ensureConversation(db, a, b, 'direct'));
  q.run('UPDATE blind_vibe_sessions SET conversation_id = ? WHERE id = ?', conv, id);
  for (const uid of [a, b]) {
    notify(uid, {
      kind: 'match_found',
      title: 'Blind Vibe match found',
      body: 'Start with the icebreaker. Profiles stay private for now.',
      link: `/blind-vibe/${publicId}`,
      data: { sessionId: id, publicId },
    });
  }
  logger.info('blind vibe session created', { id, a, b });
  return publicSession(id, userAId);
}

export function sessionForUser(sessionIdOrPublic, userId) {
  const session = q.get(
    'SELECT * FROM blind_vibe_sessions WHERE id = ? OR public_id = ?',
    sessionIdOrPublic,
    String(sessionIdOrPublic),
  );
  if (!session) throw notFound('That Blind Vibe session could not be found.');
  if (session.user_a_id !== userId && session.user_b_id !== userId) {
    throw forbidden('You are not part of this session.');
  }
  return session;
}

export function promptForStage(stage) {
  const catKey = ['icebreaker', 'icebreaker', 'deeper', 'values'][Math.min(stage, 3)] || 'icebreaker';
  const cat = q.get("SELECT id FROM prompt_categories WHERE game_key = 'blind_vibe' AND key = ?", catKey);
  const prompt = cat
    ? q.get(
        'SELECT * FROM game_prompts WHERE game_key = ? AND category_id = ? AND enabled = 1 ORDER BY RANDOM() LIMIT 1',
        'blind_vibe',
        cat.id,
      )
    : null;
  return prompt?.text || 'Tell them one thing about your week.';
}

/** The session view masks profile data until consent is mutual. */
export function publicSession(sessionId, viewerId) {
  const session = sessionForUser(sessionId, viewerId);
  const otherId = session.user_a_id === viewerId ? session.user_b_id : session.user_a_id;
  const myInterest = session.user_a_id === viewerId ? session.a_interested : session.b_interested;
  const theirInterest = session.user_a_id === viewerId ? session.b_interested : session.a_interested;

  const revealed = session.status === 'revealed';
  const otherProfile = q.get(
    `SELECT u.username, p.display_name, p.bio, p.avatar_kind, p.avatar_value, p.region, p.show_region, p.languages
       FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.id = ?`,
    otherId,
  );
  const sharedInterests = q.all(
    `SELECT i.label FROM user_interests ui1
       JOIN user_interests ui2 ON ui2.interest_id = ui1.interest_id
       JOIN interests i ON i.id = ui1.interest_id
      WHERE ui1.user_id = ? AND ui2.user_id = ?`,
    viewerId,
    otherId,
  ).map((r) => r.label);

  // Past sessions list needs an "active" filter on status values it stores.
  const convo = session.conversation_id;
  const messages = convo
    ? q.all(
        `SELECT m.id, m.sender_user_id, m.body, m.created_at
           FROM messages m
          WHERE m.conversation_id = ? AND m.moderation_status <> 'rejected'
          ORDER BY m.created_at ASC LIMIT 100`,
        convo,
      )
    : [];

  return {
    session: {
      id: session.id,
      publicId: session.public_id,
      stage: session.stage,
      stageLabel: STAGES.find((s) => s.stage === session.stage)?.label || 'Choose',
      stageDescription: STAGES.find((s) => s.stage === session.stage)?.description || '',
      status: session.status,
      expiresAt: session.expires_at,
      conversationId: convo,
      // Never disclose the other person's choice on its own: exposing that a
      // choice was made would effectively reveal a one-sided "yes".
      myInterest: myInterest === null ? null : Boolean(myInterest),
      isMutual: Boolean(myInterest) && Boolean(theirInterest),
      prompt: promptForStage(session.stage),
    },
    sharedInterests: sharedInterests.map((label) => ({ label })),
    // Identity fields are withheld until a mutual reveal happens.
    other: revealed
      ? {
          userId: otherId,
          username: otherProfile.username,
          displayName: otherProfile.display_name,
          bio: otherProfile.bio,
          avatarKind: otherProfile.avatar_kind,
          avatarValue: otherProfile.avatar_value,
          region: otherProfile.show_region ? otherProfile.region : null,
        }
      : {
          userId: null,
          username: 'Mystery player',
          displayName: null,
          bio: null,
          avatarKind: 'preset',
          avatarValue: 'mystery',
          region: null,
        },
    messages: messages.map((m) => ({
      id: m.id,
      mine: m.sender_user_id === viewerId,
      body: m.body,
      at: m.created_at,
    })),
    stages: STAGES,
  };
}

export function sendMessage(sessionId, userId, body) {
  assertNotRestricted(userId, 'send messages');
  const session = sessionForUser(sessionId, userId);
  if (session.status === 'ended' || session.status === 'expired') {
    throw conflict('This session has ended.');
  }
  const otherId = session.user_a_id === userId ? session.user_b_id : session.user_a_id;
  if (isBlockedEitherWay(userId, otherId)) throw forbidden('This session is no longer available.');

  enforce('blind_message', userId, 60, 60 * 1000);
  const text = String(body || '').trim();
  if (!text) throw badRequest('Type a message first.');
  if (text.length > 600) throw badRequest('Keep messages under 600 characters.');
  const verdict = screenText(text);
  if (!verdict.allowed) throw badRequest(verdict.reason || 'That message is not allowed.');

  const info = q.run(
    'INSERT INTO messages (conversation_id, sender_user_id, body, moderation_status) VALUES (?, ?, ?, ?)',
    session.conversation_id,
    userId,
    text,
    verdict.status,
  );
  q.run("UPDATE conversations SET last_message_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", session.conversation_id);
  emitToUser(otherId, 'blind_message', {
    sessionId: session.id,
    publicId: session.public_id,
    message: { id: Number(info.lastInsertRowid), body: text, at: new Date().toISOString() },
  });
  return { ok: true, id: Number(info.lastInsertRowid) };
}

export function advanceStage(sessionId, userId) {
  const session = sessionForUser(sessionId, userId);
  if (session.status !== 'active') throw conflict('This session is not active.');
  if (session.stage >= 4) throw conflict('You are already at the final stage.');
  q.run(
    "UPDATE blind_vibe_sessions SET stage = stage + 1, updated_at = datetime('now') WHERE id = ?",
    session.id,
  );
  const updated = q.get('SELECT * FROM blind_vibe_sessions WHERE id = ?', session.id);
  const otherId = session.user_a_id === userId ? session.user_b_id : session.user_a_id;
  emitToUser(otherId, 'blind_stage', { sessionId: session.id, stage: updated.stage });
  return { stage: updated.stage };
}

/** Express (or change) private interest. Never disclosed unless mutual. */
export function expressInterest(sessionId, userId, interested) {
  const session = sessionForUser(sessionId, userId);
  if (session.status === 'ended') throw conflict('This session has ended.');
  const isA = session.user_a_id === userId;
  const column = isA ? 'a_interested' : 'b_interested';
  q.run(
    `UPDATE blind_vibe_sessions SET ${column} = ?, updated_at = datetime('now') WHERE id = ?`,
    interested ? 1 : 0,
    session.id,
  );
  const updated = q.get('SELECT * FROM blind_vibe_sessions WHERE id = ?', session.id);
  const mutual = Boolean(updated.a_interested) && Boolean(updated.b_interested);

  if (mutual) {
    const a = updated.user_a_id;
    const b = updated.user_b_id;
    transaction((db) => {
      db.prepare("UPDATE blind_vibe_sessions SET status = 'revealed', updated_at = datetime('now') WHERE id = ?").run(
        session.id,
      );
    });
    if (!getConnection(a, b)) {
      try {
        sendConnectionRequest(a, b, { source: 'blind_vibe', contextId: updated.public_id });
      } catch (err) {
        logger.warn('blind vibe connection request skipped', { error: err.message });
      }
    }
    refreshChemistry(a, b);
    for (const uid of [a, b]) {
      notify(uid, {
        kind: 'connection_accepted',
        title: 'It is mutual',
        body: 'You both want to keep talking. Profiles are now visible to each other.',
        link: `/blind-vibe/${updated.public_id}`,
        isPrivate: true,
        data: { sessionId: session.id },
      });
    }
    logger.info('blind vibe revealed', { sessionId: session.id });
    return { mutual: true, revealed: true };
  }

  // One-sided interest: the other player is told nothing about your choice.
  if (!interested) {
    q.run("UPDATE blind_vibe_sessions SET status = 'ended', updated_at = datetime('now') WHERE id = ?", session.id);
    return { mutual: false, ended: true };
  }
  return { mutual: false };
}

export function endSession(sessionId, userId) {
  const session = sessionForUser(sessionId, userId);
  q.run("UPDATE blind_vibe_sessions SET status = 'ended', updated_at = datetime('now') WHERE id = ?", session.id);
  const otherId = session.user_a_id === userId ? session.user_b_id : session.user_a_id;
  notify(otherId, {
    kind: 'result',
    title: 'Blind Vibe session ended',
    body: 'The other player ended the session. No reason is shared.',
    link: '/play',
    data: { sessionId: session.id },
  });
  return { ok: true };
}

export function listMySessions(userId) {
  const rows = q.all(
    `SELECT * FROM blind_vibe_sessions
      WHERE (user_a_id = ? OR user_b_id = ?) AND status IN ('active','revealed')
      ORDER BY updated_at DESC LIMIT 20`,
    userId,
    userId,
  );
  return rows.map((r) => {
    const otherId = r.user_a_id === userId ? r.user_b_id : r.user_a_id;
    const myInterest = r.user_a_id === userId ? r.a_interested : r.b_interested;
    const theirInterest = r.user_a_id === userId ? r.b_interested : r.a_interested;
    const revealed = r.status === 'revealed';
    const profile = revealed
      ? q.get(
          `SELECT u.username, p.display_name, p.avatar_kind, p.avatar_value
             FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.id = ?`,
          otherId,
        )
      : null;
    return {
      id: r.id,
      publicId: r.public_id,
      stage: r.stage,
      totalStages: STAGES.length,
      status: r.status,
      isMutual: Boolean(myInterest) && Boolean(theirInterest),
      myInterest: myInterest === null ? null : Boolean(myInterest),
      updatedAt: r.updated_at,
      // Identity is only populated after a mutual reveal.
      other: revealed
        ? {
            userId: otherId,
            username: profile.username,
            displayName: profile.display_name,
            avatarKind: profile.avatar_kind,
            avatarValue: profile.avatar_value,
            revealed: true,
          }
        : { userId: null, username: 'Mystery player', displayName: null, avatarValue: 'mystery', revealed: false },
    };
  });
}

export function expireStaleSessions() {
  const stale = q.all(
    "SELECT id FROM blind_vibe_sessions WHERE status = 'active' AND expires_at <= datetime('now')",
  );
  for (const s of stale) {
    q.run("UPDATE blind_vibe_sessions SET status = 'expired' WHERE id = ?", s.id);
  }
  return stale.length;
}
