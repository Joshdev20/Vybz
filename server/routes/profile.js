import { Router } from 'express';
import { q, transaction } from '../db/index.js';
import { handler, badRequest, notFound, forbidden } from '../lib/http.js';
import { requireAuth, requireActive } from '../middleware.js';
import { levelProgress, gameRank, metricValue } from '../lib/progression.js';
import { publicPresence } from '../lib/presence.js';
import { blockedUserIds, hasBlocked } from '../lib/safety.js';
import { areConnected, getConnection } from '../lib/connections.js';
import { AVATAR_PRESETS, isPresetAvatar } from '../lib/avatars.js';
import { publicPreferences } from '../lib/preferences.js';
import { screenText } from '../lib/safety.js';

const router = Router();

const PRESET_AVATARS = AVATAR_PRESETS;

router.get(
  '/me',
  requireAuth,
  handler(async (req, res) => {
    const profile = q.get('SELECT * FROM user_profiles WHERE user_id = ?', req.user.id);
    const prefs = q.get('SELECT * FROM user_preferences WHERE user_id = ?', req.user.id);
    const stats = q.get('SELECT * FROM player_statistics WHERE user_id = ?', req.user.id);
    const streaks = q.get('SELECT * FROM daily_streaks WHERE user_id = ?', req.user.id);
    const interests = q.all(
      `SELECT i.* FROM user_interests ui JOIN interests i ON i.id = ui.interest_id
        WHERE ui.user_id = ? ORDER BY i.sort_order`,
      req.user.id,
    );
    const ranks = q.all(
      `SELECT r.*, g.name AS game_name FROM game_ranks r
        LEFT JOIN game_modes g ON g.key = r.game_key WHERE r.user_id = ?`,
      req.user.id,
    );
    const achievements = q.all(
      `SELECT a.key, a.name, a.description, a.category, a.threshold, a.metric, ua.progress, ua.unlocked_at
         FROM achievements a
         LEFT JOIN user_achievements ua ON ua.achievement_id = a.id AND ua.user_id = ?
        WHERE a.enabled = 1 ORDER BY a.category, a.threshold`,
      req.user.id,
    );
    const history = q.all(
      `SELECT m.public_id, m.game_key, m.status, m.ended_at, m.created_at, p.score, p.result,
              (SELECT u.username FROM match_participants mp JOIN users u ON u.id = mp.user_id
                WHERE mp.match_id = m.id AND mp.user_id <> ? LIMIT 1) AS opponent
         FROM match_participants p
         JOIN matches m ON m.id = p.match_id
        WHERE p.user_id = ? AND m.status IN ('completed','abandoned')
        ORDER BY m.id DESC LIMIT 10`,
      req.user.id,
      req.user.id,
    );
    const day = new Date().toISOString().slice(0, 10);
    const challenges = q.all(
      `SELECT c.title, c.scope, c.target, c.xp_reward, COALESCE(uc.progress,0) AS progress, uc.completed_at
         FROM challenges c
         LEFT JOIN user_challenges uc ON uc.challenge_id = c.id AND uc.user_id = ?
        WHERE c.enabled = 1 AND (c.active_date IS NULL OR c.active_date = ?)
        ORDER BY c.scope, c.id LIMIT 8`,
      req.user.id,
      day,
    );
    res.json({
      profile,
      preferences: publicPreferences(prefs),
      statistics: stats,
      progress: levelProgress(stats?.xp || 0),
      streaks,
      interests,
      ranks: ranks.map((r) => ({ ...r, gameName: r.game_name })),
      achievements: achievements.map((a) => ({ ...a, unlocked: Boolean(a.unlocked_at) })),
      history: history.map((h) => ({
        publicId: h.public_id,
        gameKey: h.game_key,
        status: h.status,
        score: h.score,
        result: h.result,
        opponent: h.opponent,
        at: h.ended_at || h.created_at,
      })),
      challenges: challenges.map((c) => ({
        title: c.title,
        scope: c.scope,
        target: c.target,
        progress: c.progress,
        xpReward: c.xp_reward,
        completed: Boolean(c.completed_at),
      })),
      avatarPresets: PRESET_AVATARS,
    });
  }),
);

