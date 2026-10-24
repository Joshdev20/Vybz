import { h, mount, clear, icon, avatarEl, plural } from '../dom.js';
import { api } from '../api.js';
import { store, toast, showModal, confirmDialog } from '../state.js';
import { pageHead, pill, stateBlock, errorBlock, loadingBlock, playerRow, banner, sectionHead } from '../components.js';

export async function render(root, ctx) {
  mount(root, loadingBlock('Finding people who share your interests…'));

  let data;
  const load = async (silent = false) => {
    if (!silent) mount(root, loadingBlock('Finding people…'));
    try {
      data = await api.get('/api/profile/discover');
      if (ctx.isCurrent()) paint();
    } catch (err) {
      if (ctx.isCurrent()) mount(root, errorBlock(err.message, () => load()));
    }
  };

  const state = { query: '', interest: null, sort: 'shared' };

  function paint() {
    const container = h('div', { class: 'stack stack--lg' });
    container.appendChild(
      pageHead({
        eyebrow: 'Discover',
        title: 'Find your people',
        subtitle: 'Matched on shared interests, availability and how you actually play. Not a follower feed.',
      }),
    );

    // Filters
    const searchInput = h('input', { class: 'input', type: 'search', placeholder: 'Search by username…', value: state.query, 'aria-label': 'Search players' });
    let debounce = null;
    searchInput.addEventListener('input', () => {
      state.query = searchInput.value.trim();
      clearTimeout(debounce);
      debounce = setTimeout(() => paintResults(), 260);
    });

    container.appendChild(
      h(
        'div',
        { class: 'card stack stack--sm' },
        h('div', { class: 'row' }, icon('search', 18), h('span', { class: 'strong small' }, 'Filter')),
        searchInput,
        h(
          'div',
          { class: 'row row--wrap', style: { gap: '7px' } },
          h('button', { class: 'pill pill--selectable', type: 'button', 'aria-pressed': String(state.interest === null), onclick: (e) => { state.interest = null; paint(); } }, 'All interests'),
          ...(data.interests || []).slice(0, 14).map((i) => {
            const btn = h('button', { class: 'pill pill--selectable', type: 'button', 'aria-pressed': String(state.interest === i.id) }, `${i.label}${i.shared ? ' ✓' : ''}`);
            btn.onclick = () => {
              state.interest = state.interest === i.id ? null : i.id;
              paint();
            };
            return btn;
          }),
        ),
        h(
          'div',
          { class: 'row row--wrap', style: { gap: '7px' } },
          ...['shared', 'active', 'level'].map((s) =>
            h('button', { class: 'pill pill--selectable', type: 'button', 'aria-pressed': String(state.sort === s), onclick: () => { state.sort = s; paint(); } },
              { shared: 'Most in common', active: 'Online first', level: 'Highest level' }[s]),
          ),
        ),
      ),
    );

    const resultsHost = h('div', {});
    container.appendChild(resultsHost);
    mount(root, container);
    paintResults(resultsHost);
  }

  function paintResults(host = root.querySelector('.stack > div:last-child')) {
    if (!host) return;
    const people = (data.players || []).filter((p) => {
      if (state.query && !`${p.username} ${p.displayName || ''}`.toLowerCase().includes(state.query.toLowerCase())) return false;
      if (state.interest && !(p.sharedInterestIds || []).includes(state.interest) && !(p.interestIds || []).includes(state.interest)) return false;
      return true;
    });

    if (!people.length) {
      mount(
        host,
        stateBlock({
          iconName: 'compass',
          title: 'No players match that filter',
          body: data.players?.length
            ? 'Try clearing the filters to see everyone who is discoverable right now.'
            : 'Nobody else is discoverable right now. Add more interests to widen your matches, or come back later.',
          actions: [
            h('button', { class: 'btn btn--ghost', onclick: () => { state.query = ''; state.interest = null; paint(); } }, 'Clear filters'),
            h('button', { class: 'btn btn--primary', onclick: () => ctx.navigate('/play') }, 'Play a game instead'),
          ],
        }),
      );
      return;
    }

    const sorted = [...people].sort((a, b) => {
      if (state.sort === 'active') return (b.presence === 'online' ? 1 : 0) - (a.presence === 'online' ? 1 : 0);
      if (state.sort === 'level') return (b.level || 0) - (a.level || 0);
      return (b.sharedInterestCount || 0) - (a.sharedInterestCount || 0);
    });

    mount(
      host,
      h('div', { class: 'stack stack--sm' }, ...sorted.map((p) => discoverRow(p, ctx, load))),
    );
  }

  await load();
}

