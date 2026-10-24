import { config, AI_JUDGE_OPERATIONAL } from '../config.js';
import { logger } from './logger.js';

/**
 * Automated judging.
 *
 * Rubric (documented, applied identically by the heuristic and AI paths):
 *   creativity   0-25  - originality of the idea, not a stock line
 *   relevance    0-25  - actually answers the prompt that was given
 *   humour       0-25  - wit, timing, playfulness
 *   originality  0-25  - avoids clichés, generic pickup lines, filler
 *
 * Scores are labelled with `source` so the UI can state whether a result came
 * from a real model or from the deterministic fallback rubric.
 */

export function judgeAvailability() {
  return {
    operational: AI_JUDGE_OPERATIONAL,
    provider: AI_JUDGE_OPERATIONAL ? config.aiJudge.provider : null,
    model: AI_JUDGE_OPERATIONAL ? config.aiJudge.model : null,
    fallback: 'heuristic',
  };
}

const CLICHES = [
  'are you a parking ticket',
  'did it hurt when you fell from heaven',
  'come here often',
  'you must be tired',
  'heaven missing an angel',
  'are you a magician',
  'do you believe in love at first sight',
  'if i could rearrange the alphabet',
  'are you from tennessee',
  'is your name google',
  'hello beautiful',
  'hey gorgeous',
  'nice to meet you too',
  'lol',
  'haha',
];

