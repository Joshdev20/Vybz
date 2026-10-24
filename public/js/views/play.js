import { h, mount, clear, icon, timeAgo, plural } from '../dom.js';
import { api } from '../api.js';
import { store, setState, toast, showModal, closeModal } from '../state.js';
import { on as onRealtime } from '../realtime.js';
import {
  pageHead,
  sectionHead,
  statTile,
  pill,
  stateBlock,
  errorBlock,
  loadingBlock,
  levelBar,
  skeletons,
  banner,
} from '../components.js';

const MODE_ICON = {
  rizz_battle: 'mic',
  word_chemistry: 'spark',
  secret_signal: 'mask',
  spill_it: 'dice',
  blind_vibe: 'heart',
};

export async function render(root, ctx) {
  mount(root, loadingBlock('Loading your arena…'));

  let dash;
  try {
    dash = await api.get('/api/play/dashboard');
  } catch (err) {
    mount(root, errorBlock(err.message, () => ctx.navigate('/play')));
    return;
  }
  if (!ctx.isCurrent()) return;
  setState({ statistics: dash.statistics, progress: dash.progress, counters: { ...store.counters, unreadMessages: dash.unreadMessages, unreadNotifications: dash.unreadNotifications, pendingSignals: dash.signalsPending } });

  const refresh = () => ctx.navigate('/play', { replace: true });

  const container = h('div', { class: 'stack stack--lg' });

  /* ------------------------------ header ------------------------------ */
  const stats = dash.statistics || {};
  container.appendChild(
    pageHead({
      eyebrow: `Level ${dash.progress?.level || 1} · ${dash.progress?.rankTitle || 'Newcomer'}`,
      title: `Hey, ${store.profile?.display_name || store.user.username}`,
      subtitle: 'Meet through play. Connect through chemistry.',
    }),
  );

  // Reconnection / active match banner takes priority.
  if (store.connection !== 'online') {
    container.appendChild(
      banner(
        store.connection === 'reconnecting'
          ? 'Reconnecting to VYBZ… live game updates will resume automatically.'
          : 'You are offline. Game updates are paused until the connection returns.',
        store.connection === 'offline' ? 'warn' : 'info',
      ),
    );
  }

  if (dash.activeMatch) {
    container.appendChild(
      h(
        'div',
        { class: 'card card--glow stack' },
        h('div', { class: 'eyebrow' }, 'Match in progress'),
        h('div', { class: 'row row--between row--wrap' }, h('h3', {}, 'You have an unfinished match'), pill(modeName(dash.modes, dash.activeMatch.gameKey), 'violet')),
        h('p', { class: 'small muted', style: { marginBottom: '0' } }, 'Rejoin to continue where you left off. Leaving a match early records it as abandoned.'),
        h('button', { class: 'btn btn--primary btn--block', onclick: () => ctx.navigate(`/match/${dash.activeMatch.publicId}`) }, icon('play', 18), 'Rejoin match'),
      ),
    );
  }

  if (dash.queue) {
    container.appendChild(
      h(
        'div',
        { class: 'card card--glow stack' },
        h('div', { class: 'eyebrow' }, 'Searching'),
        h('h3', {}, `Finding you a ${modeName(dash.modes, dash.queue.gameKey)} partner`),
        h('p', { class: 'small muted', style: { marginBottom: '0' } }, 'You will be notified the moment a compatible player joins. Nothing is simulated — you are in a real queue.'),
        h('div', { class: 'row' }, h('div', { class: 'spinner' }), h('span', { class: 'small dim' }, `Queued ${timeAgo(dash.queue.since)}`)),
        h('button', { class: 'btn btn--ghost btn--block', onclick: async () => { await api.del(`/api/play/queue?gameKey=${dash.queue.gameKey}`); toast('Search cancelled.', 'info'); refresh(); } }, 'Cancel search'),
      ),
    );
  }

  /* ---------------------------- progression ---------------------------- */
  container.appendChild(
    h(
      'div',
      { class: 'card stack' },
      levelBar(dash.progress),
      h(
        'div',
        { class: 'stat-grid' },
        statTile(stats.xp || 0, 'XP'),
        statTile(stats.games_played || 0, 'Games'),
        statTile(stats.games_won || 0, 'Wins'),
        statTile(stats.current_streak || 0, 'Day streak'),
      ),
    ),
  );

  /* ------------------------------- modes ------------------------------- */
  const preferred = new Set((store.preferences?.preferred_games || []).map((g) => (typeof g === 'string' ? g : g.key)));
  const modes = dash.modes.filter((m) => m.key !== 'secret_signal');
  container.appendChild(
    h(
      'div',
      {},
      sectionHead('Game modes'),
      h(
        'div',
        { class: 'grid-games stack' },
        ...modes.map((m) => gameTile(m, ctx, refresh, preferred.has(m.key))),
      ),
    ),
  );

  /* ------------------------------ signals ------------------------------ */
  container.appendChild(
    h(
      'div',
      {},
      sectionHead('Social'),
      h(
        'div',
        { class: 'stack stack--sm' },
        h(
          'button',
          { class: 'list-item', type: 'button', onclick: () => ctx.navigate('/signals') },
          h('div', { class: 'game-tile__icon' }, icon('mask', 22)),
          h('div', { class: 'grow', style: { textAlign: 'left' } },
            h('div', { class: 'strong' }, 'Secret Signals'),
            h('div', { class: 'small dim' }, dash.signalsPending > 0 ? plural(dash.signalsPending, 'signal waiting for you', 'signals waiting for you') : 'Anonymous compliments and interest, on your terms.'),
          ),
          dash.signalsPending > 0 ? pill(String(dash.signalsPending), 'pink') : icon('back', 16),
        ),
        h(
          'button',
          { class: 'list-item', type: 'button', onclick: () => ctx.navigate('/rooms') },
          h('div', { class: 'game-tile__icon' }, icon('dice', 22)),
          h('div', { class: 'grow', style: { textAlign: 'left' } },
            h('div', { class: 'strong' }, 'Spill It! rooms'),
            h('div', { class: 'small dim' }, 'Private party rooms with a join code, or join a public room.'),
          ),
          icon('back', 16),
        ),
        h(
          'button',
          { class: 'list-item', type: 'button', onclick: () => ctx.navigate('/blind-vibe') },
          h('div', { class: 'game-tile__icon' }, icon('heart', 22)),
          h('div', { class: 'grow', style: { textAlign: 'left' } },
            h('div', { class: 'strong' }, 'Blind Vibe'),
            h('div', { class: 'small dim' }, 'Talk first. Reveal only when you both choose to.'),
          ),
          icon('back', 16),
        ),
      ),
    ),
  );

  /* ---------------------------- challenges ---------------------------- */
  if (dash.challenges?.length) {
    container.appendChild(
      h(
        'div',
        {},
        sectionHead('Challenges'),
        h(
          'div',
          { class: 'stack stack--sm' },
          ...dash.challenges.map((c) =>
            h(
              'div',
              { class: 'card stack stack--sm' },
              h(
                'div',
                { class: 'row row--between' },
                h('span', { class: 'strong small' }, c.title),
                c.completed ? pill('Complete', 'green') : pill(`+${c.xpReward} XP`, 'violet'),
              ),
              h('div', { class: 'progress progress--thin' }, h('div', { class: 'progress__bar', style: { width: `${Math.min(100, (c.progress / c.target) * 100)}%` } })),
              h('div', { class: 'tiny dim' }, `${c.progress} / ${c.target} · ${c.scope}`),
            ),
          ),
        ),
      ),
    );
  }

  /* ------------------------------ recent ------------------------------ */
  if (dash.recentMatches?.length) {
    container.appendChild(
      h(
        'div',
        {},
        sectionHead('Recent matches'),
        h(
          'div',
          { class: 'stack stack--sm' },
          ...dash.recentMatches.map((m) =>
            h(
              'div',
              { class: 'list-item list-item--static' },
              h('div', { class: 'game-tile__icon' }, icon(MODE_ICON[m.gameKey] || 'play', 20)),
              h('div', { class: 'grow', style: { textAlign: 'left' } },
                h('div', { class: 'strong small' }, modeName(dash.modes, m.gameKey)),
                h('div', { class: 'tiny dim' }, timeAgo(m.at)),
              ),
              m.status === 'completed'
                ? pill(resultLabel(m.result), m.result === 'win' ? 'green' : m.result === 'loss' ? 'red' : '')
                : pill(statusLabel(m.status), 'amber'),
            ),
          ),
        ),
      ),
    );
  }

  mount(root, container);
}

