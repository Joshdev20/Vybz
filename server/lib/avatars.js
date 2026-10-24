/**
 * Preset avatars. These are generated as inline SVG data URIs so the core
 * experience never depends on external media storage.
 */
const PRESET_DEFS = [
  { key: 'preset-1', from: '#7c3aed', to: '#c026d3', glyph: 'spark' },
  { key: 'preset-2', from: '#4c1d95', to: '#7c3aed', glyph: 'wave' },
  { key: 'preset-3', from: '#db2777', to: '#7c3aed', glyph: 'flame' },
  { key: 'preset-4', from: '#0f766e', to: '#7c3aed', glyph: 'leaf' },
  { key: 'preset-5', from: '#b45309', to: '#db2777', glyph: 'sun' },
  { key: 'preset-6', from: '#1e293b', to: '#7c3aed', glyph: 'moon' },
  { key: 'preset-7', from: '#be123c', to: '#f97316', glyph: 'bolt' },
  { key: 'preset-8', from: '#0369a1', to: '#22d3ee', glyph: 'drop' },
  { key: 'preset-9', from: '#581c87', to: '#ec4899', glyph: 'heart' },
  { key: 'preset-10', from: '#134e4a', to: '#a3e635', glyph: 'star' },
  { key: 'preset-11', from: '#3f3f46', to: '#a1a1aa', glyph: 'diamond' },
  { key: 'preset-12', from: '#831843', to: '#f472b6', glyph: 'petal' },
];

const GLYPHS = {
  spark: '<path d="M32 14l4.2 11.8L48 30l-11.8 4.2L32 46l-4.2-11.8L16 30l11.8-4.2z" fill="#fff" opacity=".9"/>',
  wave: '<path d="M14 34c6-8 12 8 18 0s12 8 18 0" stroke="#fff" stroke-width="3.5" fill="none" opacity=".9" stroke-linecap="round"/>',
  flame: '<path d="M32 14c6 8 10 12 10 18a10 10 0 11-20 0c0-6 4-10 10-18z" fill="#fff" opacity=".9"/>',
  leaf: '<path d="M20 44c0-14 10-24 24-26-2 14-10 24-24 26z" fill="#fff" opacity=".9"/>',
  sun: '<circle cx="32" cy="30" r="9" fill="#fff" opacity=".9"/><g stroke="#fff" stroke-width="3" opacity=".8" stroke-linecap="round"><path d="M32 12v4M32 44v4M14 30h4M46 30h4M19 17l3 3M42 40l3 3M45 17l-3 3M22 40l-3 3"/></g>',
  moon: '<path d="M38 14a18 18 0 100 32 14 14 0 010-32z" fill="#fff" opacity=".9"/>',
  bolt: '<path d="M34 12l-14 22h10l-4 18 16-24H32z" fill="#fff" opacity=".9"/>',
  drop: '<path d="M32 12c8 10 12 15 12 21a12 12 0 11-24 0c0-6 4-11 12-21z" fill="#fff" opacity=".9"/>',
  heart: '<path d="M32 46S14 35 14 25a9 9 0 0118-3 9 9 0 0118 3c0 10-18 21-18 21z" fill="#fff" opacity=".9"/>',
  star: '<path d="M32 13l5.6 12.6L51 27.3 40 36.6l3 13.4-11-6.4-11 6.4 3-13.4L13 27.3l13.4-1.7z" fill="#fff" opacity=".9"/>',
  diamond: '<path d="M32 13l15 17-15 21-15-21z" fill="#fff" opacity=".9"/>',
  petal: '<circle cx="32" cy="30" r="7" fill="#fff" opacity=".95"/><g fill="#fff" opacity=".55"><circle cx="32" cy="17" r="5"/><circle cx="45" cy="30" r="5"/><circle cx="32" cy="43" r="5"/><circle cx="19" cy="30" r="5"/></g>',
};

function svgFor({ from, to, glyph }) {
  const g = GLYPHS[glyph] || GLYPHS.spark;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
</linearGradient></defs>
<rect width="64" height="64" rx="18" fill="url(#g)"/>${g}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export const AVATAR_PRESETS = PRESET_DEFS.map((p) => ({
  key: p.key,
  label: p.key.replace('preset-', 'Avatar '),
  dataUri: svgFor(p),
}));

const PRESET_KEYS = new Set(PRESET_DEFS.map((p) => p.key));

export function isPresetAvatar(key) {
  return PRESET_KEYS.has(String(key));
}

/** Mystery avatar used before a Blind Vibe reveal. */
export const MYSTERY_AVATAR = svgFor({ from: '#27272a', to: '#52525b', glyph: 'diamond' });

export function avatarFor(kind, value, userId) {
  if (kind === 'upload' && value) return `/api/media/${value}`;
  if (value === 'mystery') return MYSTERY_AVATAR;
  if (isPresetAvatar(value)) return AVATAR_PRESETS.find((p) => p.key === value).dataUri;
  const fallback = AVATAR_PRESETS[Math.abs(Number(userId) || 0) % AVATAR_PRESETS.length];
  return fallback.dataUri;
}
