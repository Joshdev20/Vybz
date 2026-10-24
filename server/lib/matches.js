import { q, transaction } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http.js';
import { assertCanInteract, assertNotRestricted, isBlockedEitherWay } from '../lib/safety.js';
import { gameModule } from '../games/index.js';
import { notify, emitToUsers } from '../lib/events.js';
import {
  awardXp,
  incrementStat,
  recordBestScore,
  updateGameRank,
  touchDailyStreak,
  resetWinStreakIfStale,
  checkAchievements,
  progressChallenges,
  refreshChemistry,
  XP_RULES,
} from '../lib/progression.js';
import { ensureConversation } from '../lib/connections.js';
import { randomId } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';

const ACCEPT_WINDOW_MS = 25_000;

/**
 * Push the current authoritative match state to every participant so open
 * clients react immediately instead of waiting for a poll. Payloads are
 * per-user because each player sees a different private view.
 */
export function broadcastMatch(matchId) {
  const ids = q
    .all('SELECT user_id FROM match_participants WHERE match_id = ?', matchId)
    .map((r) => r.user_id);
  if (!ids.length) return;
  const match = q.get('SELECT public_id FROM matches WHERE id = ?', matchId);
  for (const id of ids) {
    emitToUsers([id], 'match_update', { publicId: match?.public_id, matchId });
  }
}

/* ------------------------------ creation ------------------------------ */

