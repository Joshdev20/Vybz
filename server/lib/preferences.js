/**
 * Preferences serialization shared by every endpoint that returns a
 * user_preferences row. The `preferred_games` column is stored as JSON text,
 * so it must be decoded before it reaches the client.
 */

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** Decode JSON columns on a user_preferences row. Returns null for no row. */
export function publicPreferences(prefs) {
  if (!prefs) return null;
  return { ...prefs, preferred_games: parseJson(prefs.preferred_games, []) };
}