function gameTile(mode, ctx, refresh, preferred) {
  const needsRoom = mode.key === 'spill_it';
  const solo = mode.key === 'secret_signal';
  const queueInfo = mode.queue;

  const tile = h(
    'div',
    { class: `card card--interactive game-tile ${preferred ? 'card--glow' : ''}` },
    h(
      'div',
      { class: 'row row--between' },
      h('div', { class: 'game-tile__icon' }, icon(MODE_ICON[mode.key] || 'play', 23)),
      preferred ? pill('Your pick', 'violet') : null,
    ),
    h('div', {}, h('h3', {}, mode.name), h('p', { class: 'small muted clamp-2', style: { margin: '5px 0 0' } }, mode.tagline || mode.description)),
    h(
      'div',
      { class: 'game-tile__meta' },
      pill(`${mode.promptCount} prompts`),
      mode.maxPlayers > 2 ? pill(`up to ${mode.maxPlayers} players`) : pill('1 v 1'),
      queueInfo && queueInfo.waiting > 0 ? pill(`${queueInfo.waiting} waiting`, 'green') : null,
      queueInfo && queueInfo.waiting === 0 ? pill('queue empty', 'amber') : null,
    ),
    h(
      'div',
      { class: 'btn-row', style: { marginTop: '2px' } },
      needsRoom
        ? h('button', { class: 'btn btn--primary btn--sm grow', type: 'button', onclick: (e) => { e.stopPropagation(); ctx.navigate('/rooms'); } }, 'Open rooms')
        : solo
          ? h('button', { class: 'btn btn--primary btn--sm grow', type: 'button', onclick: (e) => { e.stopPropagation(); ctx.navigate('/signals'); } }, 'Open')
          : h('button', { class: 'btn btn--primary btn--sm grow', type: 'button', onclick: (e) => { e.stopPropagation(); openQueueSheet(mode, ctx, refresh); } }, 'Play now'),
      mode.key === 'rizz_battle' || mode.key === 'word_chemistry'
        ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', title: 'Practice alone', onclick: (e) => { e.stopPropagation(); practice(mode, ctx); } }, 'Practice')
        : null,
    ),
  );

  tile.addEventListener('click', () => {
    if (needsRoom) ctx.navigate('/rooms');
    else if (solo) ctx.navigate('/signals');
    else openQueueSheet(mode, ctx, refresh);
  });
  return tile;
}

