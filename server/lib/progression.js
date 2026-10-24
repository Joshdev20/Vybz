import { q, transaction } from '../db/index.js';
import { logger } from './logger.js';
import { notify } from './events.js';

/** Cumulative XP needed to reach a given level (level 1 = 0 XP). */
export function xpForLevel(level) {
  return 50 * (level - 1) * level;
}

export function levelForXp(xp) {
  let level = 1;
  while (xpForLevel(level + 1) <= xp && level < 200) level += 1;
  return level;
}

export function levelProgress(xp) {
  const level = levelForXp(xp);
  const base = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const span = Math.max(1, next - base);
  return {
    level,
    xp,
    levelStartXp: base,
    nextLevelXp: next,
    intoLevel: xp - base,
    levelSpan: span,
    percent: Math.min(100, Math.round(((xp - base) / span) * 100)),
  };
}

/** XP awarded per real game event. Never for spam or repeated low-quality actions. */
export const XP_RULES = {
  round_submitted: 5,
  round_won: 15,
  match_completed: 20,
  match_won: 50,
  match_drawn: 25,
  signal_sent: 3,
  signal_mutual: 20,
  connection_made: 25,
  challenge_completed: 0, // uses the challenge's own reward
};

/**
 * Award XP exactly once per logical event. `eventKey` is a unique idempotency
 * key, so retries and duplicate socket messages cannot double-award.
 */
export function awardXp(userId, amount, reason, eventKey, metadata = {}) {
  if (!amount) return { awarded: 0, levelUp: false };
  return transaction((db) => {
    if (eventKey) {
      const existing = db
        .prepare('SELECT id FROM experience_transactions WHERE user_id = ? AND event_key = ?')
        .get(userId, eventKey);
      if (existing) return { awarded: 0, levelUp: false, duplicate: true };
    }
    const before = db.prepare('SELECT xp, level FROM player_statistics WHERE user_id = ?').get(userId);
    if (!before) db.prepare('INSERT INTO player_statistics (user_id) VALUES (?)').run(userId);
    db.prepare(
      'INSERT INTO experience_transactions (user_id, amount, reason, event_key, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run(userId, amount, reason, eventKey || null, JSON.stringify(metadata));
    const prevXp = before?.xp || 0;
    const newXp = prevXp + amount;
    const newLevel = levelForXp(newXp);
    db.prepare(
      "UPDATE player_statistics SET xp = ?, level = ?, updated_at = datetime('now') WHERE user_id = ?",
    ).run(newXp, newLevel, userId);
    const levelUp = newLevel > (before?.level || 1);
    return { awarded: amount, xp: newXp, level: newLevel, levelUp };
  });
}

export function incrementStat(userId, field, by = 1) {
  const allowed = new Set([
    'games_played',
    'games_won',
    'games_drawn',
    'rounds_played',
    'rounds_won',
    'signals_received',
    'signals_mutual',
    'connections_count',
  ]);
  if (!allowed.has(field)) throw new Error(`Unknown statistic: ${field}`);
  q.run('INSERT INTO player_statistics (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING', userId);
  q.run(
    `UPDATE player_statistics SET ${field} = ${field} + ?, updated_at = datetime('now') WHERE user_id = ?`,
    by,
    userId,
  );
}

export function recordBestScore(userId, score) {
  q.run('INSERT INTO player_statistics (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING', userId);
  q.run(
    `UPDATE player_statistics
        SET best_round_score = MAX(best_round_score, ?), updated_at = datetime('now')
      WHERE user_id = ?`,
    score,
    userId,
  );
}

export function updateGameRank(userId, gameKey, { ratingDelta = 0, win, loss, draw, bestScore }) {
  q.run(
    `INSERT INTO game_ranks (user_id, game_key, rating, wins, losses, draws, best_score)
     VALUES (?, ?, ?, 0, 0, 0, 0)
     ON CONFLICT(user_id, game_key) DO NOTHING`,
    userId,
    gameKey,
    1000 + ratingDelta,
  );
  q.run(
    `UPDATE game_ranks
        SET rating = MAX(100, rating + ?),
            wins = wins + ?, losses = losses + ?, draws = draws + ?,
            best_score = MAX(best_score, ?),
            updated_at = datetime('now')
      WHERE user_id = ? AND game_key = ?`,
    ratingDelta,
    win ? 1 : 0,
    loss ? 1 : 0,
    draw ? 1 : 0,
    bestScore || 0,
    userId,
    gameKey,
  );
}

export function gameRank(userId, gameKey) {
  return q.get('SELECT * FROM game_ranks WHERE user_id = ? AND game_key = ?', userId, gameKey) || {
    rating: 1000,
    wins: 0,
    losses: 0,
    draws: 0,
    best_score: 0,
  };
}

/** Consecutive-day activity streak. Idempotent per calendar day. */
export function touchDailyStreak(userId, today = new Date().toISOString().slice(0, 10)) {
  return transaction((db) => {
    const row = db.prepare('SELECT * FROM daily_streaks WHERE user_id = ?').get(userId);
    if (!row) {
      db.prepare('INSERT INTO daily_streaks (user_id, current_days, longest_days, last_day) VALUES (?, 1, 1, ?)').run(
        userId,
        today,
      );
      db.prepare(
        "UPDATE player_statistics SET current_streak = 1, longest_streak = MAX(longest_streak, 1), last_played_date = ?, updated_at = datetime('now') WHERE user_id = ?",
      ).run(today, userId);
      return { current: 1, longest: 1, changed: true };
    }
    if (row.last_day === today) return { current: row.current_days, longest: row.longest_days, changed: false };

    const yesterday = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86400_000)
      .toISOString()
      .slice(0, 10);
    const current = row.last_day === yesterday ? row.current_days + 1 : 1;
    const longest = Math.max(row.longest_days, current);
    db.prepare(
      "UPDATE daily_streaks SET current_days = ?, longest_days = ?, last_day = ?, updated_at = datetime('now') WHERE user_id = ?",
    ).run(current, longest, today, userId);
    // Competitive win streak resets on a missed day; the day streak is separate.
    db.prepare(
      "UPDATE player_statistics SET longest_streak = MAX(longest_streak, ?), last_played_date = ?, updated_at = datetime('now') WHERE user_id = ?",
    ).run(longest, today, userId);
    return { current, longest, changed: true };
  });
}