router.patch(
  '/me',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const { displayName, bio, avatarKind, avatarValue, gender, interestedIn, region, showRegion, languages } =
      req.body || {};

    if (displayName !== undefined) {
      const v = String(displayName || '').trim();
      if (v.length > 40) throw badRequest('Display name must be 40 characters or fewer.');
    }
    if (bio !== undefined) {
      const v = String(bio || '').trim();
      if (v.length > 400) throw badRequest('Bio must be 400 characters or fewer.');
      const verdict = screenText(v);
      if (!verdict.allowed) throw badRequest(verdict.reason || 'That bio is not allowed.');
    }
    if (avatarKind === 'upload' && avatarValue) {
      const media = q.get('SELECT id FROM media WHERE id = ? AND user_id = ?', String(avatarValue), req.user.id);
      if (!media) throw badRequest('That uploaded image could not be found.');
    }
    if (avatarKind === 'preset' && avatarValue && !isPresetAvatar(avatarValue)) {
      throw badRequest('Unknown avatar preset.');
    }
    if (region !== undefined && String(region || '').length > 60) {
      throw badRequest('Region must be 60 characters or fewer.');
    }

    const updates = [];
    const params = [];
    const set = (col, val) => {
      updates.push(`${col} = ?`);
      params.push(val);
    };
    if (displayName !== undefined) set('display_name', String(displayName || '').trim() || null);
    if (bio !== undefined) set('bio', String(bio || '').trim() || null);
    if (avatarKind !== undefined) set('avatar_kind', avatarKind === 'upload' ? 'upload' : 'preset');
    if (avatarValue !== undefined) set('avatar_value', avatarValue ? String(avatarValue).slice(0, 80) : null);
    if (gender !== undefined) set('gender', String(gender || '').slice(0, 40) || null);
    if (interestedIn !== undefined) set('interested_in', String(interestedIn || '').slice(0, 40) || null);
    if (region !== undefined) set('region', String(region || '').slice(0, 60) || null);
    if (showRegion !== undefined) set('show_region', showRegion ? 1 : 0);
    if (languages !== undefined) {
      const list = Array.isArray(languages) ? languages.map((l) => String(l).slice(0, 12)).slice(0, 6) : [];
      set('languages', JSON.stringify(list));
    }

    if (updates.length) {
      params.push(req.user.id);
      q.run(
        `UPDATE user_profiles SET ${updates.join(', ')}, updated_at = datetime('now') WHERE user_id = ?`,
        ...params,
      );
    }
    res.json({ profile: q.get('SELECT * FROM user_profiles WHERE user_id = ?', req.user.id) });
  }),
);

router.patch(
  '/preferences',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const allowed = {
      discoverable: 'bool',
      show_online_status: 'bool',
      allow_anonymous_signals: 'bool',
      allow_anonymous_custom: 'bool',
      allow_ai_judge: 'bool',
      notify_matches: 'bool',
      notify_messages: 'bool',
      notify_signals: 'bool',
      notify_rooms: 'bool',
      notify_challenges: 'bool',
      hide_private_notifications: 'bool',
      reduced_motion: 'bool',
    };
    const updates = [];
    const params = [];
    for (const [key, type] of Object.entries(allowed)) {
      if (req.body?.[key] === undefined) continue;
      updates.push(`${key} = ?`);
      params.push(type === 'bool' ? (req.body[key] ? 1 : 0) : req.body[key]);
    }
    if (req.body?.allow_messages_from !== undefined) {
      const v = String(req.body.allow_messages_from);
      if (!['connections', 'everyone'].includes(v)) throw badRequest('Invalid messaging preference.');
      updates.push('allow_messages_from = ?');
      params.push(v);
    }
    if (req.body?.preferred_games !== undefined) {
      const list = Array.isArray(req.body.preferred_games)
        ? req.body.preferred_games.map((g) => String(g)).slice(0, 10)
        : [];
      updates.push('preferred_games = ?');
      params.push(JSON.stringify(list));
    }
    if (req.body?.theme !== undefined) {
      updates.push('theme = ?');
      params.push(String(req.body.theme).slice(0, 30));
    }
    if (updates.length) {
      params.push(req.user.id);
      q.run(
        `UPDATE user_preferences SET ${updates.join(', ')}, updated_at = datetime('now') WHERE user_id = ?`,
        ...params,
      );
    }
    const prefs = q.get('SELECT * FROM user_preferences WHERE user_id = ?', req.user.id);
    res.json({ preferences: publicPreferences(prefs) });
  }),
);