/* ---------------------------- matchmaking sheet ---------------------------- */

function openQueueSheet(mode, ctx, refresh) {
  const selectedCategories = new Set();
  const body = h('div', { class: 'stack' });

  body.appendChild(
    h('div', { class: 'row' }, h('div', { class: 'game-tile__icon' }, icon(MODE_ICON[mode.key] || 'play', 22)), h('div', {}, h('h3', {}, mode.name), h('div', { class: 'small dim' }, mode.tagline || ''))),
  );

  if (mode.categories?.length) {
    body.appendChild(h('div', { class: 'eyebrow', style: { marginBottom: '0' } }, 'Challenge categories'));
    body.appendChild(
      h(
        'div',
        { class: 'row row--wrap', style: { gap: '7px' } },
        ...mode.categories.map((c) => {
          const btn = h('button', { class: 'pill pill--selectable', type: 'button', 'aria-pressed': 'false', title: c.description || '' }, c.label);
          btn.onclick = () => {
            if (selectedCategories.has(c.key)) selectedCategories.delete(c.key);
            else selectedCategories.add(c.key);
            btn.setAttribute('aria-pressed', String(selectedCategories.has(c.key)));
          };
          return btn;
        }),
      ),
    );
  }

  const difficulty = { value: 'standard' };
  body.appendChild(h('div', { class: 'eyebrow', style: { marginBottom: '0' } }, 'Difficulty'));
  body.appendChild(
    h(
      'div',
      { class: 'row row--wrap', style: { gap: '7px' } },
      ...['easy', 'standard', 'spicy'].map((d) => {
        const btn = h('button', { class: 'pill pill--selectable', type: 'button', 'aria-pressed': String(d === 'standard') }, d[0].toUpperCase() + d.slice(1));
        btn.onclick = () => {
          difficulty.value = d;
          body.querySelectorAll('.pill--selectable[data-diff]').forEach(() => {});
          btn.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
          btn.setAttribute('aria-pressed', 'true');
        };
        btn.dataset.diff = d;
        return btn;
      }),
    ),
  );

  const status = h('div', {});
  body.appendChild(status);

  const startBtn = h('button', { class: 'btn btn--primary btn--block' }, icon('play', 18), 'Find a partner');
  body.appendChild(startBtn);

  showModal({ title: `Play ${mode.name}`, body, actions: [], dismissible: true });

  let poll = null;
  let cancelled = false;

  const cleanup = () => {
    cancelled = true;
    if (poll) clearInterval(poll);
  };

  startBtn.onclick = async () => {
    startBtn.disabled = true;
    startBtn.textContent = 'Searching…';
    mount(status, h('div', { class: 'row' }, h('div', { class: 'spinner' }), h('span', { class: 'small dim' }, 'Joining the queue…')));
    try {
      const res = await api.post('/api/play/queue', {
        gameKey: mode.key,
        format: 'classic',
        difficulty: difficulty.value,
        categories: [...selectedCategories],
      });
      if (res.status === 'matched' && res.state) {
        cleanup();
        closeModal();
        ctx.navigate(`/match/${res.state.match.publicId}`);
        return;
      }
      mount(
        status,
        banner(res.message || 'Searching for a compatible player.', 'info'),
        h(
          'div',
          { class: 'row row--between', style: { marginTop: '10px' } },
          h('span', { class: 'small dim' }, 'Keep this open or browse — we will notify you.'),
          h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: async () => { cleanup(); await api.del(`/api/play/queue?gameKey=${mode.key}`); toast('Search cancelled.', 'info'); closeModal(); refresh(); } }, 'Cancel'),
        ),
      );
      poll = setInterval(async () => {
        if (cancelled) return;
        try {
          const tick = await api.post('/api/play/queue/tick', { gameKey: mode.key });
          if (tick.status === 'matched' && tick.state) {
            cleanup();
            closeModal();
            ctx.navigate(`/match/${tick.state.match.publicId}`);
          } else if (tick.status === 'idle') {
            cleanup();
            mount(status, banner('Your search ended. You can start a new one any time.', 'warn'));
          }
        } catch {
          /* transient; keep polling */
        }
      }, 2500);
    } catch (err) {
      startBtn.disabled = false;
      startBtn.textContent = 'Find a partner';
      mount(status, banner(err.message, 'error'));
    }
  };

  // Stop polling if the sheet closes.
  const modalRoot = document.getElementById('modal-root');
  const observer = new MutationObserver(() => {
    if (!modalRoot.querySelector('.modal-backdrop')) {
      cleanup();
      observer.disconnect();
    }
  });
  observer.observe(modalRoot, { childList: true });
}

