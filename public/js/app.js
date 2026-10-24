import { h, mount, clear, icon } from './dom.js';
import { api, ApiError } from './api.js';
import { store, setState, toast, showModal, closeModal, confirmDialog } from './state.js';
import { connect, disconnect, on as onRealtime } from './realtime.js';
import { brand, notificationItem, connectionPill, stateBlock } from './components.js';

import * as AuthView from './views/auth.js';
import * as OnboardingView from './views/onboarding.js';
import * as PlayView from './views/play.js';
import * as MatchView from './views/match.js';
import * as DiscoverView from './views/discover.js';
import * as InboxView from './views/inbox.js';
import * as ConnectionsView from './views/connections.js';
import * as ProfileView from './views/profile.js';
import * as SignalsView from './views/signals.js';
import * as RoomsView from './views/rooms.js';
import * as BlindVibeView from './views/blindVibe.js';
import * as AdminView from './views/admin.js';

const app = document.getElementById('app');

/* ------------------------------- routes ------------------------------- */

const routes = [
  { path: '/play', title: 'Play', nav: true, icon: 'play', view: PlayView.render },
  { path: '/discover', title: 'Discover', nav: true, icon: 'compass', view: DiscoverView.render },
  { path: '/inbox', title: 'Inbox', nav: true, icon: 'inbox', view: InboxView.render, badge: 'unreadMessages' },
  { path: '/connections', title: 'Connections', nav: true, icon: 'users', view: ConnectionsView.render, badge: 'pendingRequests' },
  { path: '/profile', title: 'Profile', nav: true, icon: 'user', view: ProfileView.render },
  { path: '/signals', title: 'Secret Signals', icon: 'mask', view: SignalsView.render, badge: 'pendingSignals' },
  { path: '/rooms', title: 'Spill It!', icon: 'dice', view: RoomsView.render },
  { path: '/blind-vibe', title: 'Blind Vibe', icon: 'heart', view: BlindVibeView.render },
  { path: '/admin', title: 'Administration', icon: 'shield', view: AdminView.render, admin: true },
];

function matchRoute(pathname) {
  if (pathname.startsWith('/match/')) {
    return { path: pathname, title: 'Match', view: MatchView.render, params: { publicId: pathname.split('/')[2] } };
  }
  if (pathname.startsWith('/blind-vibe/')) {
    return { path: pathname, title: 'Blind Vibe', view: BlindVibeView.render, params: { publicId: pathname.split('/')[2] } };
  }
  if (pathname.startsWith('/inbox/')) {
    return {
      path: '/inbox',
      title: 'Conversation',
      view: InboxView.render,
      params: { conversationId: pathname.split('/')[2] },
    };
  }
  if (pathname.startsWith('/profile/')) {
    return { path: '/profile', title: 'Profile', view: ProfileView.render, params: { usernameOrId: pathname.split('/')[2] } };
  }
  if (pathname.startsWith('/rooms/')) {
    return { path: pathname, title: 'Room', view: RoomsView.render, params: { roomId: pathname.split('/')[2] } };
  }
  const found = routes.find((r) => r.path === pathname);
  return found || routes[0];
}

/* ------------------------------ navigation ------------------------------ */

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  setState({ route: path });
  renderRoute();
}

window.addEventListener('popstate', () => {
  setState({ route: location.pathname });
  renderRoute();
});

/* -------------------------------- layout -------------------------------- */

function navButton(route, currentPath) {
  const active = currentPath === route.path || (route.path === '/play' && currentPath.startsWith('/match'));
  const count = route.badge ? store.counters[route.badge] : 0;
  return h(
    'button',
    {
      class: 'nav-item',
      type: 'button',
      'aria-current': active ? 'page' : null,
      'aria-label': route.title,
      onclick: () => navigate(route.path),
    },
    icon(route.icon, 22),
    h('span', {}, route.title === 'Connections' ? 'Links' : route.title),
    count > 0 ? h('span', { class: 'nav-badge' }, count > 9 ? '9+' : String(count)) : null,
  );
}

