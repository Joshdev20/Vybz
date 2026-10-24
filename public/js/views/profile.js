import { h, mount, clear, icon, avatarEl, timeAgo, plural } from '../dom.js';
import { api, readImageAsDataUrl } from '../api.js';
import { store, setState, toast, showModal, closeModal, confirmDialog } from '../state.js';
import { disconnect } from '../realtime.js';
import { pageHead, pill, stateBlock, errorBlock, loadingBlock, statTile, levelBar, chemMeter, banner, sectionHead, skeletons } from '../components.js';

export async function render(root, ctx) {
  const key = ctx.params?.usernameOrId || null;
  if (key) return renderOther(root, ctx, key);
  return renderOwn(root, ctx);
}

/* ------------------------------ own profile ------------------------------ */

async function renderOwn(root, ctx) {
  mount(root, loadingBlock('Loading your profile…'));
  let data;
  const load = async (silent = false) => {
    if (!silent) mount(root, loadingBlock('Loading…'));
    try {
      const [me, interests] = await Promise.all([api.get('/api/profile/me'), api.get('/api/profile/interests')]);
      data = { me, interests };
      if (ctx.isCurrent()) paint();
    } catch (err) {
      if (ctx.isCurrent()) mount(root, errorBlock(err.message, () => load()));
    }
  };

  function paint() {
    const { me, interests } = data;
    const p = me.profile || {};
    const s = me.statistics || {};
    const prefs = me.preferences || {};
    const container = h('div', { class: 'stack stack--lg' });

    container.appendChild(
      pageHead({
        eyebrow: `Level ${me.progress?.level || 1} · ${me.progress?.rankTitle || 'Newcomer'}`,
        title: p.display_name || me.user.username,
        subtitle: `@${me.user.username}${me.user.role !== 'user' ? ` · ${me.user.role}` : ''}`,
        actions: [h('button', { class: 'btn btn--ghost btn--sm', onclick: () => openEdit() }, icon('settings', 16), 'Edit profile')],
      }),
    );

    // Identity card
    container.appendChild(
      h(
        'div',
        { class: 'card stack' },
        h(
          'div',
          { class: 'row' },
          avatarEl({ ...p, presence: 'online' }, 'xl'),
          h(
            'div',
            { class: 'grow stack stack--sm' },
            h('div', { class: 'row row--wrap', style: { gap: '6px' } },
              pill(`Level ${me.progress?.level || 1}`, 'violet'),
              pill(me.progress?.rankTitle || 'Newcomer'),
              prefs.show_online_status ? pill('Online visible', 'green') : pill('Presence hidden'),
            ),
            h('div', { class: 'small muted' }, p.bio || 'No bio yet. Tell people what you enjoy.'),
          ),
        ),
        levelBar(me.progress),
        me.user.email ? h('div', { class: 'tiny dim' }, `Signed in as ${me.user.email}`) : null,
      ),
    );

    // Stats
    container.appendChild(
      h(
        'div',
        {},
        sectionHead('Statistics'),
        h(
          'div',
          { class: 'stat-grid' },
          statTile(s.xp || 0, 'XP'),
          statTile(s.games_played || 0, 'Games'),
          statTile(s.games_won || 0, 'Wins'),
          statTile(s.rounds_won || 0, 'Rounds won'),
          statTile(s.connections_count || 0, 'Connections'),
          statTile(s.current_streak || 0, 'Day streak'),
        ),
      ),
    );

    // Ranks per game
    if (me.ranks?.length) {
      container.appendChild(
        h(
          'div',
          {},
          sectionHead('Game ranks'),
          h(
            'div',
            { class: 'stack stack--sm' },
            ...me.ranks.map((r) =>
              h(
                'div',
                { class: 'list-item list-item--static' },
                h('div', { class: 'game-tile__icon' }, icon(modeIcon(r.game_key), 18)),
                h('div', { class: 'grow', style: { textAlign: 'left' } },
                  h('div', { class: 'strong small' }, r.gameName || r.game_key),
                  h('div', { class: 'tiny dim' }, `${r.wins || 0}W · ${r.losses || 0}L · ${r.draws || 0}D`),
                ),
                pill(`${r.rating || 1000}`, 'violet'),
              ),
            ),
          ),
        ),
      );
    }

    // Achievements
    container.appendChild(
      h(
        'div',
        {},
        sectionHead('Achievements'),
        h(
          'div',
          { class: 'achv-grid' },
          ...(me.achievements || []).map((a) =>
            h(
              'div',
              { class: `achv ${a.unlocked ? 'achv--unlocked' : ''}`, title: a.description },
              h('div', { class: 'achv__icon' }, ACHV_ICON[a.icon] || '🏆'),
              h('div', { class: 'achv__name' }, a.name),
              h('div', { class: 'achv__desc' }, a.unlocked ? 'Unlocked' : a.description),
            ),
          ),
        ),
      ),
    );

    // Challenges
    if (me.challenges?.length) {
      container.appendChild(
        h(
          'div',
          {},
          sectionHead('Challenges'),
          h(
            'div',
            { class: 'stack stack--sm' },
            ...me.challenges.map((c) =>
              h(
                'div',
                { class: 'card stack stack--sm' },
                h('div', { class: 'row row--between' }, h('span', { class: 'strong small' }, c.title), c.completed ? pill('Done', 'green') : pill(`+${c.xpReward} XP`, 'violet')),
                h('div', { class: 'progress progress--thin' }, h('div', { class: 'progress__bar', style: { width: `${Math.min(100, (c.progress / c.target) * 100)}%` } })),
                h('div', { class: 'tiny dim' }, `${c.progress} / ${c.target}`),
              ),
            ),
          ),
        ),
      );
    }

    // Interests
    const selected = new Set(interests.selected || []);
    container.appendChild(
      h(
        'div',
        {},
        sectionHead('Interests', [h('button', { class: 'btn btn--ghost btn--sm', onclick: () => openInterests(interests, selected) }, 'Edit')]),
        selected.size
          ? h('div', { class: 'row row--wrap', style: { gap: '7px' } }, ...interests.interests.filter((i) => selected.has(i.id)).map((i) => pill(i.label, 'violet')))
          : h('p', { class: 'small dim' }, 'No interests selected yet. Adding some improves your matches.'),
      ),
    );

    // Match history
    container.appendChild(
      h(
        'div',
        {},
        sectionHead('Recent matches'),
        me.history?.length
          ? h(
              'div',
              { class: 'stack stack--sm' },
              ...me.history.slice(0, 10).map((m) =>
                h(
                  'button',
                  { class: 'list-item', type: 'button', onclick: () => m.publicId && ctx.navigate(`/match/${m.publicId}`) },
                  h('div', { class: 'game-tile__icon' }, icon(modeIcon(m.gameKey), 18)),
                  h('div', { class: 'grow', style: { textAlign: 'left' } },
                    h('div', { class: 'strong small' }, m.gameName || m.gameKey),
                    h('div', { class: 'tiny dim' }, `${timeAgo(m.at)} · vs ${m.opponent || 'unknown'}`),
                  ),
                  m.status === 'completed' ? pill(m.resultLabel || m.result || 'Played', m.result === 'win' ? 'green' : m.result === 'loss' ? 'red' : '') : pill(m.status, 'amber'),
                ),
              ),
            )
          : h('p', { class: 'small dim' }, 'No matches yet. Head to Play to get started.'),
      ),
    );

    // Privacy & preferences
    container.appendChild(privacyCard(prefs, load));

    // Safety
    container.appendChild(safetyCard(ctx));

    // Account
    container.appendChild(accountCard(ctx, me));

    mount(root, container);
  }

  /* ------------------------------- edit profile ------------------------------- */
  function openEdit() {
    const p = data.me.profile || {};
    const nameInput = h('input', { class: 'input', maxlength: '40', value: p.display_name || '', 'aria-label': 'Display name' });
    const bioInput = h('textarea', { class: 'textarea', maxlength: '280', 'aria-label': 'Bio' });
    bioInput.value = p.bio || '';
    const regionInput = h('input', { class: 'input', maxlength: '40', value: p.region || '', placeholder: 'e.g. Manchester (optional)', 'aria-label': 'Region' });
    const showRegion = h('input', { type: 'checkbox', checked: Boolean(p.show_region), 'aria-label': 'Show region' });
    const avatarHost = h('div', { class: 'row row--wrap', style: { gap: '8px' } });
    const status = h('div', {});

    let avatarKind = p.avatar_kind;
    let avatarValue = p.avatar_value;

    const presets = (data.interests.avatarPresets || []).slice(0, 8);
    for (const preset of presets) {
      const btn = h('button', { class: 'avatar-choice', type: 'button', 'aria-pressed': String(avatarValue === preset.key), title: preset.label }, h('img', { src: preset.dataUri, alt: '' }));
      btn.onclick = () => {
        avatarKind = 'preset';
        avatarValue = preset.key;
        avatarHost.querySelectorAll('.avatar-choice').forEach((el) => el.setAttribute('aria-pressed', 'false'));
        btn.setAttribute('aria-pressed', 'true');
      };
      avatarHost.appendChild(btn);
    }
    const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'sr-only', id: 'edit-avatar' });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const dataUrl = await readImageAsDataUrl(file);
        const res = await api.post('/api/media/avatar', { dataUrl });
        avatarKind = 'upload';
        avatarValue = res.mediaId;
        avatarHost.querySelectorAll('.avatar-choice').forEach((el) => el.setAttribute('aria-pressed', 'false'));
        mount(status, banner('New photo uploaded.', 'success'));
      } catch (err) {
        mount(status, banner(err.message, 'error'));
      }
    });

    showModal({
      title: 'Edit profile',
      body: h(
        'div',
        { class: 'stack' },
        h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Display name'), nameInput),
        h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Bio'), bioInput, h('div', { class: 'field__hint' }, 'Keep it about you. No contact details, please.')),
        h('div', { class: 'eyebrow' }, 'Avatar'),
        avatarHost,
        h('div', {}, fileInput, h('label', { class: 'btn btn--ghost btn--sm', for: 'edit-avatar', style: { cursor: 'pointer' } }, icon('plus', 15), 'Upload a photo')),
        h('div', { class: 'field', style: { marginTop: '10px' } }, h('label', { class: 'field__label' }, 'Region (optional)'), regionInput),
        h('div', { class: 'switch' }, h('div', { class: 'switch__text' }, h('div', { class: 'switch__title' }, 'Show my region'), h('div', { class: 'switch__desc' }, 'Your exact location is never shown. This only displays the region you type.')), showRegion),
        status,
      ),
      actions: [
        {
          label: 'Save',
          variant: 'primary',
          onClick: async () => {
            try {
              await api.patch('/api/profile/me', {
                displayName: nameInput.value.trim(),
                bio: bioInput.value.trim(),
                avatarKind,
                avatarValue,
                region: regionInput.value.trim(),
                showRegion: showRegion.checked,
              });
              toast('Profile updated.', 'success');
              await load(true);
            } catch (err) {
              mount(status, banner(err.message, 'error'));
              return false;
            }
          },
        },
      ],
    });
  }

  /* ------------------------------- interests ------------------------------- */
  function openInterests(interests, selected) {
    const local = new Set(selected);
    const byCat = {};
    for (const i of interests.interests) (byCat[i.category] ||= []).push(i);
    showModal({
      title: 'Edit interests',
      body: h(
        'div',
        { class: 'stack' },
        ...Object.entries(byCat).map(([cat, items]) =>
          h(
            'div',
            { class: 'stack stack--sm' },
            h('div', { class: 'eyebrow' }, cat),
            h(
              'div',
              { class: 'row row--wrap', style: { gap: '7px' } },
              ...items.map((i) => {
                const btn = h('button', { class: 'pill pill--selectable', type: 'button', 'aria-pressed': String(local.has(i.id)) }, i.label);
                btn.onclick = () => {
                  if (local.has(i.id)) local.delete(i.id);
                  else if (local.size >= 12) return toast('You can pick up to 12 interests.', 'error');
                  else local.add(i.id);
                  btn.setAttribute('aria-pressed', String(local.has(i.id)));
                };
                return btn;
              }),
            ),
          ),
        ),
      ),
      actions: [
        {
          label: 'Save interests',
          variant: 'primary',
          onClick: async () => {
            try {
              await api.put('/api/profile/interests', { interestIds: [...local] });
              toast('Interests updated.', 'success');
              await load(true);
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
      ],
    });
  }

  /* ------------------------------- privacy ------------------------------- */
  function privacyCard(prefs, reload) {
    const toggles = [
      ['discoverable', 'Appear in Discover', 'Let other players find you by shared interests.', prefs.discoverable !== 0],
      ['show_online_status', 'Show when I am online', 'Off hides your activity from everyone.', prefs.show_online_status !== 0],
      ['allow_anonymous_signals', 'Accept Secret Signals', 'Anonymous compliments from other players.', prefs.allow_anonymous_signals !== 0],
      ['allow_anonymous_custom', 'Accept written compliments', 'Allow free-text compliments (always screened).', prefs.allow_anonymous_custom !== 0],
      ['allow_messages_from_connections', 'Allow messages from connections', 'Only connections can message you either way.', prefs.allow_messages_from_connections !== 0],
      ['allow_ai_judge', 'Allow automated judging', 'Use the rubric judge in Rizz Battle rounds.', prefs.allow_ai_judge !== 0],
      ['hide_private_notifications', 'Hide private notification text', 'Hide anonymous content on notifications.', prefs.hide_private_notifications !== 0],
      ['reduced_motion', 'Reduce motion', 'Minimise animation across the app.', prefs.reduced_motion !== 0],
    ];
    const local = { ...prefs };
    return h(
      'div',
      { class: 'card stack' },
      h('div', { class: 'eyebrow' }, 'Privacy and preferences'),
      ...toggles.map(([key, title, desc, initial]) => {
        local[key] = initial ? 1 : 0;
        const input = h('input', { type: 'checkbox', checked: initial, 'aria-label': title });
        input.addEventListener('change', async () => {
          local[key] = input.checked ? 1 : 0;
          try {
            await api.patch('/api/profile/preferences', { [key]: input.checked ? 1 : 0 });
            if (key === 'reduced_motion') document.body.dataset.reducedMotion = input.checked ? '1' : '';
            if (key === 'show_online_status') setState({ preferences: { ...store.preferences, [key]: input.checked ? 1 : 0 } });
            toast('Preference saved.', 'success', 1600);
            await reload(true);
          } catch (err) {
            input.checked = !input.checked;
            toast(err.message, 'error');
          }
        });
        return h('div', { class: 'switch' }, h('div', { class: 'switch__text' }, h('div', { class: 'switch__title' }, title), h('div', { class: 'switch__desc' }, desc)), input);
      }),
      h('p', { class: 'tiny dim' }, 'Your exact location and contact details are never shown to other players.'),
    );
  }

  /* ------------------------------- safety ------------------------------- */
  function safetyCard(ctx) {
    return h(
      'div',
      { class: 'card stack' },
      h('div', { class: 'eyebrow' }, 'Safety'),
      h('button', { class: 'btn btn--ghost btn--block', onclick: openBlocked }, icon('block', 16), 'Blocked accounts'),
      h('button', { class: 'btn btn--ghost btn--block', onclick: openMyReports }, icon('flag', 16), 'My reports'),
      h('button', { class: 'btn btn--ghost btn--block', onclick: openReportFlow }, icon('shield', 16), 'Report a player'),
      h('p', { class: 'tiny dim' }, 'If someone is in immediate danger, contact your local emergency services. VYBZ moderators review every report.'),
    );
  }

  async function openBlocked() {
    try {
      const data2 = await api.get('/api/safety/blocks');
      showModal({
        title: 'Blocked accounts',
        body: data2.blocked.length
          ? h(
              'div',
              { class: 'stack stack--sm' },
              ...data2.blocked.map((b) =>
                h(
                  'div',
                  { class: 'list-item list-item--static' },
                  avatarEl(b, 'sm'),
                  h('div', { class: 'grow', style: { textAlign: 'left' } }, h('div', { class: 'strong small' }, b.displayName || b.username), h('div', { class: 'tiny dim' }, b.blockedByMe ? 'Blocked by you' : 'Blocked you')),
                  b.blockedByMe
                    ? h('button', { class: 'btn btn--ghost btn--sm', onclick: async (e) => { try { await api.del(`/api/safety/blocks/${b.userId}`); toast('Unblocked.', 'success'); closeModal(); await load(true); } catch (err) { toast(err.message, 'error'); } } }, 'Unblock')
                    : pill('Blocked', 'red'),
                ),
              ),
            )
          : h('p', { class: 'small dim' }, 'You have not blocked anyone.'),
        actions: [{ label: 'Close', variant: 'ghost' }],
      });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function openMyReports() {
    try {
      const data2 = await api.get('/api/safety/reports/mine');
      showModal({
        title: 'My reports',
        body: data2.reports.length
          ? h('div', { class: 'stack stack--sm' }, ...data2.reports.map((r) =>
              h('div', { class: 'list-item list-item--static' },
                h('div', { class: 'grow', style: { textAlign: 'left' } },
                  h('div', { class: 'strong small' }, `${r.targetType} · ${r.reason.replace(/_/g, ' ')}`),
                  h('div', { class: 'tiny dim' }, `${timeAgo(r.createdAt)}`),
                ),
                pill(reportStatus(r.status), r.status === 'actioned' ? 'green' : r.status === 'dismissed' ? '' : 'amber'),
              ),
            ))
          : h('p', { class: 'small dim' }, 'You have not submitted any reports.'),
        actions: [{ label: 'Close', variant: 'ghost' }],
      });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function openReportFlow() {
    let reason = 'harassment';
    const usernameInput = h('input', { class: 'input', placeholder: 'username', 'aria-label': 'Username to report' });
    const details = h('textarea', { class: 'textarea', maxlength: '500', placeholder: 'What happened?', 'aria-label': 'Details' });
    const status = h('div', {});
    const reasons = [
      ['harassment', 'Harassment or abuse'],
      ['spam', 'Spam or advertising'],
      ['sexual_content', 'Unwanted sexual content'],
      ['threats', 'Threats or stalking'],
      ['impersonation', 'Impersonation'],
      ['underage', 'Suspected underage account'],
      ['other', 'Something else'],
    ];
    showModal({
      title: 'Report a player',
      body: h(
        'div',
        { class: 'stack stack--sm' },
        h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Username'), usernameInput),
        ...reasons.map(([key, label]) => {
          const input = h('input', { type: 'radio', name: 'reason', value: key, checked: key === reason, style: { accentColor: 'var(--violet)' } });
          input.addEventListener('change', () => { reason = key; });
          return h('label', { class: 'row', style: { gap: '10px', cursor: 'pointer', padding: '4px 0' } }, input, h('span', { class: 'small' }, label));
        }),
        details,
        status,
      ),
      actions: [
        {
          label: 'Submit',
          variant: 'danger',
          onClick: async () => {
            const username = usernameInput.value.trim().replace(/^@/, '');
            if (!username) {
              mount(status, banner('Enter the username to report.', 'error'));
              return false;
            }
            try {
              await api.post('/api/safety/reports', { username, targetType: 'user', reason, details: details.value.trim() });
              toast('Report submitted. Thank you.', 'success');
            } catch (err) {
              mount(status, banner(err.message, 'error'));
              return false;
            }
          },
        },
      ],
    });
  }

  /* ------------------------------- account ------------------------------- */
  function accountCard(ctx, me) {
    return h(
      'div',
      { class: 'card stack' },
      h('div', { class: 'eyebrow' }, 'Account'),
      h('button', { class: 'btn btn--ghost btn--block', onclick: openSessions }, icon('lock', 16), 'Sessions and devices'),
      h('button', { class: 'btn btn--ghost btn--block', onclick: () => changePassword() }, icon('lock', 16), 'Change password'),
      h('button', { class: 'btn btn--ghost btn--block', onclick: logout }, icon('logout', 16), 'Log out'),
      h('button', { class: 'btn btn--danger btn--block', onclick: () => deleteAccount(me) }, 'Delete my account'),
      h('p', { class: 'tiny dim' }, 'Deleting your account removes your profile, matches and connections. Some moderation records are retained where required for safety and legal reasons.'),
    );
  }

  async function openSessions() {
    try {
      const data2 = await api.get('/api/auth/sessions');
      showModal({
        title: 'Sessions and devices',
        body: h(
          'div',
          { class: 'stack stack--sm' },
          ...data2.sessions.map((s) =>
            h(
              'div',
              { class: 'list-item list-item--static' },
              h('div', { class: 'game-tile__icon' }, icon('lock', 16)),
              h('div', { class: 'grow', style: { textAlign: 'left' } },
                h('div', { class: 'small strong truncate' }, s.current ? 'This device' : (s.userAgent || 'Unknown device')),
                h('div', { class: 'tiny dim' }, `Last used ${timeAgo(s.lastUsedAt)}`),
              ),
              s.current ? pill('Current', 'green') : h('button', { class: 'btn btn--danger btn--sm', onclick: async () => { try { await api.del(`/api/auth/sessions/${s.id}`); toast('Session revoked.', 'success'); openSessions(); } catch (err) { toast(err.message, 'error'); } } }, 'Revoke'),
            ),
          ),
        ),
        actions: [
          {
            label: 'Log out everywhere else',
            variant: 'danger',
            onClick: async () => {
              try {
                await api.post('/api/auth/logout-all', {});
                toast('All other sessions revoked.', 'success');
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
        ],
      });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function changePassword() {
    const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Current password' });
    const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'aria-label': 'New password' });
    const status = h('div', {});
    showModal({
      title: 'Change password',
      body: h('div', { class: 'stack' },
        h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Current password'), current),
        h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'New password'), next, h('div', { class: 'field__hint' }, 'At least 8 characters.')),
        status,
      ),
      actions: [
        {
          label: 'Update password',
          variant: 'primary',
          onClick: async () => {
            if (next.value.length < 8) {
              mount(status, banner('New password must be at least 8 characters.', 'error'));
              return false;
            }
            try {
              await api.post('/api/auth/password', { currentPassword: current.value, newPassword: next.value });
              toast('Password updated. Other sessions were signed out.', 'success');
            } catch (err) {
              mount(status, banner(err.message, 'error'));
              return false;
            }
          },
        },
      ],
    });
  }

  async function logout() {
    if (!(await confirmDialog({ title: 'Log out?', message: 'You will need to sign in again to keep playing.', confirmLabel: 'Log out' }))) return;
    try {
      await api.post('/api/auth/logout', {});
    } catch {
      /* best-effort */
    }
    disconnect();
    setState({ user: null, profile: null });
    location.href = '/';
  }

  async function deleteAccount(me) {
    const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Password' });
    const confirmInput = h('input', { class: 'input', placeholder: 'DELETE', 'aria-label': 'Type DELETE to confirm' });
    const status = h('div', {});
    showModal({
      title: 'Delete your account',
      body: h(
        'div',
        { class: 'stack' },
        banner('This cannot be undone. Your profile, matches, connections and messages will be removed.', 'warn'),
        h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Confirm your password'), pw),
        h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Type DELETE to confirm'), confirmInput),
        status,
      ),
      actions: [
        {
          label: 'Delete permanently',
          variant: 'danger',
          onClick: async () => {
            try {
              await api.del('/api/auth/account', { password: pw.value, confirm: confirmInput.value.trim() });
              toast('Your account has been deleted.', 'info');
              disconnect();
              setState({ user: null });
              location.href = '/';
            } catch (err) {
              mount(status, banner(err.message, 'error'));
              return false;
            }
          },
        },
      ],
    });
  }

  await load();
}

/* ----------------------------- other profile ----------------------------- */

async function renderOther(root, ctx, key) {
  mount(root, loadingBlock('Loading profile…'));
  const isNumeric = /^\d+$/.test(String(key));
  const url = isNumeric ? `/api/profile/id/${key}` : `/api/profile/user/${encodeURIComponent(key)}`;
  let data;
  try {
    data = await api.get(url);
  } catch (err) {
    mount(
      root,
      err.status === 403
        ? stateBlock({ iconName: 'lock', title: 'Profile not available', body: 'This player is not discoverable, or you have blocked each other.' })
        : errorBlock(err.message, () => ctx.navigate('/discover')),
    );
    return;
  }
  if (!ctx.isCurrent()) return;
  const p = data.user;
  const targetUserId = p.userId;
  const container = h('div', { class: 'stack stack--lg' });
  container.appendChild(
    pageHead({
      eyebrow: 'Profile',
      title: p.displayName || p.username,
      subtitle: `@${p.username}`,
      actions: [h('button', { class: 'btn btn--ghost btn--sm', onclick: () => history.back() }, icon('back', 16), 'Back')],
    }),
  );
  container.appendChild(
    h(
      'div',
      { class: 'card stack' },
      h('div', { class: 'row' }, avatarEl({ ...p, presence: p.presence }, 'xl'), h('div', { class: 'grow stack stack--sm' },
        h('div', { class: 'row row--wrap', style: { gap: '6px' } },
          p.level ? pill(`Level ${p.level}`, 'violet') : null,
          p.presence === 'online' ? pill('Online', 'green') : null,
          p.region ? pill(p.region) : null,
        ),
        h('div', { class: 'small muted' }, p.bio || 'No bio yet.'),
      )),
      h('div', { class: 'stat-grid' },
        statTile(p.xp || 0, 'XP'),
        statTile(p.gamesPlayed || 0, 'Games'),
        statTile(p.gamesWon || 0, 'Wins'),
      ),
    ),
  );
  if (data.interests?.length) {
    container.appendChild(
      h('div', {}, sectionHead('Interests'), h('div', { class: 'row row--wrap', style: { gap: '7px' } }, ...data.interests.map((i) => pill(i.label, 'violet')))),
    );
  }
  if (data.relationship?.connected) {
    container.appendChild(chemMeter(p.chemistry || 0, 'Your chemistry'));
  }
  container.appendChild(
    h(
      'div',
      { class: 'btn-row' },
      data.relationship?.connected
        ? h('button', { class: 'btn btn--primary grow', onclick: () => openChat(targetUserId, ctx) }, icon('chat', 16), 'Message')
        : data.relationship?.pendingOutgoing
          ? h('button', { class: 'btn btn--ghost grow', disabled: true }, 'Request pending')
          : data.relationship?.pendingIncoming
            ? h('button', { class: 'btn btn--primary grow', onclick: () => acceptRequest(data.relationship.pendingIncoming) }, 'Accept request')
            : h('button', { class: 'btn btn--primary grow', onclick: () => requestConnection(targetUserId) }, icon('spark', 16), 'Connect'),
      h('button', { class: 'btn btn--ghost', onclick: () => safety(targetUserId, ctx) }, 'Safety'),
    ),
  );
  mount(root, container);

  async function acceptRequest(requestId) {
    try {
      await api.post(`/api/connections/requests/${requestId}/accept`, {});
      toast('Connected.', 'success');
      ctx.navigate(`/profile/${key}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function openChat(id, ctx2) {
    try {
      const res = await api.post('/api/inbox/open', { userId: id });
      ctx2.navigate(`/inbox/${res.conversationId}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function requestConnection(id) {
    try {
      await api.post('/api/connections/requests', { userId: id });
      toast('Connection request sent.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function safety(id, ctx2) {
    showModal({
      title: 'Safety options',
      body: h('div', { class: 'stack stack--sm' }, h('p', { class: 'small muted' }, 'Blocking stops all contact. Reporting sends the account for moderator review.')),
      actions: [
        { label: 'Block', variant: 'danger', onClick: async () => {
            try {
              await api.post('/api/safety/blocks', { userId: id });
              toast('Blocked.', 'success');
              ctx2.navigate('/discover');
            } catch (err) {
              toast(err.message, 'error');
            }
          } },
        { label: 'Report', variant: 'ghost', onClick: async () => {
            try {
              await api.post('/api/safety/reports', { subjectUserId: id, targetType: 'user', reason: 'harassment' });
              toast('Report submitted.', 'success');
            } catch (err) {
              toast(err.message, 'error');
            }
          } },
      ],
    });
  }
}

function reportStatus(status) {
  return { open: 'Open', reviewing: 'Reviewing', actioned: 'Actioned', dismissed: 'Dismissed', escalated: 'Escalated' }[status] || status;
}

const ACHV_ICON = {
  trophy: '🏆',
  spark: '✨',
  mic: '🎤',
  heart: '💜',
  mask: '🎭',
  dice: '🎲',
  chat: '💬',
  users: '🤝',
  bolt: '⚡',
  shield: '🛡️',
  clock: '⏱️',
  star: '⭐',
};

function modeIcon(key) {
  return { rizz_battle: 'mic', word_chemistry: 'spark', spill_it: 'dice', blind_vibe: 'heart', secret_signal: 'mask' }[key] || 'play';
}
