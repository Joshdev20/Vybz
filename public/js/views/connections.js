import { h, mount, clear, icon, avatarEl, timeAgo } from '../dom.js';
import { api } from '../api.js';
import { store, setState, toast, confirmDialog, showModal } from '../state.js';
import { pageHead, pill, stateBlock, errorBlock, loadingBlock, chemMeter, banner, sectionHead } from '../components.js';

export async function render(root, ctx) {
  mount(root, loadingBlock('Loading your connections…'));
  let data;
  const load = async (silent = false) => {
    if (!silent) mount(root, loadingBlock('Loading connections…'));
    try {
      data = await api.get('/api/connections');
      if (ctx.isCurrent()) {
        setState({ counters: { ...store.counters, pendingRequests: data.requests.incoming.length } });
        paint();
      }
    } catch (err) {
      if (ctx.isCurrent()) mount(root, errorBlock(err.message, () => load()));
    }
  };

  function paint() {
    const container = h('div', { class: 'stack stack--lg' });
    container.appendChild(
      pageHead({
        eyebrow: 'Connections',
        title: 'Your connections',
        subtitle: 'People you have mutually connected with through games and signals. Chemistry reflects real shared activity, not message volume.',
      }),
    );

    /* --------------------------- pending requests --------------------------- */
    const incoming = data.requests.incoming || [];
    const outgoing = data.requests.outgoing || [];

    if (incoming.length) {
      container.appendChild(
        h(
          'div',
          {},
          sectionHead(`Requests (${incoming.length})`),
          h(
            'div',
            { class: 'stack stack--sm' },
            ...incoming.map((r) =>
              h(
                'div',
                { class: 'list-item list-item--static' },
                avatarEl(r.user, 'md'),
                h(
                  'div',
                  { class: 'grow', style: { textAlign: 'left' } },
                  h('div', { class: 'strong' }, r.user.displayName || r.user.username),
                  h('div', { class: 'small dim' }, r.message || `Wants to connect · ${timeAgo(r.createdAt)}`),
                  pill('Pending — not yet a connection', 'amber', { style: 'margin-top:6px' }),
                ),
                h(
                  'div',
                  { class: 'stack stack--sm' },
                  h('button', { class: 'btn btn--primary btn--sm', onclick: () => accept(r) }, 'Accept'),
                  h('button', { class: 'btn btn--ghost btn--sm', onclick: () => decline(r) }, 'Decline'),
                ),
              ),
            ),
          ),
        ),
      );
    }

    if (outgoing.length) {
      container.appendChild(
        h(
          'div',
          {},
          sectionHead('Sent requests'),
          h(
            'div',
            { class: 'stack stack--sm' },
            ...outgoing.map((r) =>
              h(
                'div',
                { class: 'list-item list-item--static' },
                avatarEl(r.user, 'sm'),
                h('div', { class: 'grow', style: { textAlign: 'left' } },
                  h('div', { class: 'strong small' }, r.user.displayName || r.user.username),
                  h('div', { class: 'tiny dim' }, `Sent ${timeAgo(r.createdAt)}`),
                ),
                pill('Awaiting reply', 'amber'),
                h('button', { class: 'btn btn--ghost btn--sm', onclick: () => cancel(r) }, 'Cancel'),
              ),
            ),
          ),
        ),
      );
    }

    /* ----------------------------- connections ----------------------------- */
    if (!data.connections.length) {
      container.appendChild(
        stateBlock({
          iconName: 'users',
          title: 'No connections yet',
          body: 'Connect after a match, accept a request, or reach a mutual Secret Signal. Once you are connected you can message and challenge each other.',
          actions: [
            h('button', { class: 'btn btn--primary', onclick: () => ctx.navigate('/play') }, 'Play a game'),
            h('button', { class: 'btn btn--ghost', onclick: () => ctx.navigate('/discover') }, 'Find people'),
          ],
        }),
      );
    } else {
      container.appendChild(
        h(
          'div',
          {},
          sectionHead(`Connections (${data.connections.length})`),
          h(
            'div',
            { class: 'stack stack--sm' },
            ...data.connections.map((c) => connectionRow(c, ctx, load)),
          ),
        ),
      );
    }

    mount(root, container);
  }

  async function accept(r) {
    try {
      await api.post(`/api/connections/requests/${r.id}/accept`, {});
      toast(`You are now connected with ${r.user.displayName || r.user.username}.`, 'success');
      await load(true);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function decline(r) {
    if (!(await confirmDialog({ title: 'Decline request?', message: 'They will not be told that you declined.', confirmLabel: 'Decline' }))) return;
    try {
      await api.post(`/api/connections/requests/${r.id}/decline`, {});
      toast('Request declined.', 'info');
      await load(true);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function cancel(r) {
    try {
      await api.post(`/api/connections/requests/${r.id}/cancel`, {});
      toast('Request cancelled.', 'info');
      await load(true);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  await load();
}

function connectionRow(c, ctx, reload) {
  const u = c.user;
  return h(
    'div',
    { class: 'card stack stack--sm' },
    h(
      'div',
      { class: 'row' },
      avatarEl(u, 'md'),
      h(
        'div',
        { class: 'grow', style: { minWidth: '0' } },
        h('div', { class: 'row', style: { gap: '7px' } },
          h('span', { class: 'strong truncate' }, u.displayName || u.username),
          u.presence === 'online' ? pill('Online', 'green') : null,
        ),
        h('div', { class: 'small dim truncate' }, u.bio || `Connected ${timeAgo(c.connectedAt)}`),
      ),
    ),
    h('div', { class: 'progress progress--thin' }, h('div', { class: 'progress__bar', style: { width: `${Math.min(100, (c.chemistry / 140) * 100)}%` } })),
    h('div', { class: 'row row--between' }, h('span', { class: 'tiny dim' }, `Chemistry ${c.chemistry}`), h('span', { class: 'tiny dim' }, c.kind === 'mutual_signal' ? 'From a mutual signal' : c.kind === 'match' ? 'From a match' : 'Connected')),
    h(
      'div',
      { class: 'btn-row' },
      h('button', { class: 'btn btn--primary btn--sm grow', onclick: () => openChat(u) }, icon('chat', 15), 'Message'),
      h('button', { class: 'btn btn--ghost btn--sm', onclick: () => ctx.navigate(`/profile/${u.userId}`) }, 'Profile'),
      h('button', { class: 'btn btn--ghost btn--sm', onclick: () => manage(u, reload) }, 'Manage'),
    ),
  );

  async function openChat(user) {
    try {
      const res = await api.post('/api/inbox/open', { userId: user.userId });
      ctx.navigate(`/inbox/${res.conversationId}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function manage(user, reloadFn) {
    showModal({
      title: user.displayName || user.username,
      body: h('div', { class: 'stack stack--sm' },
        h('p', { class: 'small muted' }, 'Removing a connection stops new messages. Blocking also hides you from each other everywhere.'),
      ),
      actions: [
        {
          label: 'Remove connection',
          variant: 'ghost',
          onClick: async () => {
            if (!(await confirmDialog({ title: 'Remove this connection?', message: 'You can connect again later if they accept.', confirmLabel: 'Remove', danger: true }))) return false;
            try {
              await api.del(`/api/connections/${user.userId}`);
              toast('Connection removed.', 'info');
              await reloadFn(true);
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
        {
          label: 'Block',
          variant: 'danger',
          onClick: async () => {
            if (!(await confirmDialog({ title: `Block ${user.displayName || user.username}?`, message: 'They will not be able to contact you or be matched with you.', confirmLabel: 'Block', danger: true }))) return false;
            try {
              await api.post('/api/safety/blocks', { userId: user.userId });
              toast('Blocked.', 'success');
              await reloadFn(true);
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
      ],
    });
  }
}
