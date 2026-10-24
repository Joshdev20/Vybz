import { h, mount, clear, icon, avatarEl, timeAgo, plural } from '../dom.js';
import { api } from '../api.js';
import { store, toast, showModal, closeModal, confirmDialog } from '../state.js';
import { pageHead, pill, stateBlock, errorBlock, loadingBlock, banner, sectionHead, statTile } from '../components.js';

export async function render(root, ctx) {
  if (store.user?.role !== 'admin' && store.user?.role !== 'moderator') {
    mount(
      root,
      stateBlock({
        iconName: 'lock',
        title: 'Administration',
        body: 'You do not have access to this area. Moderator or administrator permissions are required, and they are verified on the server for every request.',
        actions: [h('button', { class: 'btn btn--primary', onclick: () => ctx.navigate('/play') }, 'Back to Play')],
      }),
    );
    return;
  }

  const isAdmin = store.user.role === 'admin';
  const state = { tab: 'overview' };
  const container = h('div', { class: 'stack stack--lg' });
  const tabHost = h('div', { class: 'tabs', role: 'tablist' });
  const panelHost = h('div', {});

  const TABS = [
    ['overview', 'Overview'],
    ['reports', 'Reports'],
    ['users', 'Users'],
    ['games', 'Games'],
    ['analytics', 'Analytics'],
    ['audit', 'Audit log'],
  ];

  function paintTabs() {
    clear(tabHost);
    for (const [key, label] of TABS) {
      tabHost.appendChild(
        h('button', { class: `tab ${state.tab === key ? 'tab--active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(state.tab === key), onclick: () => { state.tab = key; paintTabs(); loadTab(); } }, label),
      );
    }
  }

  container.appendChild(
    pageHead({
      eyebrow: `Signed in as ${store.user.role}`,
      title: 'Administration',
      subtitle: 'Server-verified access. Every moderation action and content view is recorded in the audit log.',
    }),
  );
  container.appendChild(tabHost);
  container.appendChild(panelHost);
  mount(root, container);
  paintTabs();
  loadTab();

  async function loadTab() {
    mount(panelHost, loadingBlock('Loading…'));
    try {
      if (state.tab === 'overview') await overview();
      else if (state.tab === 'reports') await reports();
      else if (state.tab === 'users') await users();
      else if (state.tab === 'games') await games();
      else if (state.tab === 'analytics') await analytics();
      else if (state.tab === 'audit') await auditLog();
    } catch (err) {
      if (err.status === 403) {
        mount(panelHost, stateBlock({ iconName: 'lock', title: 'Access denied', body: 'Your account does not have permission for this section.' }));
      } else {
        mount(panelHost, errorBlock(err.message, loadTab));
      }
    }
  }

  /* ------------------------------- overview ------------------------------- */
  async function overview() {
    const data = await api.get('/api/admin/overview');
    const c = data.counts;
    mount(
      panelHost,
      h(
        'div',
        { class: 'stack stack--lg' },
        h('div', { class: 'stat-grid' },
          statTile(c.users, 'Active users'),
          statTile(c.openReports, 'Open reports', c.criticalReports > 0 ? 'red' : undefined),
          statTile(c.criticalReports, 'Critical'),
          statTile(c.activeMatches, 'Live matches'),
          statTile(c.matchesToday, 'Matches 24h'),
          statTile(c.roomsActive, 'Active rooms'),
          statTile(c.signalsToday, 'Signals 24h'),
          statTile(c.messagesToday, 'Messages 24h'),
          statTile(c.queueWaiting, 'In queue'),
          statTile(c.suspended, 'Suspended'),
          statTile(c.banned, 'Banned'),
        ),
        c.criticalReports > 0
          ? h('div', { class: 'card stack stack--sm' }, h('div', { class: 'eyebrow' }, 'Attention needed'), h('p', { class: 'small' }, `${plural(c.criticalReports, 'critical report', 'critical reports')} awaiting review.`), h('button', { class: 'btn btn--danger btn--sm', onclick: () => { state.tab = 'reports'; paintTabs(); loadTab(); } }, 'Review now'))
          : h('div', { class: 'banner banner--info' }, icon('shield', 18), h('div', { class: 'grow' }, 'No critical reports waiting.')),
      ),
    );
  }

  /* -------------------------------- reports -------------------------------- */
  async function reports() {
    const filter = { status: 'open' };
    const data = await api.get(`/api/admin/reports?status=${filter.status}`);
    const host = h('div', { class: 'stack' });
    const listHost = h('div', { class: 'stack stack--sm' });
    const paintList = async () => {
      mount(listHost, loadingBlock('Loading reports…'));
      try {
        const d = await api.get(`/api/admin/reports${filter.status ? `?status=${filter.status}` : ''}`);
        if (!d.reports.length) {
          mount(listHost, stateBlock({ iconName: 'shield', title: 'Nothing here', body: 'No reports with this status.' }));
          return;
        }
        mount(
          listHost,
          ...d.reports.map((r) =>
            h(
              'div',
              { class: `card stack stack--sm ${r.severity === 'critical' ? 'card--danger' : ''}` },
              h('div', { class: 'row row--between row--wrap' },
                h('div', { class: 'row' }, severityPill(r.severity), pill(r.reason.replace(/_/g, ' ')), pill(r.status, r.status === 'open' ? 'amber' : r.status === 'actioned' ? 'green' : '')),
                h('span', { class: 'tiny dim' }, timeAgo(r.created_at)),
              ),
              h('div', { class: 'small' },
                h('span', { class: 'dim' }, 'Subject: '), h('span', { class: 'strong' }, r.subject_username || 'unknown'),
                r.reporter_username ? h('span', { class: 'dim' }, ` · Reported by ${r.reporter_username}`) : null,
                h('span', { class: 'dim' }, ` · ${r.target_type}`),
              ),
              r.details ? h('p', { class: 'small muted', style: { margin: '0' } }, r.details) : null,
              h('div', { class: 'btn-row' },
                h('button', { class: 'btn btn--ghost btn--sm', onclick: () => viewContent(r) }, 'View content'),
                h('button', { class: 'btn btn--primary btn--sm', onclick: () => resolveReport(r, 'actioned') }, 'Take action'),
                h('button', { class: 'btn btn--ghost btn--sm', onclick: () => resolveReport(r, 'reviewing') }, 'Mark reviewing'),
                h('button', { class: 'btn btn--ghost btn--sm', onclick: () => resolveReport(r, 'dismissed') }, 'Dismiss'),
              ),
            ),
          ),
        );
      } catch (err) {
        mount(listHost, errorBlock(err.message, paintList));
      }
    };

    host.appendChild(
      h('div', { class: 'row row--wrap', style: { gap: '7px' } },
        ...['open', 'reviewing', 'actioned', 'dismissed', 'escalated', ''].map((s) => {
          const btn = h('button', { class: 'pill pill--selectable', type: 'button', 'aria-pressed': String(filter.status === s) }, s || 'All');
          btn.onclick = () => {
            filter.status = s;
            host.querySelectorAll('.pill--selectable').forEach((el) => el.setAttribute('aria-pressed', 'false'));
            btn.setAttribute('aria-pressed', 'true');
            paintList();
          };
          return btn;
        }),
      ),
    );
    host.appendChild(listHost);
    mount(panelHost, host);
    paintList();

    async function viewContent(r) {
      try {
        const d = await api.get(`/api/admin/reports/${r.id}/content`);
        showModal({
          title: 'Reported content',
          body: h('div', { class: 'stack stack--sm' },
            h('div', { class: 'banner banner--warn' }, icon('lock', 16), h('div', { class: 'grow' }, 'This content view has been recorded in the audit log.')),
            d.content
              ? h('div', { class: 'answer-card' }, h('div', { class: 'answer-card__body' }, d.content.body || d.content.prompt_text || '(no text)'), h('div', { class: 'tiny dim', style: { padding: '0 14px 10px' } }, `${timeAgo(d.content.created_at)} · ${d.content.prompt_text ? 'game answer' : 'message'}`))
              : h('p', { class: 'small dim' }, 'No content is attached to this report.'),
          ),
          actions: [{ label: 'Close', variant: 'ghost' }],
        });
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    function resolveReport(r, status) {
      const actionOptions = [['none', 'No action'], ['warn', 'Warn'], ['mute', 'Mute (24h)'], ['suspend', 'Suspend (7 days)'], ['ban', 'Permanently ban']];
      let action = 'none';
      const resolution = h('textarea', { class: 'textarea', maxlength: '400', placeholder: 'Internal note for the audit log…' });
      const status2 = h('div', {});
      showModal({
        title: `Resolve report #${r.id}`,
        body: h('div', { class: 'stack stack--sm' },
          h('p', { class: 'small muted' }, `Subject: ${r.subject_username || 'unknown'} · ${r.reason.replace(/_/g, ' ')}`),
          h('div', { class: 'eyebrow' }, 'Moderation action'),
          ...actionOptions.filter(([k]) => isAdmin || k !== 'ban').map(([key, label]) => {
            const input = h('input', { type: 'radio', name: 'action', value: key, checked: key === action, style: { accentColor: 'var(--violet)' } });
            input.addEventListener('change', () => { action = key; });
            return h('label', { class: 'row', style: { gap: '10px', cursor: 'pointer', padding: '4px 0' } }, input, h('span', { class: 'small' }, label));
          }),
          h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Note'), resolution),
          status2,
        ),
        actions: [
          {
            label: 'Apply',
            variant: status === 'dismissed' ? 'ghost' : 'danger',
            onClick: async () => {
              try {
                await api.post(`/api/admin/reports/${r.id}/resolve`, {
                  status,
                  resolution: resolution.value.trim(),
                  action,
                  expiresInDays: action === 'mute' ? 1 : action === 'suspend' ? 7 : null,
                });
                toast('Report updated.', 'success');
                paintList();
              } catch (err) {
                mount(status2, banner(err.message, 'error'));
                return false;
              }
            },
          },
        ],
      });
    }
  }

  /* --------------------------------- users --------------------------------- */
  async function users() {
    const filter = { q: '', status: '' };
    const host = h('div', { class: 'stack' });
    const listHost = h('div', { class: 'stack stack--sm' });

    const search = h('input', { class: 'input', type: 'search', placeholder: 'Search username or email…', 'aria-label': 'Search users' });
    let debounce = null;
    search.addEventListener('input', () => {
      filter.q = search.value.trim();
      clearTimeout(debounce);
      debounce = setTimeout(paintList, 280);
    });

    const statusRow = h('div', { class: 'row row--wrap', style: { gap: '7px' } });
    for (const s of ['', 'active', 'suspended', 'banned', 'deactivated']) {
      const btn = h('button', { class: 'pill pill--selectable', type: 'button', 'aria-pressed': String(filter.status === s) }, s || 'All');
      btn.onclick = () => {
        filter.status = s;
        statusRow.querySelectorAll('.pill--selectable').forEach((el) => el.setAttribute('aria-pressed', 'false'));
        btn.setAttribute('aria-pressed', 'true');
        paintList();
      };
      statusRow.appendChild(btn);
    }

    host.appendChild(h('div', { class: 'card stack stack--sm' }, search, statusRow));
    host.appendChild(listHost);
    mount(panelHost, host);
    paintList();

    async function paintList() {
      mount(listHost, loadingBlock('Loading users…'));
      try {
        const params = new URLSearchParams();
        if (filter.q) params.set('q', filter.q);
        if (filter.status) params.set('status', filter.status);
        const d = await api.get(`/api/admin/users?${params}`);
        if (!d.users.length) {
          mount(listHost, stateBlock({ iconName: 'users', title: 'No users found', body: 'Try a different search or status filter.' }));
          return;
        }
        mount(
          listHost,
          ...d.users.map((u) =>
            h(
              'div',
              { class: 'list-item list-item--static' },
              h('div', { class: 'game-tile__icon' }, icon(u.role === 'admin' ? 'shield' : 'users', 18)),
              h(
                'div',
                { class: 'grow', style: { textAlign: 'left', minWidth: '0' } },
                h('div', { class: 'row', style: { gap: '6px' } },
                  h('span', { class: 'strong small truncate' }, u.username),
                  u.role !== 'user' ? pill(u.role, 'violet') : null,
                  u.status !== 'active' ? pill(u.status, 'red') : null,
                  !u.age_eligible ? pill('Age unverified', 'amber') : null,
                ),
                h('div', { class: 'tiny dim truncate' }, `${u.email || 'no email'} · joined ${timeAgo(u.created_at)}`),
                u.report_count > 0 ? h('div', { class: 'tiny', style: { color: 'var(--danger)' } }, `${u.report_count} report(s) · ${u.action_count} action(s)`) : null,
              ),
              h('button', { class: 'btn btn--ghost btn--sm', onclick: () => openUser(u) }, 'Manage'),
            ),
          ),
        );
      } catch (err) {
        mount(listHost, errorBlock(err.message, paintList));
      }
    }

    async function openUser(u) {
      let d;
      try {
        d = await api.get(`/api/admin/users/${u.id}`);
      } catch (err) {
        toast(err.message, 'error');
        return;
      }
      showModal({
        title: `@${d.user.username}`,
        body: h(
          'div',
          { class: 'stack stack--sm' },
          h('div', { class: 'row row--wrap', style: { gap: '6px' } },
            pill(d.user.role, 'violet'),
            pill(d.user.status, d.user.status === 'active' ? 'green' : 'red'),
            d.user.age_eligible ? pill('18+ confirmed', 'green') : pill('Age unverified', 'amber'),
          ),
          h('div', { class: 'small dim' }, `${d.user.email || 'no email'} · joined ${timeAgo(d.user.created_at)}`),
          d.statistics ? h('div', { class: 'stat-grid' }, statTile(d.statistics.xp || 0, 'XP'), statTile(d.statistics.games_played || 0, 'Games'), statTile(d.statistics.games_won || 0, 'Wins')) : null,
          d.reports.length ? h('div', {}, h('div', { class: 'eyebrow' }, `Reports (${d.reports.length})`), ...d.reports.slice(0, 5).map((r) => h('div', { class: 'tiny dim' }, `${timeAgo(r.created_at)} · ${r.reason.replace(/_/g, ' ')} · ${r.status}`))) : null,
          d.moderationActions.length ? h('div', {}, h('div', { class: 'eyebrow' }, `Actions (${d.moderationActions.length})`), ...d.moderationActions.slice(0, 5).map((a) => h('div', { class: 'tiny dim' }, `${timeAgo(a.created_at)} · ${a.action} by ${a.actor || 'system'}`))) : null,
          h('div', { class: 'eyebrow' }, 'Moderation'),
          ...['warn', 'mute', 'suspend', ...(isAdmin ? ['ban'] : [])].map((action) => {
            const btn = h('button', { class: `btn btn--sm btn--block ${action === 'ban' ? 'btn--danger' : 'btn--ghost'}` }, actionLabel(action));
            btn.onclick = () => applyAction(d.user.id, action);
            return btn;
          }),
          isAdmin
            ? (() => {
                let role = d.user.role;
                const roleRow = h('div', { class: 'row row--wrap', style: { gap: '7px', marginTop: '6px' } });
                for (const r of ['user', 'moderator', 'admin']) {
                  const b = h('button', { class: 'pill pill--selectable', type: 'button', 'aria-pressed': String(role === r), disabled: d.user.id === store.user.id }, r);
                  b.onclick = async () => {
                    if (!(await confirmDialog({ title: `Change role to ${r}?`, message: 'This takes effect immediately and is recorded in the audit log.', confirmLabel: 'Change role' }))) return;
                    try {
                      await api.post(`/api/admin/users/${d.user.id}/role`, { role: r });
                      role = r;
                      toast('Role updated.', 'success');
                      roleRow.querySelectorAll('.pill--selectable').forEach((el) => el.setAttribute('aria-pressed', 'false'));
                      b.setAttribute('aria-pressed', 'true');
                    } catch (err) {
                      toast(err.message, 'error');
                    }
                  };
                  roleRow.appendChild(b);
                }
                return h('div', {}, h('div', { class: 'eyebrow', style: { marginTop: '8px' } }, 'Role'), roleRow);
              })()
            : null,
        ),
        actions: [{ label: 'Close', variant: 'ghost' }],
      });
    }

    function applyAction(userId, action) {
      closeModal();
      const reason = h('textarea', { class: 'textarea', maxlength: '300', placeholder: 'Reason shown in the audit log…' });
      const status = h('div', {});
      showModal({
        title: actionLabel(action),
        body: h('div', { class: 'stack stack--sm' },
          h('p', { class: 'small muted' }, action === 'warn'
            ? 'The user receives a formal warning. This is recorded.'
            : action === 'mute' ? 'The user cannot send signals or messages for 24 hours.' : action === 'suspend' ? 'The account is suspended for 7 days.' : 'The account is permanently banned. Only administrators can do this.'),
          h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Reason'), reason),
          status,
        ),
        actions: [
          {
            label: 'Confirm',
            variant: action === 'ban' ? 'danger' : 'primary',
            onClick: async () => {
              try {
                await api.post(`/api/admin/users/${userId}/action`, { action, reason: reason.value.trim(), expiresInDays: action === 'mute' ? 1 : action === 'suspend' ? 7 : null });
                toast('Action applied and logged.', 'success');
                paintList();
              } catch (err) {
                mount(status, banner(err.message, 'error'));
                return false;
              }
            },
          },
        ],
      });
    }
  }

  /* --------------------------------- games --------------------------------- */
  async function games() {
    const [prompts, categories, modes] = await Promise.all([
      api.get('/api/admin/prompts'),
      api.get('/api/admin/categories'),
      api.get('/api/admin/game-modes'),
    ]);
    mount(
      panelHost,
      h(
        'div',
        { class: 'stack stack--lg' },
        h('div', {}, sectionHead('Game modes'),
          h('div', { class: 'stack stack--sm' },
            ...modes.modes.map((m) =>
              h('div', { class: 'list-item list-item--static' },
                h('div', { class: 'game-tile__icon' }, icon('play', 18)),
                h('div', { class: 'grow', style: { textAlign: 'left' } },
                  h('div', { class: 'strong small' }, m.name),
                  h('div', { class: 'tiny dim' }, `${m.min_players}-${m.max_players} players · ${m.enabled ? 'enabled' : 'disabled'}`),
                ),
                h('button', { class: 'btn btn--ghost btn--sm', onclick: () => toggleMode(m) }, m.enabled ? 'Disable' : 'Enable'),
              ),
            ),
          ),
        ),
        h('div', {}, sectionHead('Prompt categories'),
          h('div', { class: 'row row--wrap', style: { gap: '7px' } },
            ...categories.categories.map((c) => pill(`${c.label} (${c.enabled ? 'on' : 'off'})`, c.enabled ? 'violet' : '')),
          ),
        ),
        h('div', {}, sectionHead(`Prompts (${prompts.prompts.length})`, [h('button', { class: 'btn btn--primary btn--sm', onclick: addPrompt }, icon('plus', 15), 'Add prompt')]),
          h('div', { class: 'stack stack--sm' },
            ...prompts.prompts.slice(0, 40).map((p) =>
              h('div', { class: 'list-item list-item--static' },
                h('div', { class: 'grow', style: { textAlign: 'left', minWidth: '0' } },
                  h('div', { class: 'small truncate' }, p.text),
                  h('div', { class: 'tiny dim' }, `${p.game_key} · ${p.category_label || 'no category'} · used ${p.usage_count}× · ${p.enabled ? 'enabled' : 'disabled'}`),
                ),
                h('button', { class: 'btn btn--ghost btn--sm', onclick: () => togglePrompt(p) }, p.enabled ? 'Disable' : 'Enable'),
              ),
            ),
          ),
        ),
      ),
    );

    async function toggleMode(m) {
      try {
        await api.patch(`/api/admin/game-modes/${m.key}`, { enabled: m.enabled ? 0 : 1 });
        toast('Game mode updated.', 'success');
        loadTab();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function togglePrompt(p) {
      try {
        await api.patch(`/api/admin/prompts/${p.id}`, { enabled: p.enabled ? 0 : 1 });
        toast('Prompt updated.', 'success');
        loadTab();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    function addPrompt() {
      const text = h('textarea', { class: 'textarea', maxlength: '300', placeholder: 'Prompt text…' });
      let game = 'rizz_battle';
      let category = categories.categories[0]?.key || '';
      const gameRow = h('div', { class: 'row row--wrap', style: { gap: '7px' } });
      for (const g of ['rizz_battle', 'word_chemistry', 'spill_it', 'blind_vibe']) {
        const b = h('button', { class: 'pill pill--selectable', type: 'button', 'aria-pressed': String(game === g) }, g.replace(/_/g, ' '));
        b.onclick = () => { game = g; gameRow.querySelectorAll('.pill--selectable').forEach((el) => el.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); };
        gameRow.appendChild(b);
      }
      const catRow = h('div', { class: 'row row--wrap', style: { gap: '7px' } });
      for (const c of categories.categories) {
        const b = h('button', { class: 'pill pill--selectable', type: 'button', 'aria-pressed': String(category === c.key) }, c.label);
        b.onclick = () => { category = c.key; catRow.querySelectorAll('.pill--selectable').forEach((el) => el.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); };
        catRow.appendChild(b);
      }
      const status = h('div', {});
      showModal({
        title: 'Add prompt',
        body: h('div', { class: 'stack stack--sm' },
          h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Prompt'), text),
          h('div', { class: 'eyebrow' }, 'Game'), gameRow,
          h('div', { class: 'eyebrow' }, 'Category'), catRow,
          status,
        ),
        actions: [
          {
            label: 'Create',
            variant: 'primary',
            onClick: async () => {
              if (text.value.trim().length < 6) {
                mount(status, banner('Prompt is too short.', 'error'));
                return false;
              }
              try {
                await api.post('/api/admin/prompts', { gameKey: game, categoryKey: category, text: text.value.trim() });
                toast('Prompt created.', 'success');
                loadTab();
              } catch (err) {
                mount(status, banner(err.message, 'error'));
                return false;
              }
            },
          },
        ],
      });
    }
  }

  /* ------------------------------- analytics ------------------------------- */
  async function analytics() {
    const data = await api.get('/api/admin/analytics?days=14');
    const maxMatches = Math.max(1, ...data.matchesByDay.map((d) => d.matches));
    mount(
      panelHost,
      h(
        'div',
        { class: 'stack stack--lg' },
        h('div', { class: 'card stack stack--sm' },
          h('div', { class: 'eyebrow' }, 'Matchmaking health (14 days)'),
          h('div', { class: 'stat-grid' },
            statTile(data.queueMetrics.reduce((a, m) => a + (m.matched || 0), 0), 'Matched'),
            statTile(data.queueMetrics.reduce((a, m) => a + (m.expired || 0), 0), 'Expired'),
            statTile(`${Math.round((data.rematchRate.rate || 0) * 100)}%`, 'Rematch rate'),
          ),
          h('div', { class: 'stack stack--sm' },
            ...data.queueMetrics.map((m) => h('div', { class: 'row row--between' }, h('span', { class: 'small' }, m.game_key.replace(/_/g, ' ')), h('span', { class: 'tiny dim' }, `${m.queued} queued · ${m.matched} matched · ${m.expired} expired`))),
          ),
        ),
        h('div', { class: 'card stack stack--sm' },
          h('div', { class: 'eyebrow' }, 'Matches per day'),
          h('div', { class: 'chart' },
            ...data.matchesByDay.map((d) => h('div', { class: 'chart__bar-wrap', title: `${d.day}: ${d.matches} matches` }, h('div', { class: 'chart__bar', style: { height: `${(d.matches / maxMatches) * 100}%` } }))),
          ),
          h('div', { class: 'row row--between' }, h('span', { class: 'tiny dim' }, data.matchesByDay[0]?.day || ''), h('span', { class: 'tiny dim' }, data.matchesByDay.at(-1)?.day || '')),
        ),
        h('div', { class: 'card stack stack--sm' },
          h('div', { class: 'eyebrow' }, 'Game mode popularity'),
          ...data.modePopularity.map((m) => h('div', { class: 'row row--between' }, h('span', { class: 'small' }, m.game_key.replace(/_/g, ' ')), h('span', { class: 'small strong' }, String(m.matches)))),
        ),
        h('div', { class: 'card stack stack--sm' },
          h('div', { class: 'eyebrow' }, 'Top prompts'),
          ...data.promptEngagement.slice(0, 8).map((p) => h('div', { class: 'row row--between', style: { gap: '10px' } }, h('span', { class: 'small truncate' }, p.text), h('span', { class: 'tiny dim' }, `${p.usage_count}×`))),
        ),
        h('div', { class: 'card stack stack--sm' },
          h('div', { class: 'eyebrow' }, 'Reports'),
          ...data.reportMetrics.slice(-7).map((r) => h('div', { class: 'row row--between' }, h('span', { class: 'small' }, r.day), h('span', { class: 'tiny dim' }, `${r.reports} reports · ${r.serious} serious`))),
        ),
        h('p', { class: 'tiny dim' }, 'Analytics are aggregated. Private message content is never collected for analytics.'),
      ),
    );
  }

  /* -------------------------------- audit -------------------------------- */
  async function auditLog() {
    const data = await api.get('/api/admin/audit-log?limit=100');
    mount(
      panelHost,
      h('div', { class: 'stack stack--sm' },
        h('p', { class: 'small muted' }, 'Sensitive administrative actions are recorded here. This list is access-controlled.'),
        ...data.entries.map((e) =>
          h('div', { class: 'list-item list-item--static' },
            h('div', { class: 'game-tile__icon' }, icon('shield', 16)),
            h('div', { class: 'grow', style: { textAlign: 'left', minWidth: '0' } },
              h('div', { class: 'small strong' }, e.action.replace(/_/g, ' ')),
              h('div', { class: 'tiny dim truncate' }, `${e.actor_username || 'system'} · ${e.target_type || ''}${e.target_id ? ` #${e.target_id}` : ''} · ${timeAgo(e.created_at)}`),
            ),
          ),
        ),
      ),
    );
  }
}

function severityPill(sev) {
  return pill(sev, sev === 'critical' ? 'red' : sev === 'high' ? 'amber' : '');
}

function actionLabel(action) {
  return { warn: 'Send warning', mute: 'Mute 24 hours', suspend: 'Suspend 7 days', ban: 'Permanently ban', none: 'No action' }[action] || action;
}