export function createMatch({
  gameKey,
  format = 'classic',
  difficulty = 'standard',
  userIds,
  filters = {},
  totalRounds,
  isRematchOf = null,
}) {
  const mod = gameModule(gameKey);
  if (!mod) throw badRequest('Unsupported game mode.');
  const unique = [...new Set(userIds.map(Number))];
  if (unique.length < 2) throw badRequest('A match needs at least two players.');

  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      if (isBlockedEitherWay(unique[i], unique[j])) {
        throw forbidden('A blocked account cannot be matched with you.');
      }
    }
  }

  const prefs = unique.map((id) => q.get('SELECT allow_ai_judge FROM user_preferences WHERE user_id = ?', id));
  const prefersAi = prefs.every((p) => !p || p.allow_ai_judge === 1);
  const judgedBy = mod.judgedBy({ prefersAi });
  const rounds = totalRounds || mod.totalRounds;

  const publicId = randomId(12);
  const matchId = transaction((db) => {
    const info = db
      .prepare(
        `INSERT INTO matches (public_id, game_key, format, difficulty, status, judged_by, total_rounds, is_rematch_of)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(publicId, gameKey, format, difficulty, judgedBy, rounds, isRematchOf);
    const id = Number(info.lastInsertRowid);
    unique.forEach((uid, idx) => {
      db.prepare('INSERT INTO match_participants (match_id, user_id, slot) VALUES (?, ?, ?)').run(id, uid, idx + 1);
    });
    return id;
  });

  const match = q.get('SELECT * FROM matches WHERE id = ?', matchId);
  for (const uid of unique) {
    notify(uid, {
      kind: 'match_found',
      title: `${mod.name} match found`,
      body: 'Accept within 25 seconds to start playing.',
      link: `/match/${publicId}`,
      data: { matchId, publicId },
    });
  }
  logger.info('match created', { matchId, publicId, gameKey, players: unique });
  return match;
}

/* ------------------------------ access ------------------------------ */

export function matchForUser(matchId, userId) {
  const match = q.get('SELECT * FROM matches WHERE id = ? OR public_id = ?', matchId, String(matchId));
  if (!match) throw notFound('That match could not be found.');
  const participant = q.get(
    'SELECT * FROM match_participants WHERE match_id = ? AND user_id = ?',
    match.id,
    userId,
  );
  if (!participant) throw forbidden('You are not part of this match.');
  return { match, participant };
}

export function participants(matchId) {
  return q.all(
    `SELECT p.*, u.username, u.last_seen_at, pr.display_name, pr.avatar_kind, pr.avatar_value
       FROM match_participants p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN user_profiles pr ON pr.user_id = u.id
      WHERE p.match_id = ? ORDER BY p.slot`,
    matchId,
  );
}

/* --------------------------- acceptance --------------------------- */

export function acceptMatch(matchId, userId) {
  const { match } = matchForUser(matchId, userId);
  if (match.status !== 'pending') throw conflict('This match has already started or ended.');
  if (new Date(match.created_at).getTime() + ACCEPT_WINDOW_MS < Date.now()) {
    abandonMatch(match.id, { reason: 'accept_timeout' });
    throw conflict('The match offer expired because nobody accepted in time.');
  }
  q.run(
    "UPDATE match_participants SET accepted = 1, last_seen_at = datetime('now') WHERE match_id = ? AND user_id = ?",
    match.id,
    userId,
  );
  maybeStartMatch(match.id);
  broadcastMatch(match.id);
  return publicMatchState(match.id, userId);
}

export function declineMatch(matchId, userId) {
  const { match } = matchForUser(matchId, userId);
  if (match.status === 'completed') throw conflict('This match has already finished.');
  q.run('UPDATE match_participants SET declined = 1 WHERE match_id = ? AND user_id = ?', match.id, userId);
  abandonMatch(match.id, { reason: 'declined', actorId: userId });
  broadcastMatch(match.id);
  return { ok: true, status: 'abandoned' };
}

export function maybeStartMatch(matchId) {
  const match = q.get('SELECT * FROM matches WHERE id = ?', matchId);
  if (!match || match.status !== 'pending') return false;
  const parts = q.all('SELECT * FROM match_participants WHERE match_id = ?', matchId);
  if (parts.some((p) => p.declined)) return false;
  if (!parts.every((p) => p.accepted)) return false;

  transaction((db) => {
    db.prepare(
      "UPDATE matches SET status = 'active', started_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'",
    ).run(matchId);
    db.prepare('UPDATE match_participants SET connected = 1 WHERE match_id = ?').run(matchId);
  });
  startRound(matchId, 1);
  broadcastMatch(matchId);
  return true;
}

/* ------------------------------ rounds ------------------------------ */

export function startRound(matchId, roundNumber) {
  const match = q.get('SELECT * FROM matches WHERE id = ?', matchId);
  if (!match || match.status !== 'active') return null;
  const mod = gameModule(match.game_key);
  const existing = q.get(
    'SELECT * FROM game_rounds WHERE match_id = ? AND round_number = ?',
    matchId,
    roundNumber,
  );
  if (existing) return existing;

  const prompt = mod.pickPrompt({ difficulty: match.difficulty, categories: [] });
  if (!prompt) {
    completeMatch(matchId, { reason: 'no_prompts' });
    return null;
  }
  const seconds = prompt.round_seconds || mod.roundSeconds;
  const deadline = new Date(Date.now() + seconds * 1000).toISOString();

  const roundId = transaction((db) => {
    const info = db
      .prepare(
        `INSERT INTO game_rounds (match_id, round_number, prompt_id, prompt_text, phase, round_seconds, submission_deadline)
         VALUES (?, ?, ?, ?, 'submitting', ?, ?)`,
      )
      .run(matchId, roundNumber, prompt.id, prompt.text, seconds, deadline);
    db.prepare("UPDATE matches SET current_round = ?, updated_at = datetime('now') WHERE id = ?").run(
      roundNumber,
      matchId,
    );
    return Number(info.lastInsertRowid);
  });
  return q.get('SELECT * FROM game_rounds WHERE id = ?', roundId);
}

export function submitAnswer(matchId, userId, body) {
  assertNotRestricted(userId, 'submit answers');
  const { match } = matchForUser(matchId, userId);
  if (match.status !== 'active') throw conflict('This match is not active.');
  const round = q.get(
    'SELECT * FROM game_rounds WHERE match_id = ? AND round_number = ?',
    match.id,
    match.current_round,
  );
  if (!round) throw conflict('There is no active round right now.');
  if (round.phase !== 'submitting') throw conflict('Submissions for this round are closed.');

  const text = String(body || '').trim();
  if (text.length < 2) throw badRequest('Write a little more than that.');
  if (text.length > 500) throw badRequest('Keep it under 500 characters.');

  // Server-side deadline check: the client clock is never trusted.
  if (new Date(round.submission_deadline) < new Date()) {
    advanceIfReady(round.id);
    throw conflict('Time is up for this round.');
  }

  const mod = gameModule(match.game_key);
  const judge = mod.scoreSubmission ? mod.scoreSubmission(round.prompt_text, text) : null;

  try {
    q.run(
      `INSERT INTO round_submissions (round_id, user_id, body, judge_score, judge_source, judge_notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      round.id,
      userId,
      text,
      judge?.score ?? null,
      judge?.source ?? null,
      // Stored in the same JSON shape as the automated path so the rubric
      // breakdown survives peer-voted rounds too.
      judge ? JSON.stringify({ notes: judge.notes || null, breakdown: judge.breakdown || null }) : null,
    );
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw conflict('You have already submitted this round.');
    throw err;
  }

  recordBestScore(userId, judge?.score ?? 0);
  advanceIfReady(round.id);
  broadcastMatch(match.id);
  return { ok: true, roundId: round.id };
}

/** Move to voting/reveal once every participant has submitted (or time is up). */
export function advanceIfReady(roundId, { force = false } = {}) {
  const round = q.get('SELECT * FROM game_rounds WHERE id = ?', roundId);
  if (!round || round.phase !== 'submitting') return false;
  const parts = q.all('SELECT * FROM match_participants WHERE match_id = ?', round.match_id);
  const subs = q.all('SELECT * FROM round_submissions WHERE round_id = ?', roundId);
  const allIn = parts.length > 0 && subs.length >= parts.length;
  const expired = new Date(round.submission_deadline) < new Date();
  if (!allIn && !expired && !force) return false;

  const match = q.get('SELECT * FROM matches WHERE id = ?', round.match_id);
  const mod = gameModule(match.game_key);

  if (match.judged_by === 'ai') {
    // Automated judging runs asynchronously; the round is revealed when it returns.
    q.run("UPDATE game_rounds SET phase = 'voting' WHERE id = ?", roundId);
    broadcastMatch(round.match_id);
    runAutomatedScoring(roundId).catch((err) =>
      logger.error('scoring failed, falling back to peer resolution', {
        roundId,
        error: err.message,
      }),
    );
    return true;
  }

  if (mod.voteSeconds > 0 && subs.length >= 2) {
    const deadline = new Date(Date.now() + mod.voteSeconds * 1000).toISOString();
    q.run("UPDATE game_rounds SET phase = 'voting', voting_deadline = ? WHERE id = ?", deadline, roundId);
    broadcastMatch(round.match_id);
    return true;
  }
  scoreRoundWithPeerRules(roundId);
  broadcastMatch(round.match_id);
  return true;
}

async function runAutomatedScoring(roundId) {
  const round = q.get('SELECT * FROM game_rounds WHERE id = ?', roundId);
  if (!round) return;
  try {
    const match = q.get('SELECT * FROM matches WHERE id = ?', round.match_id);
    const mod = gameModule(match.game_key);
    const subs = q.all('SELECT * FROM round_submissions WHERE round_id = ?', roundId);
    const outcome = await mod.resolveAutomated({ submissions: subs, prompt: round.prompt_text });
    applyRoundOutcome(round, outcome);
    broadcastMatch(round.match_id);
  } catch (err) {
    // Never leave a round stuck: fall back to the peer/vote rules.
    logger.warn('automated scoring failed; using fallback rules', { roundId, error: err.message });
    const match = q.get('SELECT * FROM matches WHERE id = ?', round.match_id);
    const mod = gameModule(match.game_key);
    const subs = q.all('SELECT * FROM round_submissions WHERE round_id = ?', roundId);
    const votes = q.all('SELECT * FROM round_votes WHERE round_id = ?', roundId);
    applyRoundOutcome(round, mod.resolveRound({ submissions: subs, votes }));
    broadcastMatch(round.match_id);
  }
}

export function castVote(matchId, userId, targetUserId) {
  const { match } = matchForUser(matchId, userId);
  if (match.status !== 'active') throw conflict('This match is not active.');
  const round = q.get(
    'SELECT * FROM game_rounds WHERE match_id = ? AND round_number = ?',
    match.id,
    match.current_round,
  );
  if (!round) throw conflict('There is no active round.');
  if (round.phase !== 'voting') throw conflict('Voting is not open for this round.');
  if (round.voting_deadline && new Date(round.voting_deadline) < new Date()) {
    finaliseVoting(round.id);
    throw conflict('Voting has closed for this round.');
  }
  // Self-voting is impossible: rejected before any database write.
  if (Number(userId) === Number(targetUserId)) throw forbidden('You cannot vote for yourself.');

  const participantIds = q
    .all('SELECT user_id FROM match_participants WHERE match_id = ?', match.id)
    .map((p) => p.user_id);
  if (!participantIds.includes(Number(targetUserId))) throw badRequest('That player is not in this match.');
  const targetSub = q.get(
    'SELECT * FROM round_submissions WHERE round_id = ? AND user_id = ?',
    round.id,
    targetUserId,
  );
  if (!targetSub) throw badRequest('That player did not submit this round.');

  try {
    q.run(
      'INSERT INTO round_votes (round_id, voter_user_id, target_user_id) VALUES (?, ?, ?)',
      round.id,
      userId,
      targetUserId,
    );
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw conflict('You have already voted this round.');
    throw err;
  }

  const votes = q.all('SELECT * FROM round_votes WHERE round_id = ?', round.id);
  const eligible = participantIds.filter((p) =>
    q.get('SELECT 1 AS x FROM round_submissions WHERE round_id = ? AND user_id = ?', round.id, p),
  );
  if (votes.length >= eligible.length) finaliseVoting(round.id);
  broadcastMatch(match.id);
  return { ok: true };
}

export function finaliseVoting(roundId) {
  const round = q.get('SELECT * FROM game_rounds WHERE id = ?', roundId);
  if (!round || round.phase !== 'voting') return false;
  const match = q.get('SELECT * FROM matches WHERE id = ?', round.match_id);
  const mod = gameModule(match.game_key);
  const subs = q.all('SELECT * FROM round_submissions WHERE round_id = ?', roundId);
  const votes = q.all('SELECT * FROM round_votes WHERE round_id = ?', roundId);
  applyRoundOutcome(round, mod.resolveRound({ submissions: subs, votes }));
  broadcastMatch(round.match_id);
  return true;
}

function scoreRoundWithPeerRules(roundId) {
  const round = q.get('SELECT * FROM game_rounds WHERE id = ?', roundId);
  if (!round) return;
  const match = q.get('SELECT * FROM matches WHERE id = ?', round.match_id);
  const mod = gameModule(match.game_key);
  const subs = q.all('SELECT * FROM round_submissions WHERE round_id = ?', roundId);
  const votes = q.all('SELECT * FROM round_votes WHERE round_id = ?', roundId);
  applyRoundOutcome(round, mod.resolveRound({ submissions: subs, votes }));
}

/** Single place where round results are written and points are awarded. */
function applyRoundOutcome(round, outcome) {
  const match = q.get('SELECT * FROM matches WHERE id = ?', round.match_id);
  transaction((db) => {
    for (const r of outcome.results) {
      // Idempotent: a round scores once per user/reason, so replays cannot double-count.
      db.prepare(
        `INSERT OR IGNORE INTO game_results (match_id, round_id, user_id, points, reason)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(round.match_id, round.id, r.userId, r.points, r.reason);
      db.prepare(
        'UPDATE match_participants SET score = score + ?, xp_awarded = xp_awarded + ? WHERE match_id = ? AND user_id = ?',
      ).run(r.points, r.points, round.match_id, r.userId);
    }
    if (outcome.judged) {
      for (const j of outcome.judged) {
        // Store the rubric breakdown as JSON so the UI can show how a score was
        // reached, while keeping the human-readable note alongside it.
        db.prepare(
          'UPDATE round_submissions SET judge_score = ?, judge_source = ?, judge_notes = ? WHERE id = ?',
        ).run(
          j.score,
          j.source,
          JSON.stringify({ notes: j.notes || null, breakdown: j.breakdown || null }),
          j.submissionId,
        );
      }
    }
    db.prepare("UPDATE game_rounds SET phase = 'scored', scored_at = datetime('now') WHERE id = ?").run(round.id);
  });
  broadcastMatch(round.match_id);

  for (const r of outcome.results) {
    incrementStat(r.userId, 'rounds_played');
    if (r.reason === 'round_win') incrementStat(r.userId, 'rounds_won');
    awardXp(r.userId, XP_RULES.round_submitted, 'round_submitted', `round:${round.id}:${r.userId}:submit`);
    if (r.reason === 'round_win') {
      awardXp(r.userId, XP_RULES.round_won, 'round_won', `round:${round.id}:${r.userId}:win`);
    }
    progressChallenges(r.userId, 'rounds_played', 1);
    notify(
      r.userId,
      {
        kind: 'result',
        title: `Round ${round.round_number} scored`,
        body: `You earned ${r.points} points this round.`,
        link: `/match/${match.public_id}`,
        data: { matchId: match.id, roundId: round.id, round: round.round_number },
      },
      { dedupe: false },
    );
  }

  const nextRound = round.round_number + 1;
  if (nextRound <= match.total_rounds) {
    setTimeout(() => {
      const current = q.get('SELECT * FROM matches WHERE id = ?', match.id);
      if (current && current.status === 'active') {
        startRound(match.id, nextRound);
      }
    }, 3500);
  } else {
    completeMatch(match.id, { reason: 'rounds_complete' });
  }
}

/* --------------------------- completion --------------------------- */

export function completeMatch(matchId, { reason = 'rounds_complete' } = {}) {
  const match = q.get('SELECT * FROM matches WHERE id = ?', matchId);
  if (!match || match.status === 'completed') return;
  const parts = q.all(
    'SELECT * FROM match_participants WHERE match_id = ? ORDER BY score DESC, slot ASC',
    matchId,
  );
  const top = parts[0];
  const tied = parts.filter((p) => p.score === top.score);
  const winner = tied.length === 1 ? top.user_id : null;

  transaction((db) => {
    db.prepare(
      "UPDATE matches SET status = 'completed', ended_at = datetime('now'), winner_user_id = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(winner, matchId);
    for (const p of parts) {
      const result = winner === null ? 'draw' : p.user_id === winner ? 'win' : 'loss';
      db.prepare('UPDATE match_participants SET result = ? WHERE id = ?').run(result, p.id);
    }
  });

  const today = new Date().toISOString().slice(0, 10);
  for (const p of parts) {
    const result = winner === null ? 'draw' : p.user_id === winner ? 'win' : 'loss';
    resetWinStreakIfStale(p.user_id, today);
    incrementStat(p.user_id, 'games_played');
    touchDailyStreak(p.user_id, today);
    awardXp(p.user_id, XP_RULES.match_completed, 'match_completed', `match:${matchId}:${p.user_id}:complete`);
    progressChallenges(p.user_id, 'matches_played', 1);

    let ratingDelta = 0;
    if (result === 'win') {
      incrementStat(p.user_id, 'games_won');
      q.run(
        'UPDATE player_statistics SET current_streak = current_streak + 1, longest_streak = MAX(longest_streak, current_streak + 1) WHERE user_id = ?',
        p.user_id,
      );
      awardXp(p.user_id, XP_RULES.match_won, 'match_won', `match:${matchId}:${p.user_id}:win`);
      progressChallenges(p.user_id, 'games_won', 1);
      ratingDelta = 25;
    } else if (result === 'draw') {
      incrementStat(p.user_id, 'games_drawn');
      awardXp(p.user_id, XP_RULES.match_drawn, 'match_drawn', `match:${matchId}:${p.user_id}:draw`);
      ratingDelta = 5;
    } else {
      q.run('UPDATE player_statistics SET current_streak = 0 WHERE user_id = ?', p.user_id);
      ratingDelta = -15;
    }
    updateGameRank(p.user_id, match.game_key, {
      ratingDelta,
      win: result === 'win',
      loss: result === 'loss',
      draw: result === 'draw',
      bestScore: p.score,
    });
    checkAchievements(p.user_id);
    notify(p.user_id, {
      kind: 'result',
      title: `Match ${result === 'win' ? 'won' : result === 'draw' ? 'drawn' : 'lost'}`,
      body: `Final score ${p.score}.`,
      link: `/match/${match.public_id}`,
      data: { matchId, result },
    });
  }

  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      refreshChemistry(parts[i].user_id, parts[j].user_id);
    }
  }
  logger.info('match completed', { matchId, winner, reason });
}

export function abandonMatch(matchId, { reason = 'abandoned', actorId = null } = {}) {
  const match = q.get('SELECT * FROM matches WHERE id = ?', matchId);
  if (!match || ['completed', 'abandoned', 'expired'].includes(match.status)) return;
  const parts = q.all('SELECT * FROM match_participants WHERE match_id = ?', matchId);

  transaction((db) => {
    db.prepare(
      "UPDATE matches SET status = 'abandoned', ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    ).run(matchId);
    for (const p of parts) {
      const result = actorId && p.user_id === actorId ? 'abandoned' : 'draw';
      db.prepare('UPDATE match_participants SET result = ? WHERE id = ?').run(result, p.id);
    }
    db.prepare("UPDATE matchmaking_queue SET status = 'cancelled' WHERE match_id = ?").run(matchId);
  });

  for (const p of parts) {
    if (actorId && p.user_id === actorId) continue;
    notify(p.user_id, {
      kind: 'result',
      title: 'Match ended early',
      body:
        reason === 'declined'
          ? 'The other player declined, so no result was recorded.'
          : reason === 'accept_timeout'
            ? 'Nobody accepted in time, so the match was cancelled. No points were lost.'
            : 'The match ended early. No points were lost.',
      link: '/play',
      data: { matchId, reason },
    });
  }
  logger.info('match abandoned', { matchId, reason, actorId });
}

/** Reconnect support: return the latest valid state for a player. */
export function publicMatchState(matchIdOrPublic, userId) {
  const { match, participant } = matchForUser(matchIdOrPublic, userId);
  const mod = gameModule(match.game_key);
  const parts = participants(match.id);
  const rounds = q.all('SELECT * FROM game_rounds WHERE match_id = ? ORDER BY round_number', match.id);
  const currentRound =
    rounds.find((r) => r.round_number === match.current_round) || rounds[rounds.length - 1] || null;

  let roundView = null;
  if (currentRound) {
    const subs = q.all(
      'SELECT s.*, u.username FROM round_submissions s JOIN users u ON u.id = s.user_id WHERE s.round_id = ?',
      currentRound.id,
    );
    const votes = q.all('SELECT * FROM round_votes WHERE round_id = ?', currentRound.id);
    const revealed = currentRound.phase === 'scored';
    const mySubmission = subs.find((s) => s.user_id === userId) || null;
    const myVote = votes.find((v) => v.voter_user_id === userId) || null;
    const voteCounts = {};
    for (const v of votes) voteCounts[v.target_user_id] = (voteCounts[v.target_user_id] || 0) + 1;

    roundView = {
      id: currentRound.id,
      roundNumber: currentRound.round_number,
      totalRounds: match.total_rounds,
      prompt: currentRound.prompt_text,
      phase: currentRound.phase,
      roundSeconds: currentRound.round_seconds,
      startedAt: currentRound.started_at,
      submissionDeadline: currentRound.submission_deadline,
      votingDeadline: currentRound.voting_deadline,
      mySubmission: mySubmission ? { body: mySubmission.body, at: mySubmission.submitted_at } : null,
      myVote: myVote ? myVote.target_user_id : null,
      // Before reveal, submissions are only acknowledged - never leaked.
      submissions: revealed
        ? subs.map((s) => ({
            userId: s.user_id,
            username: s.username,
            body: s.body,
            judgeScore: s.judge_score,
            judgeSource: s.judge_source,
            judgeNotes: s.judge_notes,
            votes: voteCounts[s.user_id] || 0,
          }))
        : subs.map((s) => ({
            userId: s.user_id,
            username: s.username,
            submitted: true,
            isMe: s.user_id === userId,
          })),
      results: revealed
        ? q.all(
            'SELECT user_id, points, reason FROM game_results WHERE round_id = ? ORDER BY points DESC',
            currentRound.id,
          )
        : [],
    };
  }

  let outcome = null;
  if (match.status === 'completed') {
    const otherId = parts.find((p) => p.user_id !== userId)?.user_id;
    outcome = {
      winner: match.winner_user_id,
      participants: parts.map((p) => ({
        userId: p.user_id,
        username: p.username,
        score: p.score,
        result: p.result,
        isMe: p.user_id === userId,
      })),
      canRematch: true,
      canConnect: otherId ? !isBlockedEitherWay(userId, otherId) : false,
    };
  }

  const other = parts.find((p) => p.user_id !== userId);
  return {
    match: {
      id: match.id,
      publicId: match.public_id,
      gameKey: match.game_key,
      gameName: mod?.name || match.game_key,
      status: match.status,
      judgedBy: match.judged_by,
      difficulty: match.difficulty,
      format: match.format,
      currentRound: match.current_round,
      totalRounds: match.total_rounds,
      createdAt: match.created_at,
      startedAt: match.started_at,
      endedAt: match.ended_at,
      myScore: participant.score,
      myResult: participant.result,
      myAccepted: Boolean(participant.accepted),
      myDeclined: Boolean(participant.declined),
      opponent: other
        ? {
            userId: other.user_id,
            username: other.username,
            displayName: other.display_name,
            avatarKind: other.avatar_kind,
            avatarValue: other.avatar_value,
            score: other.score,
            accepted: Boolean(other.accepted),
            declined: Boolean(other.declined),
            result: other.result,
          }
        : null,
      judgeNote:
        match.judged_by === 'ai'
          ? 'Automated judging is active. Scores come from the documented rubric.'
          : null,
    },
    round: roundView,
    outcome,
    roundHistory: rounds.map((r) => ({
      roundNumber: r.round_number,
      phase: r.phase,
      prompt: r.prompt_text,
    })),
  };
}

/** Find (or create) the match conversation once a player opts in. */
export function connectAfterMatch(matchId, userId) {
  const { match } = matchForUser(matchId, userId);
  if (match.status !== 'completed') throw conflict('You can only connect after a completed match.');
  const other = q.get(
    'SELECT user_id FROM match_participants WHERE match_id = ? AND user_id <> ?',
    match.id,
    userId,
  );
  if (!other) throw notFound('No other player in this match.');
  assertCanInteract(userId, other.user_id, { context: 'connection' });
  const conversationId = transaction((db) => ensureConversation(db, userId, other.user_id, 'match'));
  return { conversationId };
}

export function rematch(matchId, userId, { invite = false } = {}) {
  const { match } = matchForUser(matchId, userId);
  if (match.status !== 'completed') throw conflict('You can only request a rematch after a match ends.');
  const others = q
    .all('SELECT user_id FROM match_participants WHERE match_id = ? AND user_id <> ?', match.id, userId)
    .map((r) => r.user_id);
  if (!others.length) throw notFound('No opponent to rematch with.');
  for (const otherId of others) {
    assertCanInteract(userId, otherId, { context: 'rematch' });
  }
  if (invite) {
    for (const otherId of others) {
      const sender = q.get('SELECT username FROM users WHERE id = ?', userId);
      notify(otherId, {
        kind: 'challenge',
        title: 'Rematch challenge',
        body: `${sender.username} wants a rematch in ${match.game_key.replace('_', ' ')}.`,
        link: `/match/${match.public_id}`,
        data: { matchId: match.id, from: userId },
      });
    }
    return { invited: true };
  }
  const newMatch = createMatch({
    gameKey: match.game_key,
    format: match.format,
    difficulty: match.difficulty,
    userIds: [userId, ...others],
    isRematchOf: match.id,
  });
  // Mirror the camelCase shape used by the rest of the match API rather than
  // leaking the raw database row.
  return {
    match: {
      id: newMatch.id,
      publicId: newMatch.public_id,
      gameKey: newMatch.game_key,
      format: newMatch.format,
      difficulty: newMatch.difficulty,
      status: newMatch.status,
      judgedBy: newMatch.judged_by,
      totalRounds: newMatch.total_rounds,
      isRematchOf: newMatch.is_rematch_of,
    },
  };
}