/* -------------------------------- practice -------------------------------- */

async function practice(mode, ctx) {
  try {
    const res = await api.post('/api/play/practice', { gameKey: mode.key });
    const p = res.practice;
    const body = h(
      'div',
      { class: 'stack' },
      h('div', { class: 'prompt-card' }, h('div', { class: 'prompt-card__text' }, p.prompt)),
      h('div', { class: 'banner banner--info' }, h('div', { class: 'grow' }, p.note)),
      h('textarea', { class: 'textarea', placeholder: 'Write your answer for practice…', maxlength: '400' }),
    );
    const textarea = body.querySelector('textarea');
    const feedback = h('div', {});
    showModal({
      title: `Practice · ${mode.name}`,
      body,
      actions: [
        {
          label: 'Score my answer',
          variant: 'primary',
          close: false,
          onClick: async () => {
            const text = textarea.value.trim();
            if (text.length < 4) {
              toast('Write a slightly longer answer first.', 'error');
              return false;
            }
            const scored = await api.post('/api/matches/practice/score', { gameKey: mode.key, body: text });
            mount(
              feedback,
              h(
                'div',
                { class: 'answer-card' },
                h('div', { class: 'row row--between' }, h('span', { class: 'strong small' }, `Practice score: ${scored.score}/100`), pill(scored.judgedBy === 'ai' ? 'AI judged' : 'Local rubric', scored.judgedBy === 'ai' ? 'violet' : '') ),
                h('div', { class: 'judgement' }, ...Object.entries(scored.breakdown).map(([k, v]) =>
                  h('div', { class: 'judgement__item' }, h('div', { class: 'judgement__value' }, String(v)), h('div', { class: 'judgement__label' }, k)),
                )),
                h('div', { class: 'tiny dim', style: { marginTop: '8px' } }, scored.note),
              ),
            );
            body.appendChild(feedback);
            return false;
          },
        },
      ],
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* -------------------------------- helpers -------------------------------- */

function modeName(modes, key) {
  return modes.find((m) => m.key === key)?.name || key.replace(/_/g, ' ');
}

function resultLabel(result) {
  return { win: 'Win', loss: 'Loss', draw: 'Draw', participated: 'Played' }[result] || 'Played';
}

function statusLabel(status) {
  return { active: 'In progress', pending: 'Awaiting accept', abandoned: 'Abandoned', expired: 'Expired', completed: 'Complete' }[status] || status;
}