router.get(
  '/interests',
  handler(async (req, res) => {
    const all = q.all('SELECT * FROM interests ORDER BY sort_order');
    const mine = req.user
      ? q.all('SELECT interest_id FROM user_interests WHERE user_id = ?', req.user.id).map((r) => r.interest_id)
      : [];
    res.json({ interests: all, selected: mine, avatarPresets: PRESET_AVATARS });
  }),
);

router.put(
  '/interests',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const ids = Array.isArray(req.body?.interestIds) ? req.body.interestIds.map(Number).filter(Boolean) : [];
    if (ids.length > 12) throw badRequest('Choose up to 12 interests.');
    transaction((db) => {
      db.prepare('DELETE FROM user_interests WHERE user_id = ?').run(req.user.id);
      for (const id of ids) {
        const exists = db.prepare('SELECT 1 AS x FROM interests WHERE id = ?').get(id);
        if (exists) {
          db.prepare('INSERT OR IGNORE INTO user_interests (user_id, interest_id) VALUES (?, ?)').run(req.user.id, id);
        }
      }
    });
    res.json({ ok: true });
  }),
);

router.post(
  '/onboarding',
  requireAuth,
  handler(async (req, res) => {
    const { step, complete } = req.body || {};
    const valid = ['welcome', 'age', 'account', 'username', 'avatar', 'interests', 'games', 'privacy', 'done'];
    if (step && !valid.includes(step)) throw badRequest('Unknown onboarding step.');
    if (complete) {
      q.run(
        "UPDATE users SET onboarding_step = 'done', onboarded_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
        req.user.id,
      );
    } else if (step) {
      q.run('UPDATE users SET onboarding_step = ?, updated_at = datetime(\'now\') WHERE id = ?', step, req.user.id);
    }
    const user = q.get('SELECT * FROM users WHERE id = ?', req.user.id);
    res.json({ onboardingStep: user.onboarding_step, onboarded: Boolean(user.onboarded_at) });
  }),
);

/** Public profile view, respecting privacy settings and blocks. */
router.get(
  '/user/:username',
  requireAuth,
  handler(async (req, res) => {
    const target = q.get('SELECT * FROM users WHERE username = ?', String(req.params.username).toLowerCase());
    if (!target) throw notFound('That player could not be found.');
    res.json(publicProfilePayload(target, req.user.id));
  }),
);

/** Same view, addressed by numeric user id (used by internal deep links). */
router.get(
  '/id/:id',
  requireAuth,
  handler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('Invalid player id.');
    const target = q.get('SELECT * FROM users WHERE id = ?', id);
    if (!target) throw notFound('That player could not be found.');
    res.json(publicProfilePayload(target, req.user.id));
  }),
);

