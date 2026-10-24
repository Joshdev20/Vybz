/** Shared client state + a tiny reactive store. */

export const store = {
  user: null,
  profile: null,
  preferences: null,
  statistics: null,
  progress: null,
  counters: { unreadMessages: 0, unreadNotifications: 0, pendingSignals: 0, pendingRequests: 0 },
  modes: [],
  judge: null,
  presence: 'offline',
  connection: 'connecting',
  route: '/play',
  reducedMotion: false,
  lastError: null,
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setState(patch) {
  Object.assign(store, patch);
  for (const fn of listeners) fn(store);
}

export function isAuthed() {
  return Boolean(store.user);
}

export function isAdmin() {
  return store.user && (store.user.role === 'admin' || store.user.role === 'moderator');
}

/* ------------------------------- toasts ------------------------------- */

export function toast(message, kind = 'info', ms = 3600) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 250);
  }, ms);
}

/* ------------------------------- modals ------------------------------- */

let openModal = null;

export function showModal({ title, body, actions = [], onClose = null, dismissible = true }) {
  closeModal();
  const root = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');

  const sheet = document.createElement('div');
  sheet.className = 'modal';
  sheet.appendChild(Object.assign(document.createElement('div'), { className: 'modal__grab' }));

  const head = document.createElement('div');
  head.className = 'modal__head';
  const h2 = document.createElement('h2');
  h2.textContent = title || '';
  head.appendChild(h2);
  if (dismissible) {
    const close = document.createElement('button');
    close.className = 'btn btn--ghost btn--icon';
    close.setAttribute('aria-label', 'Close dialog');
    close.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    close.onclick = () => closeModal();
    head.appendChild(close);
  }
  sheet.appendChild(head);

  const content = document.createElement('div');
  content.className = 'stack';
  if (typeof body === 'string') content.innerHTML = body;
  else if (body) content.appendChild(body);
  sheet.appendChild(content);

  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'btn-row';
    row.style.marginTop = '18px';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.className = `btn ${a.variant ? `btn--${a.variant}` : 'btn--ghost'}`;
      if (a.block) btn.classList.add('btn--block');
      btn.textContent = a.label;
      btn.onclick = async () => {
        if (a.onClick) {
          const result = await a.onClick();
          if (result === false) return;
        }
        if (a.close !== false) closeModal();
      };
      row.appendChild(btn);
    }
    sheet.appendChild(row);
  }

  backdrop.appendChild(sheet);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop && dismissible) closeModal();
  });
  root.appendChild(backdrop);
  openModal = { backdrop, onClose };

  // Focus trap: focus the first control so keyboard users land inside.
  const focusable = sheet.querySelector('button, input, textarea, select, a[href]');
  if (focusable) focusable.focus();

  const onKey = (e) => {
    if (e.key === 'Escape' && dismissible) closeModal();
    if (e.key === 'Tab') {
      const items = [...sheet.querySelectorAll('button, input, textarea, select, a[href]')].filter(
        (el) => !el.disabled,
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener('keydown', onKey);
  openModal.cleanup = () => document.removeEventListener('keydown', onKey);
  return backdrop;
}

export function closeModal() {
  if (!openModal) return;
  openModal.cleanup?.();
  openModal.backdrop.remove();
  const cb = openModal.onClose;
  openModal = null;
  if (cb) cb();
}

/** Confirmation dialog that resolves to true/false. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    showModal({
      title,
      body: `<p class="muted">${escapeHtml(message)}</p>`,
      actions: [
        { label: 'Cancel', variant: 'ghost', onClick: () => done(false) },
        {
          label: confirmLabel,
          variant: danger ? 'danger' : 'primary',
          onClick: () => done(true),
        },
      ],
      onClose: () => done(false),
    });
  });
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
