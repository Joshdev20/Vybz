import { q, transaction } from '../db/index.js';

const GAME_MODES = [
  {
    key: 'rizz_battle',
    name: 'Rizz Battle',
    tagline: 'One prompt. Two answers. Best line wins.',
    description:
      'A fast head-to-head wordplay duel. Both players get the same prompt and 30 seconds to craft the sharpest response, then the round is judged.',
    min_players: 2,
    max_players: 2,
    supports_queue: 1,
    supports_rooms: 0,
    sort_order: 1,
  },
  {
    key: 'word_chemistry',
    name: 'Word Chemistry',
    tagline: 'Same word, two minds. See how close you land.',
    description:
      'Both players finish the same prompt independently. Answers are compared for genuine similarity, and shared interests surface along the way.',
    min_players: 2,
    max_players: 2,
    supports_queue: 1,
    supports_rooms: 0,
    sort_order: 2,
  },
  {
    key: 'secret_signal',
    name: 'Secret Signal',
    tagline: 'Anonymous compliments. Consensual reveals.',
    description:
      'Send and receive moderated anonymous signals. Identities stay sealed unless both people opt in to a mutual connection.',
    min_players: 2,
    max_players: 2,
    supports_queue: 0,
    supports_rooms: 0,
    supports_async: 1,
    sort_order: 3,
  },
  {
    key: 'spill_it',
    name: 'Spill It!',
    tagline: 'Truth or dare, party edition.',
    description:
      'Multiplayer rooms with a join code. Draw bold questions, skip anything you like, and keep every boundary in your own hands.',
    min_players: 2,
    max_players: 10,
    supports_queue: 0,
    supports_rooms: 1,
    sort_order: 4,
  },
  {
    key: 'blind_vibe',
    name: 'Blind Vibe',
    tagline: 'Talk first. Reveal when it feels right.',
    description:
      'A staged discovery match. Chat through icebreakers and rounds, then decide privately whether to reveal more of your profile.',
    min_players: 2,
    max_players: 2,
    supports_queue: 1,
    supports_rooms: 0,
    sort_order: 5,
  },
];

const CATEGORIES = {
  rizz_battle: [
    ['smooth_talk', 'Smooth Talk', 'Silky openers with zero cringe', 1],
    ['funny_rizz', 'Funny Rizz', 'Make them laugh before they think', 1],
    ['romantic_lines', 'Romantic Lines', 'Warm, sincere, a little bold', 2],
    ['first_impression', 'First Impression', 'The first ten seconds matter', 1],
    ['witty_comebacks', 'Witty Comebacks', 'Turn the tables fast', 2],
    ['situational_flirting', 'Situational Flirting', 'Read the room, then charm it', 2],
    ['confidence_challenge', 'Confidence Challenge', 'Say the bold thing well', 3],
    ['unexpected_questions', 'Unexpected Questions', 'Answer the question nobody expected', 2],
  ],
  word_chemistry: [
    ['daily_word', 'Daily Word', 'One shared word, two finishes', 1],
    ['funny', 'Funny', 'Finish it in a way nobody saw coming', 1],
    ['thoughtful', 'Thoughtful', 'Say something worth rereading', 1],
    ['romantic', 'Romantic', 'Keep it sincere, not saccharine', 2],
    ['personality', 'Personality', 'Reveal yourself in one line', 2],
  ],
  spill_it: [
    ['funny', 'Funny', 'Light, silly, harmless', 1],
    ['personality', 'Personality', 'How you actually think', 1],
    ['dating_experiences', 'Dating Experiences', 'War stories, no names', 2],
    ['romantic', 'Romantic', 'Sweet over spicy', 2],
    ['bold_questions', 'Bold Questions', 'Skip anything, always', 3],
    ['friendship', 'Friendship', 'Group-chat energy', 1],
    ['hypotheticals', 'Hypothetical Scenarios', 'Impossible choices, real opinions', 2],
  ],
  blind_vibe: [
    ['icebreaker', 'Icebreaker', 'Warm up before anything else', 1],
    ['deeper', 'Deeper', 'Move past the small talk', 2],
    ['values', 'Values', 'What actually matters to you', 2],
  ],
};

