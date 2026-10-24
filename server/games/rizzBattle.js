import { q } from '../db/index.js';
import { heuristicJudge, judgeSubmission, AI_JUDGE_OPERATIONAL } from '../lib/judge.js';

/**
 * Rizz Battle - competitive head-to-head wordplay.
 *
 * Judging mode is chosen by the players' preferences and server capability:
 *   peer    - both players vote on the stronger answer (default, no AI needed)
 *   ai      - automated rubric scoring only
 *   hybrid  - automated score plus player votes
 */
export const rizzBattle = {
  key: 'rizz_battle',
  name: 'Rizz Battle',
  totalRounds: 3,
  roundSeconds: 30,
  voteSeconds: 20,

  judgedBy({ prefersAi }) {
    if (!prefersAi) return 'peer';
    return AI_JUDGE_OPERATIONAL ? 'ai' : 'peer';
  },

  pickPrompt({ difficulty = 'standard', categories = [] } = {}) {
    const params = [this.key];
    let sql = `SELECT p.*, c.key AS category_key, c.label AS category_label, c.intensity
                 FROM game_prompts p LEFT JOIN prompt_categories c ON c.id = p.category_id
                WHERE p.game_key = ? AND p.enabled = 1`;
    if (categories.length) {
      sql += ` AND c.key IN (${categories.map(() => '?').join(',')})`;
      params.push(...categories);
    }
    if (difficulty && difficulty !== 'any') {
      sql += ' AND (p.difficulty = ? OR ? = \'standard\')';
      params.push(difficulty, difficulty);
    }
    // Prefer least-used prompts so the same line does not repeat constantly.
    sql += ' ORDER BY p.usage_count ASC, RANDOM() LIMIT 1';
    let prompt = q.get(sql, ...params);
    if (!prompt) {
      prompt = q.get(
        `SELECT p.*, c.key AS category_key, c.label AS category_label, c.intensity
           FROM game_prompts p LEFT JOIN prompt_categories c ON c.id = p.category_id
          WHERE p.game_key = ? AND p.enabled = 1 ORDER BY RANDOM() LIMIT 1`,
        this.key,
      );
    }
    if (prompt) q.run('UPDATE game_prompts SET usage_count = usage_count + 1 WHERE id = ?', prompt.id);
    return prompt;
  },

  /** Peer voting: the player with more votes takes the round. */
  resolveRound({ submissions, votes }) {
    const byUser = new Map();
    for (const s of submissions) byUser.set(s.user_id, { votes: 0, submission: s });
    for (const v of votes) {
      const target = byUser.get(v.target_user_id);
      if (target) target.votes += 1;
    }
    const entries = [...byUser.entries()].map(([userId, v]) => ({ userId, ...v }));
    const maxVotes = Math.max(...entries.map((e) => e.votes));
    const winners = entries.filter((e) => e.votes === maxVotes && maxVotes > 0);

    const awards = {};
    const results = [];
    if (winners.length === 1) {
      for (const e of entries) {
        const points = e.userId === winners[0].userId ? 10 : 3;
        awards[e.userId] = points;
        results.push({ userId: e.userId, points, reason: e.userId === winners[0].userId ? 'round_win' : 'round_played' });
      }
    } else {
      for (const e of entries) {
        awards[e.userId] = 6;
        results.push({ userId: e.userId, points: 6, reason: 'round_draw' });
      }
    }
    return {
      awards,
      results,
      winnerUserIds: winners.length === 1 ? [winners[0].userId] : [],
      detail: { votes: entries.map((e) => ({ userId: e.userId, votes: e.votes })), method: 'peer' },
    };
  },

  /** Automated rubric scoring. */
  async resolveAutomated({ submissions, prompt }) {
    const scored = [];
    for (const s of submissions) {
      const judged = await judgeSubmission(prompt, s.body);
      scored.push({ userId: s.user_id, submissionId: s.id, ...judged });
    }
    const best = Math.max(...scored.map((s) => s.score));
    const top = scored.filter((s) => s.score === best);
    const awards = {};
    const results = [];
    for (const s of scored) {
      const isWinner = top.length === 1 && s.userId === top[0].userId;
      const points = isWinner ? 10 : top.length > 1 ? 6 : 3;
      awards[s.userId] = points;
      results.push({ userId: s.userId, points, reason: isWinner ? 'round_win' : top.length > 1 ? 'round_draw' : 'round_played' });
    }
    return {
      awards,
      results,
      winnerUserIds: top.length === 1 ? [top[0].userId] : [],
      judged: scored,
      detail: { method: 'ai', scores: scored.map((s) => ({ userId: s.userId, score: s.score })) },
    };
  },

  scoreSubmission: (prompt, body) => heuristicJudge(prompt, body),
};

export const RIZZ_JUDGE_NOTE =
  'Automated scores come from a documented rubric (creativity, relevance, humour, originality). ' +
  'When no judging model is configured, scores are produced by the deterministic local rubric and labelled as such.';