export function resetWinStreakIfStale(userId, today = new Date().toISOString().slice(0, 10)) {
  const stats = q.get('SELECT last_played_date FROM player_statistics WHERE user_id = ?', userId);
  if (!stats) return;
  const yesterday = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86400_000)
    .toISOString()
    .slice(0, 10);
  if (stats.last_played_date && stats.last_played_date !== today && stats.last_played_date !== yesterday) {
    q.run("UPDATE player_statistics SET current_streak = 0 WHERE user_id = ?", userId);
  }
}

/* ----------------------------- achievements ----------------------------- */

export function metricValue(userId, metric) {
  const stats = q.get('SELECT * FROM player_statistics WHERE user_id = ?', userId) || {};
  const streaks = q.get('SELECT * FROM daily_streaks WHERE user_id = ?', userId) || {};
  switch (metric) {
    case 'matches_played':
      return stats.games_played || 0;
    case 'games_won':
      return stats.games_won || 0;
    case 'current_streak':
      return stats.current_streak || 0;
    case 'longest_streak':
      return Math.max(stats.longest_streak || 0, streaks.longest_days || 0);
    case 'best_round_score':
      return stats.best_round_score || 0;
    case 'signals_received':
      return stats.signals_received || 0;
    case 'signals_sent':
      return q.get('SELECT COUNT(*) AS n FROM anonymous_signals WHERE sender_user_id = ?', userId).n;
    case 'signals_mutual':
      return stats.signals_mutual || 0;
    case 'connections_count':
      return stats.connections_count || 0;
    case 'chemistry_total':
      return stats.chemistry_total || 0;
    default:
      return 0;
  }
}