const PROMPTS = {
  rizz_battle: {
    smooth_talk: [
      'You have 30 seconds to open a conversation with someone who is clearly out of your league.',
      'Deliver your best opening line for someone reading a book in a coffee shop.',
      'Pitch yourself as the reason someone should cancel their quiet night in.',
      'You are stuck in the same elevator for ten floors. Start the conversation.',
      'Give a compliment that has nothing to do with how someone looks.',
      'Introduce yourself to someone who just beat you at pool.',
    ],
    funny_rizz: [
      'Flirt using only a terrible pun about the weather.',
      'Confess your undying love to the last snack you ate.',
      'Write a pickup line that also works as an apology.',
      'Seduce someone using the plot of a boring documentary.',
      'Deliver a flirt that would make your group chat groan out loud.',
      'Romance someone by describing their search history kindly.',
    ],
    romantic_lines: [
      'Describe the perfect first evening together in one sentence.',
      'Say something sincerely romantic that is not about looks.',
      'Tell someone what you would remember about them after one conversation.',
      'Write a line for a note left on someone’s kitchen counter.',
      'Say what "home" means to you in a single line.',
      'Tell someone what you noticed about them before you ever spoke.',
    ],
    first_impression: [
      'You have one line to make a strong first impression. Go.',
      'What is the first thing you would say at a wedding where you know nobody?',
      'Open a conversation at a mutual friend’s birthday party.',
      'Introduce yourself to someone who intimidates you.',
      'Make a memorable entrance in a single sentence.',
      'Recover from a bad first impression with one line.',
    ],
    witty_comebacks: [
      'They say: "You are not really my type." Respond.',
      'They say: "I bet you say that to everyone." Respond.',
      'They say: "Text me when you are famous." Respond.',
      'They say: "You look familiar." Respond without being creepy.',
      'They say: "Make me laugh." Respond with one line.',
      'They say: "I am hard to impress." Respond.',
    ],
    situational_flirting: [
      'You both reach for the last table at a packed café. What do you say?',
      'Your song comes on and they are the only one who noticed you singing. Go.',
      'It is raining and you are both under the same small awning. Go.',
      'Their flight is delayed and you are seated next to them. Go.',
      'You are paired as strangers for a party game. Break the ice.',
      'They just dropped their phone and you caught it. Say something smooth.',
    ],
    confidence_challenge: [
      'Say the boldest true thing you would tell someone you just met.',
      'Ask for something you would normally never ask for.',
      'Say exactly what you want in one line, no hedging.',
      'Compliment someone directly and mean it.',
      'Describe your best quality without apologising for it.',
      'Make a promise you can actually keep.',
    ],
    unexpected_questions: [
      'If your life had a soundtrack tonight, what is playing?',
      'What is the most interesting thing you have done this year?',
      'What is a small thing that instantly wins you over?',
      'What would you do with a completely free Sunday?',
      'What is something you are quietly proud of?',
      'What question do you wish people asked you more?',
    ],
  },
  word_chemistry: {
    daily_word: [
      'Midnight: "Midnight is better with someone who…"',
      'Coffee: "Coffee tastes best when…"',
      'Traffic: "The worst part of traffic is…"',
      'Playlist: "The song that always gets me is…"',
      'Holiday: "A perfect holiday starts with…"',
      'Rooftop: "Rooftops make me want to…"',
    ],
    funny: [
      'The most useless talent I have is…',
      'My autobiography would be titled…',
      'The worst advice I have ever followed was…',
      'My phone would be shocked to learn that I…',
      'The snack that describes my personality is…',
      'My villain origin story started when…',
    ],
    thoughtful: [
      'Something I changed my mind about recently is…',
      'The kindest thing a stranger did for me was…',
      'I feel most like myself when…',
      'A lesson I keep relearning is…',
      'Something small that always improves my day is…',
      'The best conversation I ever had was about…',
    ],
    romantic: [
      'The most romantic thing anyone could do for me is…',
      'A perfect date ends with…',
      'Love, to me, looks like…',
      'The moment I knew I liked someone was…',
      'A small gesture that means everything is…',
      'Being cared for feels like…',
    ],
    personality: [
      'At a party you will find me…',
      'People always get this wrong about me…',
      'My ideal weekend has exactly this much planning…',
      'I am at my most confident when…',
      'The fastest way to lose my attention is…',
      'My friends would describe me as…',
    ],
  },
  spill_it: {
    funny: [
      'What is the most embarrassing thing in your camera roll right now?',
      'What is the worst outfit you have ever worn on purpose?',
      'What is your most irrational fear?',
      'What is the silliest thing you have cried about?',
      'What is the weirdest food combination you genuinely enjoy?',
      'What is the worst haircut you have ever had?',
    ],
    personality: [
      'Are you the planner or the person who shows up late?',
      'What is something you are unapologetically nerdy about?',
      'Do you recharge alone or around people?',
      'What is a hill you would happily die on?',
      'How do you behave when you are nervous?',
      'What is your most controversial harmless opinion?',
    ],
    dating_experiences: [
      'What is the funniest thing that has happened on a date?',
      'What is your worst ever first-date story, without names?',
      'What is a dating rule you have learned the hard way?',
      'What is the best date you have ever been on?',
      'What instantly makes you lose interest on a date?',
      'What is the most awkward text you have ever sent?',
    ],
    romantic: [
      'What is your love language and why?',
      'What makes you feel genuinely appreciated?',
      'What is a small romantic gesture you love?',
      'How do you know you are falling for someone?',
      'What is your idea of a perfect quiet evening together?',
      'What is something you would never compromise on?',
    ],
    bold_questions: [
      'What is something you have never told anyone here?',
      'What is the boldest thing you have ever done for love?',
      'What is a secret you are ready to let go of?',
      'What is something you want but have never asked for?',
      'What is your biggest regret, if you are willing to share?',
      'What is a truth you have been avoiding?',
    ],
    friendship: [
      'Who in your life deserves more credit?',
      'What makes someone a real friend to you?',
      'What is the best thing a friend has ever done for you?',
      'What is your role in the group chat?',
      'What would your friends say is your worst habit?',
      'What is a friendship lesson you learned late?',
    ],
    hypotheticals: [
      'You can only eat one meal forever. What is it?',
      'Would you rather know when you die or how you die?',
      'You get one free round-the-world trip. Who comes with you?',
      'Would you rather be famous for something silly or rich and unknown?',
      'You can master one skill instantly. Which one?',
      'Would you rather relive your best day or skip your worst one?',
    ],
  },
  blind_vibe: {
    icebreaker: [
      'What is something small that made you smile this week?',
      'You have one free evening and no plans. What happens?',
      'What is a completely useless fact you enjoy knowing?',
      'Coffee, tea, or something else entirely — and why?',
      'What is the last thing that genuinely made you laugh?',
      'If we met at a party, how would you start the conversation?',
    ],
    deeper: [
      'What is something you are working on right now, in any part of life?',
      'When do you feel most like yourself?',
      'What is a belief you have changed your mind about?',
      'What does a good week look like for you?',
      'What do you want more of in your life this year?',
      'What is something people usually misunderstand about you?',
    ],
    values: [
      'What matters most to you in the people you keep close?',
      'What would you never compromise on?',
      'How do you like to be supported when things are hard?',
      'What kind of connection are you actually looking for?',
      'What makes you feel respected?',
      'What do you hope people remember about you?',
    ],
  },
};

