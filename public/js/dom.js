/** Tiny DOM helper layer. No framework, no build step. */

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value') el.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'autofocus') {
      el[key] = Boolean(value);
    } else if (key === 'aria-pressed' || key === 'aria-current' || key.startsWith('aria-') || key.startsWith('data-')) {
      el.setAttribute(key, value);
    } else {
      el.setAttribute(key, value);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
};

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

/** Escape text for safe interpolation into template strings. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function icon(name, size = 22) {
  const paths = {
    play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor"/>',
    compass:
      '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/><path d="M15.5 8.5l-2 5-5 2 2-5z" fill="currentColor"/>',
    inbox:
      '<path d="M3 7a2 2 0 012-2h14a2 2 0 012 2v7a2 2 0 01-2 2h-5l-2 3-2-3H5a2 2 0 01-2-2z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/>',
    users:
      '<circle cx="9" cy="8" r="3.2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M16 6.5a3 3 0 010 5.6M17.5 19c0-2-.6-3.6-1.6-4.6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    user:
      '<circle cx="12" cy="8.5" r="3.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    spark:
      '<path d="M12 3l2.2 6.2L20 12l-5.8 2.8L12 21l-2.2-6.2L4 12l5.8-2.8z" fill="currentColor"/>',
    mic:
      '<rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" stroke-width="2" fill="none"/><path d="M6 11a6 6 0 0012 0M12 17v4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    mask:
      '<path d="M4 9c0-1 .8-2 2-2h12c1.2 0 2 1 2 2 0 5-3.6 9-8 9s-8-4-8-9z" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="9" cy="11" r="1.4" fill="currentColor"/><circle cx="15" cy="11" r="1.4" fill="currentColor"/>',
    dice:
      '<rect x="4" y="4" width="16" height="16" rx="3.5" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="9" cy="9" r="1.4" fill="currentColor"/><circle cx="15" cy="15" r="1.4" fill="currentColor"/><circle cx="15" cy="9" r="1.4" fill="currentColor"/><circle cx="9" cy="15" r="1.4" fill="currentColor"/>',
    heart:
      '<path d="M12 20s-7-4.3-7-9a4 4 0 017-2.6A4 4 0 0119 11c0 4.7-7 9-7 9z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/>',
    chat:
      '<path d="M4 6a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2H9l-4 3v-3a2 2 0 01-1-2z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/>',
    send: '<path d="M4 12l16-8-6 8 6 8z" fill="currentColor"/>',
    trophy:
      '<path d="M7 4h10v5a5 5 0 01-10 0z" stroke="currentColor" stroke-width="2" fill="none"/><path d="M7 6H4v2a3 3 0 003 3M17 6h3v2a3 3 0 01-3 3M10 15h4v4h-4z" stroke="currentColor" stroke-width="2" fill="none"/><path d="M8 20h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    bolt: '<path d="M13 3l-7 10h5l-1 8 7-11h-5z" fill="currentColor"/>',
    shield:
      '<path d="M12 3l7 3v6c0 4-3 7.5-7 9-4-1.5-7-5-7-9V6z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/>',
    flag: '<path d="M6 21V4M6 4h11l-2 4 2 4H6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    block:
      '<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M6.5 17.5l11-11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    back: '<path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    close: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    settings:
      '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 3v2.5M12 18.5V21M4.2 7.5l2.2 1.2M17.6 15.3l2.2 1.2M4.2 16.5l2.2-1.2M17.6 8.7l2.2-1.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    logout:
      '<path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 16l-4-4 4-4M6 12h9" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    bell: '<path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M10 19a2 2 0 004 0" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    search:
      '<circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M16 16l4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    clock: '<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 7v5l3.5 2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    check: '<path d="M5 13l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M8.5 10V7.5a3.5 3.5 0 017 0V10" stroke="currentColor" stroke-width="2" fill="none"/>',
    eye: '<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/>',
    empty:
      '<rect x="3.5" y="6" width="17" height="13" rx="2.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M3.5 11h5l1.5 2.5h4L15.5 11h5" stroke="currentColor" stroke-width="2" fill="none"/>',
    wifi_off:
      '<path d="M3 4l18 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M5 11a11 11 0 016-3M12 18h.01" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths[name] || paths.spark;
  return svg;
}

export function avatarEl(user, size = 'md') {
  const src = resolveAvatarUrl(user);
  const img = h('img', {
    class: `avatar avatar--${size}`,
    src,
    alt: '',
    loading: 'lazy',
  });
  img.onerror = () => {
    img.src = MYSTERY;
  };
  if (!user?.presence) return img;
  const wrap = h('div', { class: 'avatar-wrap' }, img);
  if (user.presence === 'online') wrap.appendChild(h('span', { class: 'dot dot--online', title: 'Online' }));
  return wrap;
}

const MYSTERY = '/assets/mystery.svg';

/**
 * Turn a server avatar descriptor into a displayable URL. Presets arrive as
 * data URIs from the API and are cached by the shell at boot.
 */
export function resolveAvatarUrl(user) {
  if (!user) return MYSTERY;
  if (user.avatarUrl) return user.avatarUrl;
  const kind = user.avatarKind ?? user.avatar_kind;
  const value = user.avatarValue ?? user.avatar_value;
  if (value === 'mystery') return MYSTERY;
  if (kind === 'upload' && value) return `/api/media/${value}`;
  const presets = window.__vybzAvatarPresets || {};
  if (value && presets[value]) return presets[value];
  if (typeof value === 'string' && value.startsWith('data:')) return value;
  return MYSTERY;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso.replace(' ', 'T') + (iso.includes('Z') || iso.includes('+') ? '' : 'Z'));
  const diff = Date.now() - then.getTime();
  if (Number.isNaN(diff)) return '';
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const d = Math.floor(hrs / 24);
  if (d < 7) return `${d}d ago`;
  return then.toLocaleDateString();
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