/** Re-evaluate achievement progress and unlock newly earned badges. */
export function checkAchievements(userId) {
  const all = q.all('SELECT * FROM achievements WHERE enabled = 1');
  const unlocked = [];
  for (const a of all) {
    const value = metricValue(userId, a.metric);
    const existing = q.get(
      'SELECT * FROM user_achievements WHERE user_id = ? AND achievement_id = ?',
      userId,
      a.id,
    );
    const progress = Math.min(value, a.threshold);
    const shouldUnlock = value >= a.threshold;
    if (!existing) {
      q.run(
        'INSERT INTO user_achievements (user_id, achievement_id, progress, unlocked_at) VALUES (?, ?, ?, ?)',
        userId,
        a.id,
        progress,
        shouldUnlock ? new Date().toISOString() : null,
      );
      if (shouldUnlock) unlocked.push(a);
    } else if (progress !== existing.progress || (shouldUnlock && !existing.unlocked_at)) {
      q.run(
        'UPDATE user_achievements SET progress = ?, unlocked_at = COALESCE(unlocked_at, ?) WHERE id = ?',
        progress,
        shouldUnlock ? new Date().toISOString() : null,
        existing.id,
      );
      if (shouldUnlock && !existing.unlocked_at) unlocked.push(a);
    }
  }
  for (const a of unlocked) {
    awardXp(userId, a.xp_reward, 'achievement', `achievement:${a.key}:${userId}`, { achievement: a.key });
    notify(userId, {
      kind: 'result',
      title: `Achievement unlocked: ${a.name}`,
      body: a.description,
      link: '/profile',
      data: { achievement: a.key },
    });
    logger.info('achievement unlocked', { userId, achievement: a.key });
  }
  return unlocked;
}

/* ------------------------------ challenges ------------------------------ */

export function challengePeriodKey(challenge, date = new Date()) {
  if (challenge.scope === 'daily') return challenge.active_date || date.toISOString().slice(0, 10);
  return challenge.active_week || '';
}

export function progressChallenges(userId, metric, amount = 1, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  const active = q.all(
    `SELECT * FROM challenges
      WHERE enabled = 1 AND metric = ?
        AND ((scope = 'daily' AND active_date = ?) OR (scope = 'weekly' AND active_week IS NOT NULL))`,
    metric,
    day,
  );
  const completed = [];
  for (const c of active) {
    const periodKey = challengePeriodKey(c, date);
    q.run(
      `INSERT INTO user_challenges (user_id, challenge_id, progress, period_key)
       VALUES (?, ?, 0, ?) ON CONFLICT(user_id, challenge_id, period_key) DO NOTHING`,
      userId,
      c.id,
      periodKey,
    );
    const row = q.get(
      'SELECT * FROM user_challenges WHERE user_id = ? AND challenge_id = ? AND period_key = ?',
      userId,
      c.id,
      periodKey,
    );
    if (row.completed_at) continue;
    const progress = Math.min(c.target, row.progress + amount);
    const done = progress >= c.target;
    q.run(
      'UPDATE user_challenges SET progress = ?, completed_at = ? WHERE id = ?',
      progress,
      done ? new Date().toISOString() : null,
      row.id,
    );
    if (done) {
      awardXp(userId, c.xp_reward, 'challenge', `challenge:${c.id}:${periodKey}:${userId}`, {
        challenge: c.title,
      });
      notify(userId, {
        kind: 'challenge',
        title: `Challenge complete: ${c.title}`,
        body: `+${c.xp_reward} XP`,
        link: '/profile',
        data: { challengeId: c.id, periodKey },
      });
      completed.push(c);
    }
  }
  return completed;
}

/* ------------------------------ chemistry ------------------------------ */

/**
 * Per-pair chemistry. Built only from genuine, mutually welcomed game events.
 * Blocked pairs are pinned to zero, and message volume alone cannot inflate it.
 */