const INTERESTS = [
  ['music', 'Music', 'culture'],
  ['live_gigs', 'Live gigs', 'culture'],
  ['films', 'Films', 'culture'],
  ['series', 'Series', 'culture'],
  ['reading', 'Reading', 'culture'],
  ['gaming', 'Gaming', 'play'],
  ['board_games', 'Board games', 'play'],
  ['trivia', 'Trivia', 'play'],
  ['cooking', 'Cooking', 'life'],
  ['baking', 'Baking', 'life'],
  ['coffee', 'Coffee', 'life'],
  ['street_food', 'Street food', 'life'],
  ['gym', 'Gym', 'fitness'],
  ['running', 'Running', 'fitness'],
  ['yoga', 'Yoga', 'fitness'],
  ['hiking', 'Hiking', 'outdoors'],
  ['travel', 'Travel', 'outdoors'],
  ['beach', 'Beach', 'outdoors'],
  ['photography', 'Photography', 'creative'],
  ['art', 'Art', 'creative'],
  ['writing', 'Writing', 'creative'],
  ['dancing', 'Dancing', 'creative'],
  ['standup', 'Stand-up comedy', 'creative'],
  ['pets', 'Pets', 'life'],
  ['volunteering', 'Volunteering', 'values'],
  ['sustainability', 'Sustainability', 'values'],
  ['entrepreneurship', 'Entrepreneurship', 'work'],
  ['tech', 'Technology', 'work'],
  ['fashion', 'Fashion', 'style'],
  ['karaoke', 'Karaoke', 'play'],
];

