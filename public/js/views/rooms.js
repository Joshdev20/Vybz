import { h, mount, clear, icon, avatarEl, timeAgo, plural } from '../dom.js';
import { api } from '../api.js';
import { store, toast, showModal, closeModal, confirmDialog } from '../state.js';
import { on as onRealtime, send as wsSend } from '../realtime.js';
import { pageHead, pill, stateBlock, errorBlock, loadingBlock, banner, sectionHead } from '../components.js';

const CATEGORIES = [
  ['funny', 'Funny'],
  ['personality', 'Personality'],
  ['dating_experiences', 'Dating Experiences'],
  ['romantic', 'Romantic'],
  ['bold_questions', 'Bold Questions'],
  ['friendship', 'Friendship'],
  ['hypotheticals', 'Hypothetical Scenarios'],
];

export async function render(root, ctx) {
  const roomId = ctx.params?.roomId;
  if (roomId) return renderRoom(root, ctx, Number(roomId));
  return renderLobby(root, ctx);
}

/* -------------------------------- lobby -------------------------------- */

async function renderLobby(root, ctx) {
  mount(root, loadingBlock('Loading rooms…'));
  let data;
  const load = async (silent = false) => {
    if (!silent) mount(root, loadingBlock('Loading rooms…'));
    try {
      data = await api.get('/api/rooms');
      if (ctx.isCurrent()) paint();
    } catch (err) {
      if (ctx.isCurrent()) mount(root, errorBlock(err.message, () => load()));
    }
  };

  function paint() {
    const container = h('div', { class: 'stack stack--lg' });
    container.appendChild(
      pageHead({
        eyebrow: 'Spill It!',
        title: 'Truth or dare rooms',
        subtitle: 'Play in a private room with a code, or join a public room. Every player can skip any question or leave at any time.',
        actions: [
          h('button', { class: 'btn btn--primary btn--sm', onclick: () => openCreate() }, icon('plus', 16), 'Create room'),
          h('button', { class: 'btn btn--ghost btn--sm', onclick: () => openJoin() }, 'Join with code'),
        ],
      }),
    );

    if (data.myRooms?.length) {
      container.appendChild(
        h(
          'div',
          {},
          sectionHead('Your rooms'),
          h(
            'div',
            { class: 'stack stack--sm' },
            ...data.myRooms.map((r) =>
              h(
                'button',
                { class: 'list-item', type: 'button', onclick: () => ctx.navigate(`/rooms/${r.id}`) },
                h('div', { class: 'game-tile__icon' }, icon('dice', 20)),
                h('div', { class: 'grow', style: { textAlign: 'left' } },
                  h('div', { class: 'strong' }, r.name),
                  h('div', { class: 'tiny dim' }, `Code ${r.code} · ${r.playerCount}/${r.maxPlayers} players`),
                ),
                pill(r.status === 'active' ? 'In play' : 'Lobby', r.status === 'active' ? 'green' : 'violet'),
              ),
            ),
          ),
        ),
      );
    }

    container.appendChild(
      h(
        'div',
        {},
        sectionHead('Public rooms'),
        data.publicRooms?.length
          ? h(
              'div',
              { class: 'stack stack--sm' },
              ...data.publicRooms.map((r) =>
                h(
                  'div',
                  { class: 'list-item list-item--static' },
                  h('div', { class: 'game-tile__icon' }, icon('dice', 20)),
                  h('div', { class: 'grow', style: { textAlign: 'left' } },
                    h('div', { class: 'strong' }, r.name),
                    h('div', { class: 'tiny dim' }, `${r.playerCount}/${r.maxPlayers} players · ${timeAgo(r.createdAt)}`),
                    r.categories?.length ? h('div', { class: 'row row--wrap', style: { gap: '5px', marginTop: '5px' } }, ...r.categories.slice(0, 3).map((c) => pill(catLabel(c)))) : null,
                  ),
                  h('button', { class: 'btn btn--primary btn--sm', onclick: () => join(r.id) }, 'Join'),
                ),
              ),
            )
          : stateBlock({
              iconName: 'dice',
              title: 'No public rooms open',
              body: 'Nobody has a public room open right now. Create one and share the code, or invite a connection directly.',
              actions: [h('button', { class: 'btn btn--primary', onclick: () => openCreate() }, 'Create a room')],
            }),
      ),
    );

    mount(root, container);
  }

  async function join(id) {
    try {
      await api.post('/api/rooms/join', { roomId: id });
      ctx.navigate(`/rooms/${id}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function openJoin() {
    const input = h('input', { class: 'input', placeholder: 'ABC123', maxlength: '6', style: { textTransform: 'uppercase', letterSpacing: '0.2em', textAlign: 'center', fontSize: '20px' }, 'aria-label': 'Room code' });
    const status = h('div', {});
    showModal({
      title: 'Join a room',
      body: h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'Enter the six-character code you were given.'), input, status),
      actions: [
        {
          label: 'Join',
          variant: 'primary',
          onClick: async () => {
            const code = input.value.trim().toUpperCase();
            if (code.length < 4) {
              mount(status, banner('Enter the full room code.', 'error'));
              return false;
            }
            try {
              const res = await api.post('/api/rooms/join', { code });
              toast('Joined the room.', 'success');
              ctx.navigate(`/rooms/${res.room.id}`);
            } catch (err) {
              mount(status, banner(err.message, 'error'));
              return false;
            }
          },
        },
      ],
    });
  }

  function openCreate() {
    const selected = new Set(['funny', 'personality']);
    let visibility = 'private';
    let maxPlayers = 6;
    const boundaries = { allowBoldQuestions: false, allowPersonalQuestions: true };

    const catHost = h('div', { class: 'row row--wrap', style: { gap: '7px' } });
    const paintCats = () => {
      mount(
        catHost,
        ...CATEGORIES.map(([key, label]) => {
          const btn = h('button', { class: 'pill pill--selectable', type: 'button', 'aria-pressed': String(selected.has(key)) }, label);
          btn.onclick = () => {
            if (selected.has(key)) selected.delete(key);
            else selected.add(key);
            paintCats();
          };
          return btn;
        }),
      );
    };
    paintCats();

    const visHost = h('div', { class: 'row row--wrap', style: { gap: '7px' } });
    const paintVis = () => {
      mount(
        visHost,
        ...[['private', 'Private (code only)'], ['invite', 'Invite only'], ['public', 'Public']].map(([key, label]) => {
          const btn = h('button', { class: 'pill pill--selectable', type: 'button', 'aria-pressed': String(visibility === key) }, label);
          btn.onclick = () => {
            visibility = key;
            paintVis();
          };
          return btn;
        }),
      );
    };
    paintVis();

    const nameInput = h('input', { class: 'input', placeholder: 'Friday night dares', maxlength: '60', 'aria-label': 'Room name' });
    const sizeInput = h('input', { class: 'input', type: 'number', min: '2', max: '10', value: '6', 'aria-label': 'Max players' });
    const boldToggle = h('input', { type: 'checkbox', 'aria-label': 'Allow bold questions' });
    boldToggle.addEventListener('change', () => { boundaries.allowBoldQuestions = boldToggle.checked; });
    const personalToggle = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Allow personal questions' });
    personalToggle.addEventListener('change', () => { boundaries.allowPersonalQuestions = personalToggle.checked; });

    const status = h('div', {});

    showModal({
      title: 'Create a room',
      body: h(
        'div',
        { class: 'stack' },
        h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Room name'), nameInput),
        h('div', { class: 'eyebrow', style: { marginBottom: '0' } }, 'Categories'),
        catHost,
        h('div', { class: 'eyebrow', style: { marginBottom: '0', marginTop: '6px' } }, 'Who can join'),
        visHost,
        h('div', { class: 'field' }, h('label', { class: 'field__label' }, 'Maximum players'), sizeInput),
        h('div', { class: 'eyebrow', style: { marginBottom: '0', marginTop: '6px' } }, 'Boundaries'),
        h('div', { class: 'switch' }, h('div', { class: 'switch__text' }, h('div', { class: 'switch__title' }, 'Allow bold questions'), h('div', { class: 'switch__desc' }, 'Players can still skip any question.')), boldToggle),
        h('div', { class: 'switch' }, h('div', { class: 'switch__text' }, h('div', { class: 'switch__title' }, 'Allow personal questions'), h('div', { class: 'switch__desc' }, 'Off keeps the game light and general.')), personalToggle),
        h('p', { class: 'tiny dim' }, 'VYBZ never asks anyone to share images, perform acts, or reveal another person\u2019s secrets.'),
        status,
      ),
      actions: [
        {
          label: 'Create room',
          variant: 'primary',
          onClick: async () => {
            if (selected.size === 0) {
              mount(status, banner('Pick at least one category.', 'error'));
              return false;
            }
            try {
              const res = await api.post('/api/rooms', {
                name: nameInput.value.trim(),
                visibility,
                maxPlayers: Number(sizeInput.value),
                categories: [...selected],
                boundaries,
              });
              toast('Room created.', 'success');
              ctx.navigate(`/rooms/${res.room.id}`);
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

/* --------------------------------- room --------------------------------- */

async function renderRoom(root, ctx, roomId) {
  mount(root, loadingBlock('Joining room…'));

  let view;
  const load = async (silent = false) => {
    if (!silent) mount(root, loadingBlock('Loading room…'));
    try {
      view = await api.get(`/api/rooms/${roomId}`);
      if (ctx.isCurrent()) paint();
    } catch (err) {
      if (!ctx.isCurrent()) return;
      if (err.status === 403) {
        mount(root, stateBlock({ iconName: 'lock', title: 'You are not in this room', body: 'Private rooms require an invite code.', actions: [h('button', { class: 'btn btn--primary', onclick: () => ctx.navigate('/rooms') }, 'Back to rooms')] }));
      } else if (err.status === 404) {
        mount(root, stateBlock({ iconName: 'dice', title: 'Room not found', body: 'This room may have ended.', actions: [h('button', { class: 'btn btn--primary', onclick: () => ctx.navigate('/rooms') }, 'Back to rooms')] }));
      } else {
        mount(root, errorBlock(err.message, () => load()));
      }
    }
  };

  function paint() {
    const room = view.room;
    const me = view.members.find((m) => m.isMe);
    const container = h('div', { class: 'stack stack--lg' });

    container.appendChild(
      pageHead({
        eyebrow: room.status === 'ended' ? 'Room ended' : room.status === 'active' ? 'In play' : 'Lobby',
        title: room.name,
        subtitle: `${plural(view.members.length, 'player', 'players')} · ${room.visibility} room`,
        actions: [
          h('button', { class: 'btn btn--ghost btn--sm', onclick: () => inviteFlow() }, icon('users', 16), 'Invite'),
          room.isHost && room.status !== 'ended' ? h('button', { class: 'btn btn--danger btn--sm', onclick: endRoom }, 'End room') : null,
          h('button', { class: 'btn btn--ghost btn--sm', onclick: leaveRoom }, icon('logout', 16), 'Leave'),
        ],
      }),
    );

    // Code chip
    if (room.status !== 'ended') {
      container.appendChild(
        h(
          'div',
          { class: 'card stack stack--sm' },
          h('div', { class: 'eyebrow' }, 'Share this code'),
          h('div', { class: 'code-chip' }, room.code),
          h(
            'div',
            { class: 'btn-row' },
            h('button', { class: 'btn btn--ghost btn--sm grow', onclick: () => copyCode(room.code) }, 'Copy code'),
            h('button', { class: 'btn btn--ghost btn--sm grow', onclick: () => copyCode(`${location.origin}/rooms/${room.id}`) }, 'Copy link'),
          ),
        ),
      );
    }

    // Players
    container.appendChild(
      h(
        'div',
        {},
        sectionHead('Players'),
        h(
          'div',
          { class: 'stack stack--sm' },
          ...view.members.map((m) =>
            h(
              'div',
              { class: 'list-item list-item--static' },
              avatarEl(m, 'sm'),
              h('div', { class: 'grow', style: { textAlign: 'left' } },
                h('div', { class: 'row', style: { gap: '7px' } },
                  h('span', { class: 'strong small' }, m.isMe ? 'You' : m.displayName || m.username),
                  m.role === 'host' ? pill('Host', 'violet') : null,
                  view.current?.activeUserId === m.userId ? pill('Their turn', 'pink') : null,
                ),
              ),
              h('span', { class: 'strong' }, String(m.score)),
            ),
          ),
        ),
      ),
    );

    // Game area
    if (room.status === 'ended') {
      container.appendChild(
        stateBlock({ iconName: 'trophy', title: 'Room ended', body: 'Thanks for playing. You can create a new room any time.', actions: [h('button', { class: 'btn btn--primary', onclick: () => ctx.navigate('/rooms') }, 'Back to rooms')] }),
      );
    } else if (view.current) {
      container.appendChild(roundPanel(view.current, room));
    } else {
      container.appendChild(
        h(
          'div',
          { class: 'card stack' },
          h('div', { class: 'eyebrow' }, 'Ready to play'),
          h('p', { class: 'small muted' }, view.members.length < 2
            ? 'You need at least two players. Share the code above to invite someone.'
            : 'Everyone is here. Start the first round when you are ready.'),
          h(
            'div',
            { class: 'btn-row' },
            h('button', { class: 'btn btn--primary grow', disabled: view.members.length < 2, onclick: startRound }, 'Start round'),
            !me?.ready ? h('button', { class: 'btn btn--ghost', onclick: () => setReady(true) }, 'Mark ready') : pill('Ready', 'green'),
          ),
          h('p', { class: 'tiny dim' }, 'Any player can skip their question. Nobody is ever forced to answer.'),
        ),
      );
    }

    // History
    if (view.history?.length) {
      container.appendChild(
        h(
          'div',
          {},
          sectionHead('Previous rounds'),
          h(
            'div',
            { class: 'stack stack--sm' },
            ...view.history.map((r) =>
              h(
                'div',
                { class: 'card stack stack--sm' },
                h('div', { class: 'row row--between' }, h('span', { class: 'eyebrow', style: { marginBottom: '0' } }, `Round ${r.roundNumber}`), r.category ? pill(catLabel(r.category)) : null),
                h('div', { class: 'small muted' }, r.prompt),
                r.answer ? h('div', { class: 'answer-card' }, h('div', { class: 'answer-card__body' }, r.answer)) : h('div', { class: 'tiny dim' }, 'Skipped'),
              ),
            ),
          ),
        ),
      );
    }

    mount(root, container);
  }

  function roundPanel(round, room) {
    const isMyTurn = round.isMyTurn;
    const deadlinePassed = new Date(String(round.deadline).replace(' ', 'T') + 'Z').getTime() < Date.now();

    if (round.phase === 'revealed' || room.status === 'ended') {
      return h(
        'div',
        { class: 'card card--glow stack' },
        h('div', { class: 'eyebrow' }, `Round ${round.roundNumber}`),
        h('div', { class: 'prompt-card' }, h('div', { class: 'prompt-card__text' }, round.prompt)),
        h('div', { class: 'answer-card' }, h('div', { class: 'answer-card__body' }, round.answer || 'Skipped')),
        room.isHost ? h('button', { class: 'btn btn--primary btn--block', onclick: startRound }, 'Next round') : h('p', { class: 'tiny dim center' }, 'Waiting for the host to start the next round.'),
      );
    }

    if (isMyTurn) {
      const textarea = h('textarea', { class: 'textarea', maxlength: '600', placeholder: 'Your answer…', 'aria-label': 'Your answer' });
      const status = h('div', {});
      const answerBtn = h('button', { class: 'btn btn--primary grow' }, 'Submit answer');
      answerBtn.onclick = async () => {
        const text = textarea.value.trim();
        if (!text) return toast('Type an answer or skip.', 'error');
        answerBtn.disabled = true;
        try {
          await api.post(`/api/rooms/${roomId}/round/${round.id}/answer`, { body: text });
          await load(true);
        } catch (err) {
          answerBtn.disabled = false;
          mount(status, banner(err.message, 'error'));
        }
      };
      return h(
        'div',
        { class: 'card card--glow stack' },
        h('div', { class: 'row row--between' }, h('span', { class: 'eyebrow', style: { marginBottom: '0' } }, `Round ${round.roundNumber} · your turn`), round.category ? pill(catLabel(round.category)) : null),
        h('div', { class: 'prompt-card' }, h('div', { class: 'prompt-card__text' }, round.prompt)),
        textarea,
        h('div', { class: 'btn-row' }, answerBtn, h('button', { class: 'btn btn--ghost', onclick: skip }, 'Skip')),
        status,
        h('p', { class: 'tiny dim center' }, 'Only your answer is shown. Skipping is always allowed and never penalised.'),
      );
    }

    const activeMember = view.members.find((m) => m.userId === round.activeUserId);
    return h(
      'div',
      { class: 'card stack' },
      h('div', { class: 'eyebrow' }, `Round ${round.roundNumber}`),
      h('div', { class: 'prompt-card' }, h('div', { class: 'prompt-card__text' }, round.prompt)),
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'spinner' }),
        h('span', { class: 'small dim' }, `${activeMember?.displayName || activeMember?.username || 'A player'} is answering…`),
      ),
      deadlinePassed
        ? h('button', { class: 'btn btn--ghost btn--block', onclick: skip }, 'Skip this round')
        : h('p', { class: 'tiny dim' }, 'Answers are revealed once submitted, or when the timer runs out.'),
    );
  }

  async function startRound() {
    try {
      await api.post(`/api/rooms/${roomId}/round`, {});
      await load(true);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function skip() {
    const round = view.current;
    if (!round) return;
    try {
      await api.post(`/api/rooms/${roomId}/round/${round.id}/skip`, {});
      await load(true);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function setReady(ready) {
    try {
      await api.post(`/api/rooms/${roomId}/ready`, { ready });
      await load(true);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function endRoom() {
    if (!(await confirmDialog({ title: 'End this room?', message: 'All players will be returned to the lobby. This cannot be undone.', confirmLabel: 'End room', danger: true }))) return;
    try {
      await api.post(`/api/rooms/${roomId}/end`, {});
      toast('Room ended.', 'info');
      ctx.navigate('/rooms');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function leaveRoom() {
    if (!(await confirmDialog({ title: 'Leave this room?', message: 'You can rejoin with the code if the room is still open.', confirmLabel: 'Leave' }))) return;
    try {
      await api.post(`/api/rooms/${roomId}/leave`, {});
      ctx.navigate('/rooms');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function inviteFlow() {
    let connections;
    try {
      connections = await api.get('/api/connections');
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    if (!connections.connections.length) {
      showModal({ title: 'Invite a player', body: banner('You have no connections yet. Share the room code instead.', 'info'), actions: [{ label: 'Close', variant: 'ghost' }] });
      return;
    }
    const status = h('div', {});
    showModal({
      title: 'Invite a connection',
      body: h(
        'div',
        { class: 'stack stack--sm' },
        ...connections.connections.map((c) =>
          h(
            'div',
            { class: 'list-item list-item--static' },
            avatarEl(c.user, 'sm'),
            h('div', { class: 'grow', style: { textAlign: 'left' } }, h('div', { class: 'strong small' }, c.user.displayName || c.user.username)),
            h('button', { class: 'btn btn--primary btn--sm', onclick: async (e) => {
              e.target.disabled = true;
              try {
                await api.post(`/api/rooms/${roomId}/invite`, { userId: c.user.userId });
                toast('Invitation sent.', 'success');
                e.target.textContent = 'Invited';
              } catch (err) {
                e.target.disabled = false;
                toast(err.message, 'error');
              }
            } }, 'Invite'),
          ),
        ),
        status,
      ),
      actions: [{ label: 'Close', variant: 'ghost' }],
    });
  }

  function copyCode(text) {
    navigator.clipboard?.writeText(text).then(
      () => toast('Copied to clipboard.', 'success'),
      () => toast('Could not copy automatically.', 'error'),
    );
  }

  /* ------------------------------ realtime ------------------------------ */
  const offRoom = onRealtime('room_update', (payload) => {
    if (ctx.isCurrent()) load(true);
  });
  const offState = onRealtime('room:state', () => {
    if (ctx.isCurrent()) load(true);
  });

  const observer = new MutationObserver(() => {
    if (!document.body.contains(root)) {
      offRoom?.();
      offState?.();
      observer.disconnect();
    }
  });
  observer.observe(document.getElementById('app'), { childList: true, subtree: true });

  await load();
}

function catLabel(key) {
  return CATEGORIES.find(([k]) => k === key)?.[1] || String(key).replace(/_/g, ' ');
}
