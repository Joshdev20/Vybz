import { h, mount, clear, icon, avatarEl } from '../dom.js';
import { api, readImageAsDataUrl } from '../api.js';
import { store, setState, toast } from '../state.js';
import { brand } from '../components.js';

const STEPS = ['avatar', 'interests', 'games', 'privacy'];

export async function render(app) {
  const container = h('main', { class: 'shell__main', id: 'main', style: { minHeight: '100vh' } });
  const wrap = h('div', { class: 'wrap', style: { maxWidth: '560px' } });
  container.appendChild(wrap);
  mount(app, container);

  const [interestData, modeData] = await Promise.all([
    api.get('/api/profile/interests').catch(() => ({ interests: [], selected: [], avatarPresets: [] })),
    api.get('/api/play/modes').catch(() => ({ modes: [] })),
  ]);

  let step = 0;
  const selectedInterests = new Set(interestData.selected || []);
  const selectedGames = new Set((store.preferences?.preferred_games || []).map((g) => (typeof g === 'string' ? g : g.key)));
  let profile = { ...(store.profile || {}) };
  const prefs = { ...(store.preferences || {}) };

  const presetSrc = (key) => (interestData.avatarPresets || []).find((x) => x.key === key)?.dataUri || '/assets/mystery.svg';

  function dots() {
    return h(
      'div',
      { class: 'row', style: { justifyContent: 'center', gap: '7px' } },
      ...STEPS.map((_, i) =>
        h('span', {
          class: 'round-dot',
          style: i < step ? 'background:var(--violet);border-color:var(--violet)' : i === step ? 'background:var(--pink);border-color:var(--pink)' : '',
        }),
      ),
    );
  }

  function navRow({ nextLabel = 'Continue', onNext, back = true }) {
    return h(
      'div',
      { class: 'btn-row', style: { marginTop: '8px' } },
      back
        ? h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => { step -= 1; paint(); } }, 'Back')
        : null,
      h('button', { class: 'btn btn--primary grow', type: 'button', onclick: onNext }, nextLabel),
    );
  }

  function paint() {
    clear(wrap);
    wrap.appendChild(
      h(
        'div',
        { class: 'stack stack--lg' },
        h('div', { class: 'center' }, brand()),
        dots(),
        step === 0 ? stepAvatar() : step === 1 ? stepInterests() : step === 2 ? stepGames() : stepPrivacy(),
      ),
    );
    window.scrollTo({ top: 0 });
  }

  async function finish() {
    await api.post('/api/profile/onboarding', { complete: true });
    const me = await api.get('/api/auth/me');
    setState({ user: me.user, profile: me.profile, preferences: me.preferences });
    toast('Welcome to VYBZ. Let\u2019s play.', 'success');
    history.replaceState({}, '', '/play');
    const { renderRoute } = await import('../app.js');
    await renderRoute();
  }

  /* ------------------------------ avatar ------------------------------ */
  function stepAvatar() {
    let chosen = String(profile.avatar_value || '').startsWith('preset') ? profile.avatar_value : 'preset-1';
    const preview = h('img', {
      class: 'avatar avatar--xl',
      src: presetSrc(chosen),
      alt: 'Your avatar',
      style: { margin: '0 auto' },
    });
    const grid = h('div', { class: 'avatar-grid' });
    for (const p of interestData.avatarPresets || []) {
      const btn = h(
        'button',
        { class: 'avatar-choice', type: 'button', 'aria-pressed': String(p.key === chosen), 'aria-label': p.label, title: p.label },
        h('img', { src: p.dataUri, alt: '' }),
      );
      btn.onclick = () => {
        chosen = p.key;
        profile = { ...profile, avatar_kind: 'preset', avatar_value: p.key };
        preview.src = p.dataUri;
        grid.querySelectorAll('.avatar-choice').forEach((el) => el.setAttribute('aria-pressed', 'false'));
        btn.setAttribute('aria-pressed', 'true');
      };
      grid.appendChild(btn);
    }
    const uploadInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'sr-only', id: 'avatar-file' });
    uploadInput.addEventListener('change', async () => {
      const file = uploadInput.files?.[0];
      if (!file) return;
      try {
        const dataUrl = await readImageAsDataUrl(file);
        const res = await api.post('/api/media/avatar', { dataUrl });
        profile = { ...profile, avatar_kind: 'upload', avatar_value: res.mediaId };
        preview.src = res.url;
        grid.querySelectorAll('.avatar-choice').forEach((el) => el.setAttribute('aria-pressed', 'false'));
        toast('Photo added.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    return h(
      'div',
      { class: 'card stack' },
      h('div', {}, h('h1', {}, 'Choose your look'), h('p', { class: 'small muted', style: { margin: '6px 0 0' } }, 'Pick an avatar or upload a photo. You can change this any time.')),
      h('div', { class: 'center' }, preview),
      grid,
      h('div', { class: 'center' }, uploadInput, h('label', { class: 'btn btn--ghost btn--sm', for: 'avatar-file', style: { cursor: 'pointer' } }, icon('plus', 16), 'Upload your own')),
      navRow({
        back: false,
        onNext: async () => {
          await api.patch('/api/profile/me', { avatarKind: profile.avatar_kind, avatarValue: profile.avatar_value });
          step = 1;
          paint();
        },
      }),
    );
  }

  /* ----------------------------- interests ----------------------------- */
  function stepInterests() {
    const byCat = {};
    for (const i of interestData.interests) (byCat[i.category] ||= []).push(i);
    return h(
      'div',
      { class: 'card stack' },
      h('div', {}, h('h1', {}, 'What are you into?'), h('p', { class: 'small muted', style: { margin: '6px 0 0' } }, 'Shared interests power discovery and chemistry. Pick up to 12.')),
      ...Object.entries(byCat).map(([cat, items]) =>
        h(
          'div',
          { class: 'stack stack--sm' },
          h('div', { class: 'eyebrow' }, cat),
          h(
            'div',
            { class: 'row row--wrap', style: { gap: '7px' } },
            ...items.map((i) => {
              const btn = h('button', { class: 'pill pill--selectable', type: 'button', 'aria-pressed': String(selectedInterests.has(i.id)) }, i.label);
              btn.onclick = () => {
                if (selectedInterests.has(i.id)) selectedInterests.delete(i.id);
                else if (selectedInterests.size >= 12) return toast('You can pick up to 12 interests.', 'error');
                else selectedInterests.add(i.id);
                btn.setAttribute('aria-pressed', String(selectedInterests.has(i.id)));
              };
              return btn;
            }),
          ),
        ),
      ),
      navRow({
        onNext: async () => {
          await api.put('/api/profile/interests', { interestIds: [...selectedInterests] });
          step = 2;
          paint();
        },
      }),
    );
  }

  /* ------------------------------- games ------------------------------- */
  function stepGames() {
    const iconFor = { rizz_battle: 'mic', word_chemistry: 'spark', spill_it: 'dice', blind_vibe: 'heart' };
    return h(
      'div',
      { class: 'card stack' },
      h('div', {}, h('h1', {}, 'Pick your games'), h('p', { class: 'small muted', style: { margin: '6px 0 0' } }, 'We will highlight these on your Play screen.')),
      h(
        'div',
        { class: 'stack stack--sm' },
        ...modeData.modes
          .filter((m) => iconFor[m.key])
          .map((m) => {
            const on = selectedGames.has(m.key);
            const btn = h(
              'button',
              { class: 'list-item', type: 'button', 'aria-pressed': String(on) },
              h('div', { class: 'game-tile__icon' }, icon(iconFor[m.key], 22)),
              h('div', { class: 'grow', style: { textAlign: 'left' } }, h('div', { class: 'strong' }, m.name), h('div', { class: 'small dim' }, m.tagline || '')),
              on ? h('span', { class: 'pill pill--violet' }, 'Selected') : null,
            );
            btn.onclick = () => {
              if (on) selectedGames.delete(m.key);
              else selectedGames.add(m.key);
              paint();
            };
            return btn;
          }),
      ),
      navRow({
        onNext: async () => {
          await api.patch('/api/profile/preferences', { preferred_games: [...selectedGames] });
          step = 3;
          paint();
        },
      }),
    );
  }

  /* ------------------------------ privacy ------------------------------ */
  function stepPrivacy() {
    const toggles = [
      ['discoverable', 'Appear in Discover', 'Let other players find you by shared interests.', prefs.discoverable !== 0],
      ['show_online_status', 'Show when I am online', 'Turn off to keep your activity private.', prefs.show_online_status !== 0],
      ['allow_anonymous_signals', 'Accept Secret Signals', 'Anonymous compliments from other players.', prefs.allow_anonymous_signals !== 0],
      ['allow_anonymous_custom', 'Accept written compliments', 'Allow free-text compliments (always moderated).', prefs.allow_anonymous_custom !== 0],
      ['allow_ai_judge', 'Allow automated judging', 'Use the rubric judge when you play Rizz Battle.', prefs.allow_ai_judge !== 0],
    ];
    const local = { ...prefs };
    const rows = toggles.map(([key, title, desc, initial]) => {
      local[key] = initial ? 1 : 0;
      const input = h('input', { type: 'checkbox', checked: initial, 'aria-label': title });
      input.addEventListener('change', () => {
        local[key] = input.checked ? 1 : 0;
      });
      return h(
        'div',
        { class: 'switch' },
        h('div', { class: 'switch__text' }, h('div', { class: 'switch__title' }, title), h('div', { class: 'switch__desc' }, desc)),
        input,
      );
    });

    return h(
      'div',
      { class: 'card stack' },
      h('div', {}, h('h1', {}, 'Your privacy'), h('p', { class: 'small muted', style: { margin: '6px 0 0' } }, 'You stay in control. Change these any time in Profile.')),
      h('div', { class: 'banner banner--info' }, icon('shield', 18), h('div', { class: 'grow' }, 'VYBZ never reveals your exact location, contact details, or who sent an anonymous signal unless you both choose to connect.')),
      ...rows,
      h('div', { class: 'banner banner--warn' }, h('div', { class: 'grow' }, 'You can block or report anyone at any time. Reports are reviewed by our moderation team.')),
      navRow({
        nextLabel: 'Enter VYBZ',
        onNext: async () => {
          await api.patch('/api/profile/preferences', local);
          await finish();
        },
      }),
    );
  }

  paint();
}