const ACHIEVEMENTS = [
  ['first_match', 'First Contact', 'Complete your first match.', 'matches_played', 1, 25, 'play'],
  ['ten_matches', 'Regular', 'Complete 10 matches.', 'matches_played', 10, 100, 'play'],
  ['fifty_matches', 'Veteran', 'Complete 50 matches.', 'matches_played', 50, 400, 'play'],
  ['first_win', 'Opening Act', 'Win your first match.', 'games_won', 1, 50, 'play'],
  ['ten_wins', 'Headliner', 'Win 10 matches.', 'games_won', 10, 200, 'play'],
  ['streak_3', 'On a Roll', 'Win 3 matches in a row.', 'current_streak', 3, 150, 'play'],
  ['streak_7', 'Untouchable', 'Win 7 matches in a row.', 'current_streak', 7, 500, 'play'],
  ['first_signal', 'Signal Received', 'Receive your first secret signal.', 'signals_received', 1, 30, 'social'],
  ['first_mutual', 'Both Ways', 'Reach a mutual signal with someone.', 'signals_mutual', 1, 75, 'social'],
  ['five_connections', 'Well Connected', 'Build 5 connections.', 'connections_count', 5, 150, 'social'],
  ['chemistry_100', 'Real Chemistry', 'Reach a chemistry score of 100 with someone.', 'chemistry_total', 100, 250, 'social'],
  ['daily_streak_7', 'Seven Straight', 'Play on 7 consecutive days.', 'longest_streak', 7, 200, 'commitment'],
  ['daily_streak_30', 'Habit Formed', 'Play on 30 consecutive days.', 'longest_streak', 30, 800, 'commitment'],
];

const SIGNAL_TEMPLATES = [
  ['compliment', 'You have an unfairly good laugh.'],
  ['compliment', 'Your answers in Word Chemistry were genuinely clever.'],
  ['compliment', 'You made me laugh out loud in the middle of a game.'],
  ['compliment', 'You have a really warm way of talking to people.'],
  ['compliment', 'You were a good sport even when you lost.'],
  ['compliment', 'Something about your energy is quietly magnetic.'],
  ['compliment', 'You notice small details. I like that.'],
  ['compliment', 'Your comeback game is genuinely strong.'],
  ['interest', 'I would play another round with you any time.'],
  ['interest', 'If you are open to it, I would like to keep talking.'],
  ['interest', 'We seem to think in similar directions.'],
];