function sidebar(currentPath) {
  const navRoutes = routes.filter((r) => r.nav);
  return h(
    'aside',
    { class: 'sidebar', 'aria-label': 'Main navigation' },
    brand({ tagline: true }),
    h(
      'nav',
      { class: 'stack stack--sm', style: { marginTop: '18px' } },
      ...navRoutes.map((r) =>
        h(
          'button',
          {
            class: `list-item ${currentPath === r.path ? 'list-item--unread' : ''}`,
            type: 'button',
            onclick: () => navigate(r.path),
          },
          h('span', { style: { display: 'grid', placeItems: 'center', width: '22px' } }, icon(r.icon, 19)),
          h('span', { class: 'grow', style: { textAlign: 'left', fontWeight: '600' } }, r.title),
          r.badge && store.counters[r.badge] > 0
            ? h('span', { class: 'pill pill--pink' }, String(store.counters[r.badge]))
            : null,
        ),
      ),
    ),
    h('div', { style: { flex: '1' } }),
    h(
      'div',
      { class: 'stack stack--sm' },
      ...[
        { path: '/signals', label: 'Secret Signals', icon: 'mask' },
        { path: '/rooms', label: 'Spill It! Rooms', icon: 'dice' },
        { path: '/blind-vibe', label: 'Blind Vibe', icon: 'heart' },
      ].map((item) =>
        h(
          'button',
          {
            class: 'list-item list-item--static',
            type: 'button',
            style: { background: 'transparent', border: '1px solid transparent' },
            onclick: () => navigate(item.path),
          },
          h('span', { style: { display: 'grid', placeItems: 'center', width: '22px' } }, icon(item.icon, 19)),
          h('span', { class: 'grow small', style: { textAlign: 'left' } }, item.label),
          item.path === '/signals' && store.counters.pendingSignals > 0
            ? h('span', { class: 'notif-dot' })
            : null,
        ),
      ),
      store.user && (store.user.role === 'admin' || store.user.role === 'moderator')
        ? h(
            'button',
            { class: 'list-item list-item--static', type: 'button', onclick: () => navigate('/admin') },
            h('span', { style: { display: 'grid', placeItems: 'center', width: '22px' } }, icon('shield', 19)),
            h('span', { class: 'grow small', style: { textAlign: 'left' } }, 'Administration'),
          )
        : null,
      h(
        'button',
        { class: 'list-item list-item--static', type: 'button', onclick: () => openNotifications() },
        h('span', { style: { display: 'grid', placeItems: 'center', width: '22px' } }, icon('bell', 19)),
        h('span', { class: 'grow small', style: { textAlign: 'left' } }, 'Notifications'),
        store.counters.unreadNotifications > 0 ? h('span', { class: 'notif-dot' }) : null,
      ),
    ),
  );
}

function bottomNav(currentPath) {
  return h('nav', { class: 'bottom-nav', 'aria-label': 'Primary' }, ...routes.filter((r) => r.nav).map((r) => navButton(r, currentPath)));
}

function topBar(route) {
  const showBack = !routes.some((r) => r.nav && r.path === route.path);
  return h(
    'div',
    { class: 'row row--between', style: { marginBottom: '14px' } },
    h(
      'div',
      { class: 'row' },
      showBack
        ? h('button', { class: 'btn btn--ghost btn--icon', 'aria-label': 'Go back', onclick: () => history.back() }, icon('back', 18))
        : null,
      h('div', { class: 'row', style: { gap: '9px' } },
        h('span', { class: 'strong' }, route.title),
        connectionPill(),
      ),
    ),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        { class: 'btn btn--ghost btn--icon', 'aria-label': 'Notifications', onclick: () => openNotifications() },
        icon('bell', 18),
        store.counters.unreadNotifications > 0 ? h('span', { class: 'nav-badge', style: { top: '-2px', right: '-2px', transform: 'none' } }, String(store.counters.unreadNotifications)) : null,
      ),
    ),
  );
}

/* ------------------------------ render route ------------------------------ */

let renderToken = 0;

export async function renderRoute() {
  if (!store.user) {
    const path = location.pathname;
    if (path === '/register') return AuthView.renderRegister(app);
    return AuthView.renderLogin(app);
  }
  if (!store.user.onboarded) return OnboardingView.render(app);

  const route = matchRoute(location.pathname);
  const token = ++renderToken;
  clear(app);
  const main = h('main', { class: 'shell__main', id: 'main' });
  const wrap = h('div', { class: route.path === '/admin' ? 'wrap wrap--wide' : 'wrap' });
  const content = h('div', {});
  wrap.appendChild(topBar(route));
  wrap.appendChild(content);
  main.appendChild(wrap);
  app.appendChild(h('div', { class: 'shell' }, sidebar(location.pathname), main));
  app.appendChild(bottomNav(location.pathname));

  mount(content, h('div', { class: 'state' }, h('div', { class: 'spinner spinner--lg', style: { margin: '0 auto' } })));

  try {
    await route.view(content, { route, navigate, params: route.params || {}, token, isCurrent: () => token === renderToken });
  } catch (err) {
    if (token !== renderToken) return;
    console.error('[route] render failed', err);
    if (err instanceof ApiError && err.status === 401) {
      setState({ user: null });
      return renderRoute();
    }
    mount(
      content,
      stateBlock({
        iconName: 'wifi_off',
        title: 'Could not load this page',
        body: err.message || 'Please try again.',
        actions: [h('button', { class: 'btn btn--primary', onclick: () => renderRoute() }, 'Retry')],
      }),
    );
  }
  // Update document title.
  document.title = `${route.title} — VYBZ`;
}