function publicProfilePayload(target, viewerId) {
  if (target.status === 'banned' || target.status === 'deactivated') throw notFound('That player could not be found.');
  if (hasBlocked(target.id, viewerId)) throw forbidden('This profile is not available.');
  if (hasBlocked(viewerId, target.id)) throw forbidden('You have blocked this player. Unblock to view.');

  const profile = q.get('SELECT * FROM user_profiles WHERE user_id = ?', target.id);
  const stats = q.get('SELECT * FROM player_statistics WHERE user_id = ?', target.id);
  const interests = q.all(
    `SELECT i.key, i.label, i.category FROM user_interests ui JOIN interests i ON i.id = ui.interest_id
      WHERE ui.user_id = ? ORDER BY i.sort_order`,
    target.id,
  );
  const ranks = q.all(
    `SELECT r.game_key, r.rating, r.wins, r.losses, r.draws, g.name AS game_name
       FROM game_ranks r LEFT JOIN game_modes g ON g.key = r.game_key WHERE r.user_id = ?`,
    target.id,
  );
  const achievements = q.all(
    `SELECT a.key, a.name, a.icon FROM user_achievements ua JOIN achievements a ON a.id = ua.achievement_id
      WHERE ua.user_id = ? AND ua.unlocked_at IS NOT NULL ORDER BY ua.unlocked_at DESC LIMIT 12`,
    target.id,
  );
  const connection = getConnection(viewerId, target.id);
  const chem = connection
    ? q.get(
        'SELECT score FROM chemistry_scores WHERE user_a_id = MIN(?, ?) AND user_b_id = MAX(?, ?)',
        viewerId,
        target.id,
        viewerId,
        target.id,
      )
    : null;
  const pendingRequest = q.get(
    `SELECT id, from_user_id FROM connection_requests
      WHERE status = 'pending'
        AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))`,
    viewerId,
    target.id,
    target.id,
    viewerId,
  );

  return {
    user: {
      userId: target.id,
      username: target.username,
      displayName: profile?.display_name,
      bio: profile?.bio,
      avatarKind: profile?.avatar_kind,
      avatarValue: profile?.avatar_value,
      region: profile?.show_region ? profile?.region : null,
      languages: safeJson(profile?.languages, []),
      presence: publicPresence(target.id),
      level: stats?.level || 1,
      xp: stats?.xp || 0,
      gamesPlayed: stats?.games_played || 0,
      gamesWon: stats?.games_won || 0,
      // Chemistry is only meaningful between connected players.
      chemistry: chem?.score || 0,
    },
    interests,
    ranks: ranks.map((r) => ({ ...r, gameName: r.game_name })),
    achievements,
    relationship: {
      connected: Boolean(connection),
      pendingIncoming: pendingRequest && pendingRequest.from_user_id === target.id ? pendingRequest.id : null,
      pendingOutgoing: pendingRequest && pendingRequest.from_user_id === viewerId ? pendingRequest.id : null,
    },
  };
}

/** Discover: find players by shared interests and availability. */
router.get(
  '/discover',
  requireAuth,
  requireActive,
  handler(async (req, res) => {
    const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 20));
    const interestKey = req.query.interest ? String(req.query.interest) : null;
    const gameKey = req.query.game ? String(req.query.game) : null;
    const onlineOnly = req.query.online === '1';

    const blocked = blockedUserIds(req.user.id);
    const placeholders = blocked.length ? blocked.map(() => '?').join(',') : 'NULL';
    const params = [req.user.id, req.user.id, ...blocked];

    let sql = `
      SELECT u.id, u.username, u.last_seen_at, p.display_name, p.bio, p.avatar_kind, p.avatar_value,
             p.languages, p.region, p.show_region,
             s.level, s.games_played,
             (SELECT COUNT(*) FROM user_interests ui1
                JOIN user_interests ui2 ON ui2.interest_id = ui1.interest_id
               WHERE ui1.user_id = u.id AND ui2.user_id = ?) AS shared_interests
        FROM users u
        JOIN user_profiles p ON p.user_id = u.id
        JOIN user_preferences pref ON pref.user_id = u.id
        LEFT JOIN player_statistics s ON s.user_id = u.id
       WHERE u.id <> ?
         AND u.status = 'active'
         AND u.onboarded_at IS NOT NULL
         AND pref.discoverable = 1
         AND u.id NOT IN (${placeholders})`;
    if (interestKey) {
      sql += ` AND EXISTS (SELECT 1 FROM user_interests ui JOIN interests i ON i.id = ui.interest_id
                            WHERE ui.user_id = u.id AND i.key = ?)`;
      params.push(interestKey);
    }
    if (gameKey) {
      sql += ` AND EXISTS (SELECT 1 FROM json_each(pref.preferred_games) je WHERE je.value = ?)`;
      params.push(gameKey);
    }
    sql += ' ORDER BY shared_interests DESC, RANDOM() LIMIT ?';
    params.push(limit);

    let rows = q.all(sql, ...params);
    if (onlineOnly) rows = rows.filter((r) => publicPresence(r.id) === 'online');

    // Attach the actual shared interest labels so the UI can show them and filter.
    const myInterests = q.all(
      `SELECT i.id, i.key, i.label, i.category FROM user_interests ui JOIN interests i ON i.id = ui.interest_id
        WHERE ui.user_id = ? ORDER BY i.category, i.label`,
      req.user.id,
    );
    const myIds = new Set(myInterests.map((i) => i.id));

    res.json({
      players: rows.map((r) => {
        const theirIds = q
          .all('SELECT interest_id FROM user_interests WHERE user_id = ?', r.id)
          .map((x) => x.interest_id);
        const sharedIds = theirIds.filter((id) => myIds.has(id));
        return {
          userId: r.id,
          username: r.username,
          displayName: r.display_name,
          bio: r.bio,
          avatarKind: r.avatar_kind,
          avatarValue: r.avatar_value,
          region: r.show_region ? r.region : null,
          languages: safeJson(r.languages, []),
          level: r.level || 1,
          gamesPlayed: r.games_played || 0,
          sharedInterestCount: sharedIds.length,
          sharedInterestIds: sharedIds,
          interestIds: theirIds,
          sharedInterests: myInterests.filter((i) => sharedIds.includes(i.id)).map((i) => ({ id: i.id, key: i.key, label: i.label })),
          presence: publicPresence(r.id),
        };
      }),
      interests: myInterests.map((i) => ({ id: i.id, key: i.key, label: i.label, category: i.category, shared: true })),
      filters: { interest: interestKey, game: gameKey, online: onlineOnly },
    });
  }),
);

