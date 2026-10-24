import { q } from '../db/index.js';
import { similarityScore } from '../lib/judge.js';

/**
 * Word Chemistry - collaborative completion game.
 *
 * Both players finish the same prompt. Scoring rewards genuine textual
 * similarity and participation. It is explicitly not a compatibility verdict.
 */
export const wordChemistry = {
  key: 'word_chemistry',
  name: 'Word Chemistry',
  totalRounds: 3,
  roundSeconds: 45,
  voteSeconds: 0,
  judgedBy: () => 'similarity',

  pickPrompt({ difficulty = 'any', categories = [] } = {}) {
    const params = [this.key];
    let sql = `SELECT p.*, c.key AS category_key, c.label AS category_label
                 FROM game_prompts p LEFT JOIN prompt_categories c ON c.id = p.category_id
                WHERE p.game_key = ? AND p.enabled = 1`;
    if (categories.length) {
      sql += ` AND c.key IN (${categories.map(() => '?').join(',')})`;
      params.push(...categories);
    }
    sql += ' ORDER BY p.usage_count ASC, RANDOM() LIMIT 1';
    let prompt = q.get(sql, ...params);
    if (!prompt) {
      prompt = q.get(
        `SELECT p.*, c.key AS category_key, c.label AS category_label
           FROM game_prompts p LEFT JOIN prompt_categories c ON c.id = p.category_id
          WHERE p.game_key = ? ORDER BY RANDOM() LIMIT 1`,
        this.key,
      );
    }
    if (prompt) q.run('UPDATE game_prompts SET usage_count = usage_count + 1 WHERE id = ?', prompt.id);
    return prompt;
  },

  /** Similarity-driven scoring: both players gain from a close match. */
  resolveRound({ submissions }) {
    const [a, b] = submissions;
    if (!a || !b) {
      const awards = {};
      const results = [];
      for (const s of submissions) {
        awards[s.user_id] = 1;
        results.push({ userId: s.user_id, points: 1, reason: 'round_played' });
      }
      return { awards, results, winnerUserIds: [], detail: { similarity: 0, incomplete: true } };
    }
    const sim = similarityScore(a.body, b.body);
    const base = Math.max(1, Math.round(sim.score / 10));
    const awards = {};
    const results = [];
    for (const s of submissions) {
      awards[s.user_id] = base;
      results.push({ userId: s.user_id, points: base, reason: 'round_similarity' });
    }
    return {
      awards,
      results,
      winnerUserIds: [],
      similarity: sim,
      detail: { method: 'similarity', similarity: sim.score, sharedWords: sim.sharedWords, sharedThemes: sim.sharedThemes },
    };
  },

  async resolveAutomated({ submissions }) {
    return this.resolveRound({ submissions });
  },
};

export const WORD_CHEMISTRY_NOTE =
  'Answer similarity compares wording and themes between two answers. It is not a scientific compatibility test.';