/* ---------------------------- notifications ---------------------------- */

async function openNotifications() {
  const container = h('div', { class: 'stack' }, h('div', { class: 'state' }, h('div', { class: 'spinner spinner--lg', style: { margin: '0 auto' } })));
  const modal = showModal({
    title: 'Notifications',
    body: container,
    actions: [{ label: 'Mark all read', variant: 'ghost', close: false, onClick: async () => {
      await api.post('/api/notifications/read', {});
      await refreshCounters();
      openNotifications();
    } }],
  });
  try {
    const data = await api.get('/api/notifications');
    if (!data.notifications.length) {
      mount(
        container,
        stateBlock({ iconName: 'bell', title: 'Nothing yet', body: 'Matches, signals, room invites and results will show up here.' }),
      );
      return;
    }
    mount(
      container,
      ...data.notifications.map((n) =>
        notificationItem(n, {
          onOpen: async (item) => {
            await api.post('/api/notifications/read', { ids: [item.id] });
            await refreshCounters();
            closeModal();
            if (item.link) navigate(item.link);
          },
        }),
      ),
    );
  } catch (err) {
    mount(container, stateBlock({ iconName: 'wifi_off', title: 'Could not load notifications', body: err.message }));
  }
}

/* ------------------------------- counters ------------------------------- */

export async function refreshCounters() {
  try {
    const dash = await api.get('/api/play/dashboard');
    setState({
      counters: {
        unreadMessages: dash.unreadMessages,
        unreadNotifications: dash.unreadNotifications,
        pendingSignals: dash.signalsPending,
        pendingRequests: dash.pendingRequests || store.counters.pendingRequests,
      },
      statistics: dash.statistics,
      progress: dash.progress,
    });
  } catch {
    /* counters are best-effort */
  }
}

/* ------------------------------- session ------------------------------- */

async function loadSession() {
  try {
    const me = await api.get('/api/auth/me');
    if (me.user) {
      setState({
        user: me.user,
        profile: me.profile,
        preferences: me.preferences,
        statistics: me.statistics,
      });
      if (me.preferences?.reduced_motion) {
        document.body.dataset.reducedMotion = '1';
      }
      connect();
      setupRealtimeHandlers();
      await refreshCounters();
    }
  } catch {
    setState({ user: null });
  }
}

let realtimeWired = false;
function setupRealtimeHandlers() {
  if (realtimeWired) return;
  realtimeWired = true;

  onRealtime('notification', (n) => {
    setState({ counters: { ...store.counters, unreadNotifications: store.counters.unreadNotifications + 1 } });
    if (n.kind !== 'message') toast(n.title, 'info');
    const route = matchRoute(location.pathname);
    if (route.path.startsWith('/match') || route.path.startsWith('/rooms') || route.path.startsWith('/blind-vibe')) {
      // Views subscribe to detail events themselves; nothing to do here.
    }
  });
  onRealtime('match_found', (payload) => {
    toast('Match found! Accept to start playing.', 'success');
    refreshCounters();
  });
  onRealtime('queue_expired', () => {
    toast('Your matchmaking search timed out. You can search again.', 'info');
  });
  onRealtime('message', () => {
    setState({ counters: { ...store.counters, unreadMessages: store.counters.unreadMessages + 1 } });
  });
  onRealtime('unread', (payload) => {
    setState({ counters: { ...store.counters, unreadMessages: payload.total } });
  });
  onRealtime('connection', ({ state }) => {
    if (state === 'online') toast('Reconnected.', 'success', 1800);
  });
}

/* ------------------------------- boot ------------------------------- */

export async function boot() {
  // Respect reduced-motion preference from the OS.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    document.body.dataset.reducedMotion = '1';
  }
  if (!location.pathname || location.pathname === '/') {
    history.replaceState({}, '', '/play');
  }
  await loadSession();
  if (store.user) {
    // Cache avatar presets so every view can resolve them synchronously.
    try {
      const data = await api.get('/api/profile/interests');
      window.__vybzAvatarPresets = Object.fromEntries((data.avatarPresets || []).map((p) => [p.key, p.dataUri]));
    } catch {
      window.__vybzAvatarPresets = {};
    }
    await renderRoute();
  } else if (location.pathname === '/register') AuthView.renderRegister(app);
  else AuthView.renderLogin(app);
}

window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandled]', e.reason);
});

boot();