export function computeChemistry(userAId, userBId) {
  const [a, b] = userAId < userBId ? [userAId, userBId] : [userBId, userAId];
  const blocked = q.get(
    `SELECT 1 AS x FROM blocks
      WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
    a,
    b,
    b,
    a,
  );
  if (blocked) return { score: 0, components: { blocked: true }, blocked: true };

  const matchesTogether = q.get(
    `SELECT COUNT(DISTINCT m.id) AS n
       FROM matches m
       JOIN match_participants p1 ON p1.match_id = m.id AND p1.user_id = ?
       JOIN match_participants p2 ON p2.match_id = m.id AND p2.user_id = ?
      WHERE m.status = 'completed'`,
    a,
    b,
  ).n;

  const roundsTogether = q.get(
    `SELECT COUNT(*) AS n
       FROM round_submissions s1
       JOIN round_submissions s2 ON s2.round_id = s1.round_id AND s2.user_id = ?
       JOIN game_rounds r ON r.id = s1.round_id
       JOIN match_participants p ON p.match_id = r.match_id AND p.user_id = ?
      WHERE s1.user_id = ?`,
    b,
    a,
    a,
  ).n;

  const mutualSignals = q.get(
    `SELECT COUNT(*) AS n FROM anonymous_signals
      WHERE status = 'mutual'
        AND ((sender_user_id = ? AND recipient_user_id = ?) OR (sender_user_id = ? AND recipient_user_id = ?))`,
    a,
    b,
    b,
    a,
  ).n;

  const sharedInterests = q.get(
    `SELECT COUNT(*) AS n FROM user_interests ui1
       JOIN user_interests ui2 ON ui2.interest_id = ui1.interest_id
      WHERE ui1.user_id = ? AND ui2.user_id = ?`,
    a,
    b,
  ).n;

  const connection = q.get('SELECT * FROM connections WHERE user_a_id = ? AND user_b_id = ?', a, b);
  const daysConnected = connection
    ? Math.floor((Date.now() - new Date(connection.created_at).getTime()) / 86400_000)
    : 0;

  // Welcomed messages only: capped contribution so volume cannot inflate chemistry.
  const welcomedMessages = connection
    ? q.get(
        `SELECT COUNT(*) AS n FROM messages msg
           JOIN conversation_participants cp ON cp.conversation_id = msg.conversation_id AND cp.user_id = ?
          WHERE msg.sender_user_id = ? AND msg.moderation_status = 'approved'`,
        b,
        a,
      ).n +
      q.get(
        `SELECT COUNT(*) AS n FROM messages msg
           JOIN conversation_participants cp ON cp.conversation_id = msg.conversation_id AND cp.user_id = ?
          WHERE msg.sender_user_id = ? AND msg.moderation_status = 'approved'`,
        a,
        b,
      ).n
    : 0;

  const components = {
    matches: { raw: matchesTogether, points: Math.min(matchesTogether * 8, 40) },
    rounds: { raw: roundsTogether, points: Math.min(roundsTogether * 3, 30) },
    mutualSignals: { raw: mutualSignals, points: Math.min(mutualSignals * 15, 30) },
    sharedInterests: { raw: sharedInterests, points: Math.min(sharedInterests * 5, 25) },
    daysConnected: { raw: daysConnected, points: Math.min(daysConnected * 2, 20) },
    welcomedMessages: { raw: welcomedMessages, points: Math.min(Math.floor(welcomedMessages / 5) * 2, 15) },
  };
  const score = Object.values(components).reduce((sum, c) => sum + c.points, 0);
  return { score, components, blocked: false };
}

export function refreshChemistry(userAId, userBId) {
  const [a, b] = userAId < userBId ? [userAId, userBId] : [userBId, userAId];
  const { score, components } = computeChemistry(a, b);
  q.run(
    `INSERT INTO chemistry_scores (user_a_id, user_b_id, score, components, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_a_id, user_b_id) DO UPDATE SET
       score = excluded.score, components = excluded.components, updated_at = datetime('now')`,
    a,
    b,
    score,
    JSON.stringify(components),
  );
  // chemistry_total powers achievements; store the best single pairing.
  const best = q.get(
    'SELECT MAX(score) AS m FROM chemistry_scores WHERE user_a_id IN (?, ?) OR user_b_id IN (?, ?)',
    a,
    b,
    a,
    b,
  );
  const bestScore = best?.m || 0;
  for (const uid of [a, b]) {
    const stats = q.get('SELECT chemistry_total FROM player_statistics WHERE user_id = ?', uid);
    if (!stats) continue;
    if (bestScore > (stats.chemistry_total || 0)) {
      q.run("UPDATE player_statistics SET chemistry_total = ? WHERE user_id = ?", bestScore, uid);
    }
  }
  return { score, components };
}

export function chemistryLabel(score) {
  if (score >= 120) return 'Electric';
  if (score >= 80) return 'Strong';
  if (score >= 45) return 'Warming up';
  if (score >= 15) return 'Early days';
  return 'Just starting';
}
