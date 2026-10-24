/** Reusable UI pieces shared across views. */
import { h, icon, avatarEl, timeAgo } from './dom.js';
import { store } from './state.js';

export function brand({ tagline = false } = {}) {
  return h(
    'div',
    { class: 'brand' },
    h('div', { class: 'brand__mark' }, icon('spark', 20)),
    h(
      'div',
      {},
      h('div', { class: 'brand__name' }, 'VYBZ'),
      tagline ? h('div', { class: 'brand__tag' }, 'Meet through play. Connect through chemistry.') : null,
    ),
  );
}

export function pageHead({ eyebrow, title, subtitle, actions = [] }) {
  return h(
    'header',
    { class: 'stack stack--sm', style: { marginBottom: '20px' } },
    eyebrow ? h('div', { class: 'eyebrow' }, eyebrow) : null,
    h('div', { class: 'row row--between row--wrap' }, h('h1', {}, title), actions.length ? h('div', { class: 'btn-row' }, actions) : null),
    subtitle ? h('p', { class: 'muted small', style: { marginBottom: '0' } }, subtitle) : null,
  );
}

export function sectionHead(title, actions = []) {
  return h(
    'div',
    { class: 'section-head' },
    h('h2', {}, title),
    actions.length ? h('div', { class: 'btn-row' }, actions) : null,
  );
}

export function statTile(value, label, variant = '') {
  return h(
    'div',
    { class: `stat ${variant ? `stat--${variant}` : ''}` },
    h('div', { class: 'stat__value' }, String(value)),
    h('div', { class: 'stat__label' }, label),
  );
}

export function pill(text, variant = '', extra = {}) {
  return h('span', { class: `pill ${variant ? `pill--${variant}` : ''}`, ...extra }, text);
}

export function presenceDot(presence) {
  const map = { online: 'dot--online', offline: 'dot--offline', hidden: 'dot--hidden' };
  const label = { online: 'Online', offline: 'Offline', hidden: 'Presence hidden' };
  return h('span', { class: `dot ${map[presence] || 'dot--offline'}`, title: label[presence] || '' });
}

export function playerRow(user, { onClick, subtitle, right, extraClass = '' } = {}) {
  return h(
    'button',
    {
      class: `list-item ${extraClass}`,
      type: 'button',
      onclick: onClick,
      disabled: !onClick,
    },
    avatarEl({ ...user, presence: user.presence }, 'md'),
    h(
      'div',
      { class: 'grow', style: { textAlign: 'left' } },
      h('div', { class: 'row', style: { gap: '7px' } },
        h('span', { class: 'strong truncate' }, user.displayName || user.display_name || user.username),
        user.level ? pill(`Lv ${user.level}`, 'violet') : null,
      ),
      subtitle ? h('div', { class: 'small dim truncate' }, subtitle) : null,
    ),
    right || null,
  );
}

/** Loading skeleton list. */
export function skeletons(count = 3, variant = 'block') {
  return h(
    'div',
    { class: 'stack' },
    ...Array.from({ length: count }, () => h('div', { class: `skeleton skeleton--${variant}` })),
  );
}

/** Consistent empty / error / loading state block. */
export function stateBlock({ iconName = 'empty', title, body, actions = [] }) {
  return h(
    'div',
    { class: 'state' },
    h('div', { class: 'state__icon' }, icon(iconName, 26)),
    h('div', { class: 'state__title' }, title),
    body ? h('div', { class: 'state__body' }, body) : null,
    actions.length ? h('div', { class: 'btn-row', style: { justifyContent: 'center' } }, actions) : null,
  );
}

export function loadingBlock(message = 'Loading…') {
  return h(
    'div',
    { class: 'state' },
    h('div', { style: { display: 'grid', placeItems: 'center', marginBottom: '12px' } }, h('div', { class: 'spinner spinner--lg' })),
    h('div', { class: 'state__body', style: { marginBottom: '0' } }, message),
  );
}

export function errorBlock(message, onRetry) {
  return stateBlock({
    iconName: 'wifi_off',
    title: 'Something went wrong',
    body: message || 'We could not load this right now.',
    actions: onRetry ? [h('button', { class: 'btn btn--primary', onclick: onRetry }, 'Try again')] : [],
  });
}

export function banner(message, variant = 'info', actions = []) {
  return h(
    'div',
    { class: `banner banner--${variant}` },
    h('div', { class: 'grow' }, message),
    ...actions,
  );
}