router.get(
  '/leaderboard',
  requireAuth,
  handler(async (req, res) => {
    const gameKey = req.query.game ? String(req.query.game) : null;
    const rows = gameKey
      ? q.all(
          `SELECT u.username, p.display_name, p.avatar_kind, p.avatar_value, r.rating, r.wins, r.losses, r.draws
             FROM game_ranks r JOIN users u ON u.id = r.user_id
             LEFT JOIN user_profiles p ON p.user_id = u.id
            WHERE r.game_key = ? AND u.status = 'active'
            ORDER BY r.rating DESC LIMIT 50`,
          gameKey,
        )
      : q.all(
          `SELECT u.username, p.display_name, p.avatar_kind, p.avatar_value, s.xp, s.level, s.games_won
             FROM player_statistics s JOIN users u ON u.id = s.user_id
             LEFT JOIN user_profiles p ON p.user_id = u.id
            WHERE u.status = 'active'
            ORDER BY s.xp DESC LIMIT 50`,
        );
    res.json({ leaderboard: rows, game: gameKey });
  }),
);

router.get(
  '/challenges',
  requireAuth,
  handler(async (req, res) => {
    const day = new Date().toISOString().slice(0, 10);
    const rows = q.all(
      `SELECT c.*, uc.progress, uc.completed_at, uc.claimed_at, uc.period_key
         FROM challenges c
         LEFT JOIN user_challenges uc ON uc.challenge_id = c.id AND uc.user_id = ?
        WHERE c.enabled = 1 AND (c.active_date IS NULL OR c.active_date = ?)
        ORDER BY c.scope, c.id`,
      req.user.id,
      day,
    );
    res.json({
      challenges: rows.map((c) => ({
        id: c.id,
        scope: c.scope,
        title: c.title,
        description: c.description,
        target: c.target,
        xpReward: c.xp_reward,
        progress: c.progress || 0,
        completed: Boolean(c.completed_at),
      })),
    });
  }),
);

router.get(
  '/history',
  requireAuth,
  handler(async (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const rows = q.all(
      `SELECT m.public_id, m.game_key, m.status, m.ended_at, m.created_at, p.score, p.result
         FROM match_participants p
         JOIN matches m ON m.id = p.match_id
        WHERE p.user_id = ? AND m.status IN ('completed','abandoned')
        ORDER BY m.id DESC LIMIT ?`,
      req.user.id,
      limit,
    );
    res.json({
      history: rows.map((r) => ({
        publicId: r.public_id,
        gameKey: r.game_key,
        status: r.status,
        score: r.score,
        result: r.result,
        at: r.ended_at || r.created_at,
      })),
    });
  }),
);

function safeJson(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

export default router;