function discoverRow(p, ctx, reload) {
  const shared = p.sharedInterests || [];
  return h(
    'div',
    { class: 'list-item list-item--static' },
    avatarEl({ ...p, presence: p.presence }, 'md'),
    h(
      'div',
      { class: 'grow', style: { textAlign: 'left' } },
      h('div', { class: 'row', style: { gap: '7px' } },
        h('span', { class: 'strong truncate' }, p.displayName || p.username),
        p.level ? pill(`Lv ${p.level}`, 'violet') : null,
        p.presence === 'online' ? pill('Online', 'green') : null,
      ),
      h('div', { class: 'small dim truncate' }, p.bio || 'No bio yet.'),
      shared.length
        ? h('div', { class: 'row row--wrap', style: { gap: '5px', marginTop: '5px' } },
            ...shared.slice(0, 4).map((s) => pill(s.label, 'pink')),
            shared.length > 4 ? h('span', { class: 'tiny dim' }, `+${shared.length - 4}`) : null,
          )
        : h('div', { class: 'tiny dim', style: { marginTop: '4px' } }, 'No shared interests yet'),
    ),
    h(
      'div',
      { class: 'stack stack--sm' },
      h('button', { class: 'btn btn--primary btn--sm', onclick: () => invite(p) }, icon('spark', 15), 'Connect'),
      h('button', { class: 'btn btn--ghost btn--sm', onclick: () => reportOrBlock(p) }, 'Safety'),
    ),
  );

  function invite(person) {
    showModal({
      title: `Connect with ${person.displayName || person.username}`,
      body: h(
        'div',
        { class: 'stack' },
        h('p', { class: 'small muted' }, 'Send a connection request. Once they accept, you can message each other and challenge each other to games.'),
        shared.length ? h('div', { class: 'banner banner--info' }, h('div', { class: 'grow' }, `You both like ${shared.map((s) => s.label).join(', ')}.`)) : null,
        h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'note' }, 'Add a note (optional)'), h('textarea', { class: 'textarea', id: 'note', maxlength: '200', placeholder: 'Say hello and mention a game you would play…' })),
      ),
      actions: [
        {
          label: 'Send request',
          variant: 'primary',
          onClick: async () => {
            const note = document.getElementById('note')?.value?.trim() || '';
            try {
              const res = await api.post('/api/connections/requests', { userId: person.userId, message: note });
              toast(res.pending ? 'Request sent. You will be notified when they respond.' : 'Connected!', 'success');
              await reload(true);
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
      ],
    });
  }

  function reportOrBlock(person) {
    showModal({
      title: 'Safety options',
      body: h('div', { class: 'stack stack--sm' },
        h('p', { class: 'small muted' }, 'Blocking stops all contact in both directions. Reporting sends the account to our moderation team.'),
      ),
      actions: [
        { label: 'Block', variant: 'danger', onClick: async () => {
            try {
              await api.post('/api/safety/blocks', { userId: person.userId });
              toast('Blocked. They can no longer contact you.', 'success');
              await reload(true);
            } catch (err) {
              toast(err.message, 'error');
            }
          } },
        { label: 'Report', variant: 'ghost', onClick: () => reportFlow(person) },
      ],
    });
  }

  function reportFlow(person) {
    const reasons = [
      ['harassment', 'Harassment or abuse'],
      ['spam', 'Spam or advertising'],
      ['impersonation', 'Impersonation'],
      ['underage', 'Suspected underage account'],
      ['inappropriate_content', 'Inappropriate content'],
      ['other', 'Something else'],
    ];
    let reason = 'harassment';
    const body = h('div', { class: 'stack stack--sm' },
      h('p', { class: 'small muted' }, 'Reports are confidential. The other player is not told who reported them.'),
      ...reasons.map(([key, label]) => {
        const input = h('input', { type: 'radio', name: 'reason', value: key, checked: key === reason, style: { accentColor: 'var(--violet)' } });
        input.addEventListener('change', () => { reason = key; });
        return h('label', { class: 'row', style: { gap: '10px', cursor: 'pointer', padding: '4px 0' } }, input, h('span', { class: 'small' }, label));
      }),
      h('div', { class: 'field', style: { marginTop: '6px' } }, h('label', { class: 'field__label', for: 'details' }, 'Details (optional)'), h('textarea', { class: 'textarea', id: 'details', maxlength: '500', placeholder: 'What happened?' })),
    );
    showModal({
      title: `Report ${person.displayName || person.username}`,
      body,
      actions: [
        {
          label: 'Submit report',
          variant: 'danger',
          onClick: async () => {
            const details = document.getElementById('details')?.value?.trim() || '';
            try {
              await api.post('/api/safety/reports', { subjectUserId: person.userId, targetType: 'user', reason, details });
              toast('Report submitted. Thank you.', 'success');
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
      ],
    });
  }
}