export function seed({ quiet = false } = {}) {
  const log = (...a) => {
    if (!quiet) console.log(...a);
  };
  transaction((db) => {
    const insertMode = db.prepare(
      `INSERT INTO game_modes (key, name, tagline, description, min_players, max_players, supports_queue, supports_rooms, supports_async, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         name = excluded.name, tagline = excluded.tagline, description = excluded.description,
         min_players = excluded.min_players, max_players = excluded.max_players,
         supports_queue = excluded.supports_queue, supports_rooms = excluded.supports_rooms,
         supports_async = excluded.supports_async, sort_order = excluded.sort_order`,
    );
    for (const m of GAME_MODES) {
      insertMode.run(
        m.key,
        m.name,
        m.tagline,
        m.description,
        m.min_players,
        m.max_players,
        m.supports_queue,
        m.supports_rooms,
        m.supports_async || 0,
        m.sort_order,
      );
    }

    const insertCat = db.prepare(
      `INSERT INTO prompt_categories (game_key, key, label, description, intensity, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(game_key, key) DO UPDATE SET
         label = excluded.label, description = excluded.description,
         intensity = excluded.intensity, sort_order = excluded.sort_order`,
    );
    for (const [gameKey, cats] of Object.entries(CATEGORIES)) {
      cats.forEach(([key, label, description, intensity], i) => {
        insertCat.run(gameKey, key, label, description, intensity, i);
      });
    }

    const catId = (gameKey, key) =>
      db.prepare('SELECT id FROM prompt_categories WHERE game_key = ? AND key = ?').get(gameKey, key)?.id;

    const findPrompt = db.prepare(
      'SELECT id FROM game_prompts WHERE game_key = ? AND text = ? AND locale = ?',
    );
    const insertPrompt = db.prepare(
      `INSERT INTO game_prompts (game_key, category_id, text, difficulty, round_seconds, locale)
       VALUES (?, ?, ?, ?, ?, 'en')`,
    );
    const difficultyFor = (intensity) => (intensity >= 3 ? 'spicy' : intensity === 2 ? 'standard' : 'easy');
    let promptCount = 0;
    for (const [gameKey, byCat] of Object.entries(PROMPTS)) {
      for (const [catKey, texts] of Object.entries(byCat)) {
        const cid = catId(gameKey, catKey);
        const intensity = CATEGORIES[gameKey].find((c) => c[0] === catKey)?.[3] || 1;
        for (const text of texts) {
          if (findPrompt.get(gameKey, text, 'en')) continue;
          insertPrompt.run(gameKey, cid, text, difficultyFor(intensity), gameKey === 'spill_it' ? 60 : 30);
          promptCount += 1;
        }
      }
    }

    const insertInterest = db.prepare(
      `INSERT INTO interests (key, label, category, sort_order) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET label = excluded.label, category = excluded.category`,
    );
    INTERESTS.forEach(([key, label, category], i) => insertInterest.run(key, label, category, i));

    const insertAch = db.prepare(
      `INSERT INTO achievements (key, name, description, category, metric, threshold, xp_reward)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         name = excluded.name, description = excluded.description,
         category = excluded.category, metric = excluded.metric,
         threshold = excluded.threshold, xp_reward = excluded.xp_reward`,
    );
    for (const [key, name, description, metric, threshold, xp, category] of ACHIEVEMENTS) {
      insertAch.run(key, name, description, category, metric, threshold, xp);
    }

    const insertTemplate = db.prepare(
      `INSERT INTO signal_templates (key, kind, body, moderation_status)
       VALUES (?, ?, ?, 'approved')
       ON CONFLICT(key) DO UPDATE SET body = excluded.body, kind = excluded.kind`,
    );
    SIGNAL_TEMPLATES.forEach(([kind, body], i) => insertTemplate.run(`${kind}_${i + 1}`, kind, body));

    log(
      `[seed] game modes=${GAME_MODES.length} prompts+${promptCount} interests=${INTERESTS.length} achievements=${ACHIEVEMENTS.length}`,
    );
  });
}

export function seedChallengesForToday(date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  const daily = [
    ['Play 2 matches today', 'Complete 2 matches in any game mode.', 'matches_played', 2, 30],
    ['Land a strong round', 'Score 70 or higher in a single round.', 'best_round_score', 70, 40],
    ['Send a signal', 'Send one anonymous signal to someone new.', 'signals_sent', 1, 20],
  ];
  const weekly = [
    ['Win 5 matches this week', 'Win 5 matches across any game mode.', 'games_won', 5, 200],
    ['Build a connection', 'Reach a mutual connection with someone new.', 'connections_count', 1, 150],
  ];
  transaction((db) => {
    const ins = db.prepare(
      `INSERT INTO challenges (scope, game_key, title, description, metric, target, xp_reward, active_date, active_week)
       SELECT ?, NULL, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM challenges WHERE scope = ? AND title = ? AND COALESCE(active_date,'') = COALESCE(?,'') AND COALESCE(active_week,'') = COALESCE(?,'')
       )`,
    );
    for (const [title, description, metric, target, xp] of daily) {
      ins.run('daily', title, description, metric, target, xp, day, null, 'daily', title, day, null);
    }
    const week = isoWeek(date);
    for (const [title, description, metric, target, xp] of weekly) {
      ins.run('weekly', title, description, metric, target, xp, null, week, 'weekly', title, null, week);
    }
  });
}

export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}