/** Circular countdown driven by a server-provided deadline. */
export function countdown({ deadline, totalSeconds, onExpire, label = '' }) {
  const R = 22;
  const C = 2 * Math.PI * R;
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('class', 'timer__value');
  circle.setAttribute('cx', '26');
  circle.setAttribute('cy', '26');
  circle.setAttribute('r', String(R));
  circle.setAttribute('stroke-dasharray', String(C));
  circle.setAttribute('stroke-dashoffset', '0');

  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  track.setAttribute('class', 'timer__track');
  track.setAttribute('cx', '26');
  track.setAttribute('cy', '26');
  track.setAttribute('r', String(R));

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 52 52');
  svg.appendChild(track);
  svg.appendChild(circle);

  const text = h('span', { class: 'timer__label', 'aria-live': 'off' }, '');
  const ring = h('div', { class: 'timer__ring' }, svg, h('div', { class: 'timer__value', style: { position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', fontSize: '14px', fontWeight: '800' } }, text));
  const wrap = h('div', { class: 'timer' }, ring, label ? h('div', { class: 'small dim' }, label) : null);

  const end = new Date(String(deadline).replace(' ', 'T') + (String(deadline).includes('Z') ? '' : 'Z')).getTime();
  const total = Math.max(1, Number(totalSeconds) || 30);
  let expired = false;
  let raf = null;

  const tick = () => {
    const remainingMs = end - Date.now();
    const remaining = Math.max(0, remainingMs / 1000);
    text.textContent = `${Math.ceil(remaining)}s`;
    const fraction = Math.max(0, Math.min(1, remaining / total));
    circle.setAttribute('stroke-dashoffset', String(C * (1 - fraction)));
    wrap.classList.toggle('timer--urgent', remaining <= total * 0.4 && remaining > total * 0.15);
    wrap.classList.toggle('timer--critical', remaining <= total * 0.15);
    if (remainingMs <= 0 && !expired) {
      expired = true;
      onExpire?.();
      return;
    }
    if (!expired) raf = setTimeout(tick, 250);
  };
  tick();
  wrap.destroy = () => {
    expired = true;
    if (raf) clearTimeout(raf);
  };
  return wrap;
}

export function roundDots(total, current, phase) {
  const dots = [];
  for (let i = 1; i <= total; i += 1) {
    let cls = 'round-dot';
    if (i < current || (i === current && phase === 'scored')) cls += ' round-dot--done';
    else if (i === current) cls += ' round-dot--active';
    dots.push(h('span', { class: cls, title: `Round ${i}` }));
  }
  return h('div', { class: 'round-dots', 'aria-label': `Round ${current} of ${total}` }, dots);
}

export function levelBar(progress) {
  if (!progress) return null;
  return h(
    'div',
    { class: 'stack stack--sm' },
    h(
      'div',
      { class: 'row row--between small' },
      h('span', { class: 'strong' }, `Level ${progress.level}`),
      h('span', { class: 'dim' }, `${progress.intoLevel} / ${progress.levelSpan} XP`),
    ),
    h('div', { class: 'progress' }, h('div', { class: 'progress__bar', style: { width: `${progress.percent}%` } })),
  );
}

export function chemMeter(score, label) {
  const R = 24;
  const C = 2 * Math.PI * R;
  const pct = Math.min(100, Math.round((score / 140) * 100));
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '29');
  circle.setAttribute('cy', '29');
  circle.setAttribute('r', String(R));
  circle.setAttribute('stroke', 'url(#chemGrad)');
  circle.setAttribute('stroke-dasharray', String(C));
  circle.setAttribute('stroke-dashoffset', String(C * (1 - pct / 100)));
  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  track.setAttribute('cx', '29');
  track.setAttribute('cy', '29');
  track.setAttribute('r', String(R));
  track.setAttribute('stroke', 'var(--surface-3)');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML =
    '<linearGradient id="chemGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#ec4899"/></linearGradient>';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 58 58');
  svg.appendChild(defs);
  svg.appendChild(track);
  svg.appendChild(circle);
  return h(
    'div',
    { class: 'chem-meter' },
    h('div', { class: 'chem-meter__ring' }, svg, h('div', { class: 'chem-meter__value' }, String(score))),
    h(
      'div',
      { class: 'grow' },
      h('div', { class: 'strong' }, label || 'Chemistry'),
      h('div', { class: 'small dim' }, 'Built from real shared games, signals and interests.'),
    ),
  );
}

export function notificationItem(n, { onOpen } = {}) {
  return h(
    'button',
    {
      class: `list-item ${n.read ? '' : 'list-item--unread'}`,
      type: 'button',
      onclick: () => onOpen?.(n),
    },
    h('div', { class: 'grow', style: { textAlign: 'left' } },
      h('div', { class: 'row', style: { gap: '8px' } },
        h('span', { class: 'strong small' }, n.title),
        !n.read ? h('span', { class: 'notif-dot' }) : null,
      ),
      n.body ? h('div', { class: 'small dim clamp-2' }, n.body) : null,
      h('div', { class: 'tiny dim', style: { marginTop: '3px' } }, timeAgo(n.at)),
    ),
  );
}

export function connectionPill() {
  const state = store.connection;
  if (state === 'online') return null;
  const text = state === 'reconnecting' ? 'Reconnecting…' : 'Offline';
  return pill(text, state === 'offline' ? 'red' : 'amber');
}