const FILLER = /\b(um+|uh+|idk|whatever|nothing much|dunno)\b/i;

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Deterministic heuristic scoring. Same input always yields the same score. */
export function heuristicJudge(prompt, submission) {
  const body = String(submission || '').trim();
  const words = tokenize(body);
  const unique = new Set(words);
  const lower = body.toLowerCase();

  const lengthScore = Math.min(1, words.length / 12); // rewards a developed answer
  const varietyScore = words.length ? unique.size / words.length : 0;
  const clicheHits = CLICHES.filter((c) => lower.includes(c)).length;
  const fillerHits = (lower.match(FILLER) || []).length;

  // Relevance: lexical overlap with the prompt plus question/answer shape.
  const promptWords = new Set(tokenize(prompt).filter((w) => w.length > 3));
  const overlap = words.filter((w) => promptWords.has(w)).length;
  const relevanceRatio = promptWords.size ? Math.min(1, overlap / Math.max(1, promptWords.size * 0.25)) : 0.5;
  const addressesPrompt = /\?|because|when|if|you|your|we|i'd|i would/i.test(body) ? 1 : 0.6;

  const punctuationPlay = /[!?…]|—|\.\.\./.test(body) ? 1 : 0.7;
  const hasStructure = body.length > 24 ? 1 : 0.75;

  const creativity = clamp(
    25 * (0.45 * lengthScore + 0.3 * varietyScore + 0.25 * punctuationPlay) - clicheHits * 5,
    0,
    25,
  );
  const relevance = clamp(25 * (0.65 * relevanceRatio + 0.35 * addressesPrompt) - fillerHits * 3, 0, 25);
  const humour = clamp(
    25 * (0.4 * punctuationPlay + 0.35 * hasStructure + 0.25 * varietyScore) - fillerHits * 4,
    0,
    25,
  );
  const originality = clamp(25 * (0.6 * varietyScore + 0.4 * lengthScore) - clicheHits * 7, 0, 25);

  const total = Math.round(creativity + relevance + humour + originality);
  const notes = [];
  if (clicheHits) notes.push('uses well-known stock lines');
  if (fillerHits) notes.push('contains filler');
  if (words.length < 4) notes.push('very short answer');
  if (words.length >= 12) notes.push('well developed');

  return {
    score: clamp(total, 0, 100),
    source: 'heuristic',
    breakdown: {
      creativity: Math.round(creativity),
      relevance: Math.round(relevance),
      humour: Math.round(humour),
      originality: Math.round(originality),
    },
    notes: notes.join(', ') || 'balanced answer',
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Judge a submission. Uses the configured provider when operational, and
 * always falls back to the deterministic rubric rather than failing a round.
 */
export async function judgeSubmission(prompt, submission) {
  if (!AI_JUDGE_OPERATIONAL) return heuristicJudge(prompt, submission);
  try {
    const ai = await callProvider(prompt, submission);
    if (ai) return ai;
  } catch (err) {
    logger.warn('ai judge failed, using heuristic fallback', { error: err.message });
  }
  const fallback = heuristicJudge(prompt, submission);
  return { ...fallback, source: 'heuristic', notes: `${fallback.notes} (fallback: AI judge unavailable)` };
}

async function callProvider(prompt, submission) {
  const { baseUrl, apiKey, model } = config.aiJudge;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a fair, good-humoured judge for a playful adult wordplay game. ' +
              'Score creativity, relevance, humour and originality from 0-25 each. ' +
              'Reward wit and sincerity; never reward sexual explicitness, harassment or cruelty. ' +
              'Reply with JSON only: {"creativity":n,"relevance":n,"humour":n,"originality":n,"notes":"..."}',
          },
          {
            role: 'user',
            content: `Prompt: ${prompt}\n\nPlayer answer: ${submission}`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`provider responded ${res.status}`);
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error('empty provider response');
    const parsed = JSON.parse(content);
    const breakdown = {
      creativity: clamp(Number(parsed.creativity) || 0, 0, 25),
      relevance: clamp(Number(parsed.relevance) || 0, 0, 25),
      humour: clamp(Number(parsed.humour) || 0, 0, 25),
      originality: clamp(Number(parsed.originality) || 0, 0, 25),
    };
    const total = Math.round(
      breakdown.creativity + breakdown.relevance + breakdown.humour + breakdown.originality,
    );
    return {
      score: clamp(total, 0, 100),
      source: 'ai',
      breakdown,
      notes: String(parsed.notes || '').slice(0, 300),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/* ------------------------- word chemistry scoring ------------------------- */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'so', 'to', 'of', 'in', 'on', 'at', 'for',
  'with', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'i', 'you', 'your', 'my', 'me', 'we',
  'it', 'its', 'that', 'this', 'as', 'by', 'from', 'not', 'no', 'do', 'does', 'did', 'have', 'has',
  'had', 'would', 'could', 'should', 'will', 'just', 'really', 'very', 'about', 'up', 'out',
]);

export function contentWords(text) {
  return tokenize(text).filter((w) => !STOPWORDS.has(w) && w.length > 2);
}

function bigrams(words) {
  const out = new Set();
  for (let i = 0; i < words.length - 1; i += 1) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Answer similarity for Word Chemistry. This measures textual overlap only -
 * it is explicitly NOT a validated measure of romantic compatibility, and the
 * UI must present it as "answer similarity".
 */
export function similarityScore(answerA, answerB) {
  const wa = contentWords(answerA);
  const wb = contentWords(answerB);
  const wordSim = jaccard(new Set(wa), new Set(wb));
  const bigramSim = jaccard(bigrams(wa), bigrams(wb));

  // Sentiment/theme alignment: shared affective vocabulary.
  const THEMES = {
    warm: ['love', 'warm', 'care', 'kind', 'gentle', 'home', 'safe', 'cosy', 'cozy', 'sweet'],
    playful: ['laugh', 'funny', 'joke', 'silly', 'play', 'game', 'dance', 'sing', 'chaos', 'banter'],
    bold: ['brave', 'bold', 'dare', 'risk', 'adventure', 'wild', 'honest', 'direct', 'fire', 'spark'],
    reflective: ['think', 'quiet', 'deep', 'wonder', 'remember', 'learn', 'grow', 'peace', 'calm', 'time'],
    social: ['friends', 'people', 'party', 'together', 'talk', 'share', 'crowd', 'team', 'meet', 'loud'],
  };
  const themeVec = (words) => {
    const vec = {};
    for (const [theme, keys] of Object.entries(THEMES)) {
      vec[theme] = keys.filter((k) => words.includes(k)).length;
    }
    return vec;
  };
  const ta = themeVec(wa);
  const tb = themeVec(wb);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const k of Object.keys(THEMES)) {
    dot += ta[k] * tb[k];
    magA += ta[k] ** 2;
    magB += tb[k] ** 2;
  }
  const themeSim = magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;

  const lengthBalance =
    1 - Math.min(1, Math.abs(wa.length - wb.length) / Math.max(6, wa.length + wb.length));

  const raw = 0.42 * wordSim + 0.18 * bigramSim + 0.28 * themeSim + 0.12 * lengthBalance;
  const score = Math.round(clamp(raw * 130, 0, 100));

  const sharedWords = [...new Set(wa)].filter((w) => wb.includes(w));
  const sharedThemes = Object.keys(THEMES).filter((k) => ta[k] > 0 && tb[k] > 0);

  return {
    score,
    sharedWords: sharedWords.slice(0, 8),
    sharedThemes,
    // Never phrase this as a romantic verdict.
    label: score >= 70 ? 'Very similar answers' : score >= 40 ? 'Some overlap' : 'Very different angles',
    disclaimer: 'Answer similarity only - it is not a compatibility assessment.',
  };
}

export { AI_JUDGE_OPERATIONAL };
