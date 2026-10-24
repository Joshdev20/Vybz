import { h, mount, clear, icon, avatarEl, timeAgo } from '../dom.js';
import { api } from '../api.js';
import { store, toast, showModal, closeModal, confirmDialog } from '../state.js';
import { on as onRealtime } from '../realtime.js';
import {
  pageHead,
  pill,
  stateBlock,
  errorBlock,
  loadingBlock,
  countdown,
  roundDots,
  banner,
} from '../components.js';

export async function render(root, ctx) {
  const { publicId } = ctx.params;
  if (!publicId) return ctx.navigate('/play');

  let state;
  const load = async (silent = false) => {
    if (!silent) mount(root, loadingBlock('Loading match…'));
    try {
      state = await api.get(`/api/matches/${publicId}`);
      if (ctx.isCurrent()) paint();
    } catch (err) {
      if (!ctx.isCurrent()) return;
      if (err.status === 404) {
        mount(root, stateBlock({ iconName: 'clock', title: 'Match not found', body: 'This match has expired or was removed.', actions: [h('button', { class: 'btn btn--primary', onclick: () => ctx.navigate('/play') }, 'Back to Play')] }));
      } else if (err.status === 403) {
        mount(root, stateBlock({ iconName: 'lock', title: 'You are not in this match', body: 'Only the two players in a match can view it.' }));
      } else {
        mount(root, errorBlock(err.message, () => load()));
      }
    }
  };

  const paint = () => {
    const c = h('div', { class: 'arena stack' });

    /* ---------------------------- status strip ---------------------------- */
    c.appendChild(
      h(
        'div',
        { class: 'row row--between row--wrap' },
        h('div', { class: 'row' }, icon(modeIcon(state.match.gameKey), 20), h('span', { class: 'strong' }, state.match.gameName)),
        h('div', { class: 'row row--wrap' }, pill(`Round ${state.match.currentRound}/${state.match.totalRounds}`, 'violet'), statusPill(state.match.status), state.match.judgedBy ? pill(state.match.judgedBy === 'ai' ? 'AI judged' : 'Rubric judged', state.match.judgedBy === 'ai' ? 'violet' : '') : null),
      ),
    );

    if (store.connection !== 'online') {
      c.appendChild(banner('Live updates paused while reconnecting. Your answers are saved on the server.', 'warn'));
    }

    /* ------------------------------ scoreboard ------------------------------ */
    const opp = state.match.opponent;
    c.appendChild(
      h(
        'div',
        { class: 'card scoreboard' },
        h(
          'div',
          { class: 'scoreboard__player' },
          avatarEl({ ...(opp || {}), presence: undefined }, 'md'),
          h('div', { class: 'small truncate', style: { marginTop: '5px' } }, opp ? opp.displayName || opp.username : 'Opponent'),
          h('div', { class: 'scoreboard__score' }, String(opp?.score ?? 0)),
        ),
        h('div', { class: 'stack stack--sm', style: { alignItems: 'center' } }, h('span', { class: 'scoreboard__vs' }, 'VS'), roundDots(state.match.totalRounds, state.match.currentRound, state.round?.phase)),
        h(
          'div',
          { class: 'scoreboard__player' },
          avatarEl({ ...store.profile, avatarKind: store.profile?.avatar_kind, avatarValue: store.profile?.avatar_value }, 'md'),
          h('div', { class: 'small truncate', style: { marginTop: '5px' } }, 'You'),
          h('div', { class: 'scoreboard__score gradient-text' }, String(state.match.myScore ?? 0)),
        ),
      ),
    );

    /* ------------------------------- by status ------------------------------- */
    if (state.match.status === 'pending') c.appendChild(pendingPanel());
    else if (state.match.status === 'active') c.appendChild(activePanel());
    else if (state.match.status === 'completed') c.appendChild(completedPanel());
    else c.appendChild(endedPanel());

    mount(root, c);
  };

  /* ------------------------------ pending ------------------------------ */
  function pendingPanel() {
    const iAccepted = state.match.myAccepted;
    const theyAccepted = state.match.opponent?.accepted;
    const panel = h(
      'div',
      { class: 'card stack' },
      h('div', { class: 'eyebrow' }, 'Match found'),
      h('h2', {}, iAccepted ? (theyAccepted ? 'Starting…' : 'Waiting for your opponent') : 'Accept this match?'),
      h('p', { class: 'small muted', style: { marginBottom: '0' } }, iAccepted
        ? 'You are in. The first round starts as soon as both players accept.'
        : 'Accept to start playing. If you decline, the match is cancelled for both players.'),
      h(
        'div',
        { class: 'row row--wrap' },
        pill(`You: ${iAccepted ? 'accepted' : 'not yet'}`, iAccepted ? 'green' : 'amber'),
        pill(`Opponent: ${theyAccepted ? 'accepted' : 'not yet'}`, theyAccepted ? 'green' : 'amber'),
      ),
      h(
        'div',
        { class: 'btn-row' },
        !iAccepted ? h('button', { class: 'btn btn--primary grow', onclick: accept }, 'Accept match') : null,
        h('button', { class: 'btn btn--danger', onclick: decline }, 'Decline'),
      ),
    );
    return panel;
  }

  async function accept() {
    try {
      await api.post(`/api/matches/${publicId}/accept`);
      await load(true);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function decline() {
    if (!(await confirmDialog({ title: 'Decline this match?', message: 'The match will be cancelled for both players. You can queue again straight away.', confirmLabel: 'Decline', danger: true }))) return;
    try {
      await api.post(`/api/matches/${publicId}/decline`);
      toast('Match declined.', 'info');
      ctx.navigate('/play');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ------------------------------- active ------------------------------- */
  function activePanel() {
    const round = state.round;
    if (!round) return loadingBlock('Preparing the next round…');

    if (round.phase === 'submitting') return submittingPanel(round);
    if (round.phase === 'voting') return votingPanel(round);
    if (round.phase === 'scored') return scoredPanel(round);
    return loadingBlock('Waiting for the round to begin…');
  }

  function submittingPanel(round) {
    const already = Boolean(round.mySubmission);
    const textarea = h('textarea', {
      class: 'textarea',
      maxlength: '400',
      placeholder: round.mySubmission ? 'Answer submitted. You can edit until the timer ends.' : 'Type your best answer…',
      value: round.mySubmission?.body || '',
      'aria-label': 'Your answer',
    });
    const counter = h('div', { class: 'tiny dim', style: { textAlign: 'right' } }, '0 / 400');
    textarea.addEventListener('input', () => {
      counter.textContent = `${textarea.value.length} / 400`;
    });
    counter.textContent = `${textarea.value.length} / 400`;

    const submitBtn = h('button', { class: 'btn btn--primary btn--block' }, icon('send', 18), already ? 'Update answer' : 'Submit answer');
    const status = h('div', {});

    const doSubmit = async () => {
      const body = textarea.value.trim();
      if (body.length < 2) return toast('Write a slightly longer answer.', 'error');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting…';
      try {
        await api.post(`/api/matches/${publicId}/submit`, { body });
        toast(already ? 'Answer updated.' : 'Answer submitted.', 'success');
        await load(true);
      } catch (err) {
        submitBtn.disabled = false;
        mount(status, banner(err.message, 'error'));
        if (/deadline|closed|not accepting/i.test(err.message)) await load(true);
      }
    };
    submitBtn.onclick = doSubmit;

    const timer = countdown({
      deadline: round.submissionDeadline,
      totalSeconds: round.roundSeconds,
      onExpire: () => {
        mount(status, banner('Time is up. Waiting for the reveal…', 'warn'));
        setTimeout(() => load(true), 1200);
      },
    });

    return h(
      'div',
      { class: 'stack' },
      h('div', { class: 'prompt-card' }, h('div', { class: 'eyebrow', style: { color: 'rgba(255,255,255,0.6)' } }, 'Your prompt'), h('div', { class: 'prompt-card__text' }, round.prompt)),
      h('div', { class: 'row row--between row--wrap' }, timer, h('div', { class: 'row' }, pill(round.mySubmission ? 'Submitted' : 'Not submitted', round.mySubmission ? 'green' : 'amber'))),
      h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'answer' }, 'Your answer'), textarea, counter),
      submitBtn,
      status,
      h('p', { class: 'tiny dim center' }, 'The timer is enforced by the server. Answers are hidden from your opponent until the reveal.'),
    );
  }

  function votingPanel(round) {
    const subs = round.submissions || [];
    const mine = subs.find((s) => s.isMe);
    const theirs = subs.find((s) => !s.isMe);
    const voted = round.myVote !== null && round.myVote !== undefined;

    const timer = countdown({
      deadline: round.votingDeadline,
      totalSeconds: Math.max(10, Math.round((new Date(String(round.votingDeadline).replace(' ', 'T') + 'Z') - new Date(String(round.submissionDeadline).replace(' ', 'T') + 'Z')) / 1000)),
      onExpire: () => setTimeout(() => load(true), 1200),
    });

    const myAnswerCard = mine
      ? h('div', { class: 'answer-card answer-card--mine' }, h('div', { class: 'answer-card__votes' }, 'Your answer'), h('div', { class: 'answer-card__body' }, round.mySubmission?.body || '—'))
      : h('div', { class: 'answer-card' }, h('div', { class: 'answer-card__body dim' }, 'You did not submit an answer this round.'));

    const theirCard = theirs
      ? h(
          'div',
          { class: 'answer-card' },
          h('div', { class: 'answer-card__votes' }, 'Opponent'),
          h('div', { class: 'answer-card__body' }, 'Answer hidden until voting closes.'),
        )
      : h('div', { class: 'answer-card' }, h('div', { class: 'answer-card__body dim' }, 'Your opponent did not submit an answer.'));

    const voteBtn = theirs
      ? h('button', { class: 'btn btn--primary btn--block', disabled: voted }, voted ? 'Vote recorded' : 'Vote for your opponent')
      : null;
    if (voteBtn && !voted) {
      voteBtn.onclick = async () => {
        voteBtn.disabled = true;
        voteBtn.textContent = 'Sending vote…';
        try {
          await api.post(`/api/matches/${publicId}/vote`, { targetUserId: theirs.userId });
          toast('Vote recorded.', 'success');
          await load(true);
        } catch (err) {
          voteBtn.disabled = false;
          voteBtn.textContent = 'Vote for your opponent';
          toast(err.message, 'error');
        }
      };
    }

    return h(
      'div',
      { class: 'stack' },
      h('div', { class: 'eyebrow' }, 'Vote for the stronger answer'),
      h('div', { class: 'row row--between row--wrap' }, timer, voted ? pill('You voted', 'green') : pill('Awaiting your vote', 'amber')),
      theirCard,
      myAnswerCard,
      voteBtn,
      h('p', { class: 'tiny dim center' }, 'You cannot vote for yourself. Each player may vote once per round.'),
    );
  }

  function scoredPanel(round) {
    const subs = round.submissions || [];
    const results = round.results || [];
    // A round can be drawn, in which case no row carries reason 'round_win'.
    // Deriving the winner from the reason keeps both players' views consistent
    // instead of assuming the highest-points row won.
    const winnerId = results.find((r) => r.reason === 'round_win')?.user_id;
    const iWon = Boolean(winnerId) && winnerId === store.user.id;

    return h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'card card--glow stack' },
        h('div', { class: 'eyebrow' }, `Round ${round.roundNumber} result`),
        h('h2', {}, iWon ? 'You took this round' : winnerId ? 'Your opponent took this round' : 'Round drawn'),
        h('div', { class: 'row row--wrap' }, ...results.map((r) =>
          h('span', { class: `pill ${r.user_id === store.user.id ? 'pill--violet' : ''}` }, `${r.user_id === store.user.id ? 'You' : 'Opponent'}: +${r.points}`),
        )),
      ),
      h('div', { class: 'prompt-card' }, h('div', { class: 'prompt-card__text' }, round.prompt)),
      ...subs.map((s) => {
        const isWinner = s.userId === winnerId;
        const r = results.find((x) => x.user_id === s.userId);
        return h(
          'div',
          { class: `answer-card ${s.isMe ? 'answer-card--mine' : ''} ${isWinner ? 'answer-card--winner' : ''}` },
          h(
            'div',
            { class: 'row row--between' },
            h('div', { class: 'row' }, h('span', { class: 'strong small' }, s.isMe ? 'You' : s.username), isWinner ? pill('Round winner', 'green') : null),
            h('span', { class: 'answer-card__votes' }, `${s.votes || 0} vote${(s.votes || 0) === 1 ? '' : 's'}${r ? ` · +${r.points}` : ''}`),
          ),
          h('div', { class: 'answer-card__body' }, s.body || '—'),
          s.judgeScore !== null && s.judgeScore !== undefined
            ? h(
                'div',
                { class: 'judgement' },
                ...['creativity', 'relevance', 'humour', 'originality'].map((k) =>
                  h('div', { class: 'judgement__item' },
                    h('div', { class: 'judgement__value' }, String(parseBreakdown(s.judgeNotes)?.[k] ?? '—')),
                    h('div', { class: 'judgement__label' }, k),
                  ),
                ),
              )
            : null,
        );
      }),
      h('p', { class: 'tiny dim center' }, 'Next round starts automatically in a few seconds.'),
    );
  }

  /* ------------------------------ completed ------------------------------ */
  function completedPanel() {
    const outcome = state.outcome;
    const mine = outcome.participants.find((p) => p.isMe);
    const title = mine?.result === 'win' ? 'You won!' : mine?.result === 'loss' ? 'You lost this one' : 'Draw';

    return h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: `card stack ${mine?.result === 'win' ? 'card--glow' : ''}` },
        h('div', { class: 'eyebrow' }, 'Final result'),
        h('h2', { class: 'gradient-text' }, title),
        h(
          'div',
          { class: 'stack stack--sm' },
          ...outcome.participants.map((p) =>
            h(
              'div',
              { class: 'row row--between' },
              h('div', { class: 'row' }, h('span', { class: 'strong' }, p.isMe ? 'You' : p.username), p.result === 'win' ? pill('Winner', 'green') : null),
              h('span', { class: 'scoreboard__score', style: { fontSize: '22px' } }, String(p.score)),
            ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn btn--primary grow', onclick: rematch }, icon('bolt', 18), 'Rematch'),
        outcome.canConnect ? h('button', { class: 'btn btn--pink grow', onclick: connectNow }, icon('heart', 18), 'Connect') : null,
        h('button', { class: 'btn btn--ghost', onclick: () => ctx.navigate('/play') }, 'Play something else'),
      ),
      outcome.canConnect
        ? h('p', { class: 'tiny dim center' }, 'Connecting opens a private conversation. Either of you can leave, unmatch or block at any time.')
        : h('p', { class: 'tiny dim center' }, 'Connecting is unavailable for this match.'),
    );
  }

  function endedPanel() {
    const status = state.match.status;
    const copy = {
      abandoned: 'This match ended because a player left. It is recorded as abandoned and does not count as a win or loss.',
      declined: 'This match was declined, so it never started. Nothing was scored.',
      expired: 'This match expired before it could start, usually because nobody accepted in time.',
      cancelled: 'This match was cancelled before it started.',
    }[status] || 'This match is no longer active.';
    return h(
      'div',
      { class: 'stack' },
      stateBlock({ iconName: 'clock', title: 'Match ended', body: copy, actions: [h('button', { class: 'btn btn--primary', onclick: () => ctx.navigate('/play') }, 'Back to Play')] }),
    );
  }

  async function rematch() {
    try {
      const res = await api.post(`/api/matches/${publicId}/rematch`, {});
      if (res.match) {
        toast('Rematch ready.', 'success');
        ctx.navigate(`/match/${res.match.public_id || res.match.publicId}`);
      } else {
        toast(res.message || 'Rematch invite sent to your opponent.', 'info');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function connectNow() {
    try {
      await api.post(`/api/matches/${publicId}/connect`, {});
      toast('Conversation opened. Say hello.', 'success');
      ctx.navigate('/inbox');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ------------------------------ live updates ------------------------------ */
  const offMatch = onRealtime('match_update', (payload) => {
    if (payload?.publicId === publicId && ctx.isCurrent()) load(true);
  });
  const offState = onRealtime('match:state', (payload) => {
    if (payload?.match?.publicId === publicId && ctx.isCurrent()) load(true);
  });

  // Poll as a fallback for round transitions (deadlines are server-side).
  const poll = setInterval(() => {
    if (ctx.isCurrent() && store.connection !== 'online') load(true);
  }, 6000);

  // Clean up when the view is replaced.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(root)) {
      clearInterval(poll);
      offMatch?.();
      offState?.();
      observer.disconnect();
    }
  });
  observer.observe(document.getElementById('app'), { childList: true, subtree: true });

  await load();
}

function parseBreakdown(notes) {
  if (!notes) return {};
  try {
    const parsed = JSON.parse(notes);
    return parsed?.breakdown || {};
  } catch {
    // Older rows stored a plain note string rather than the JSON envelope.
    return {};
  }
}

/** Human-readable judge note, tolerating both the JSON envelope and legacy text. */
function parseNotes(notes) {
  if (!notes) return '';
  try {
    return JSON.parse(notes)?.notes || '';
  } catch {
    return notes;
  }
}

function statusPill(status) {
  const map = {
    pending: ['Awaiting accept', 'amber'],
    active: ['Live', 'green'],
    completed: ['Complete', ''],
    abandoned: ['Abandoned', 'red'],
    declined: ['Declined', 'red'],
    expired: ['Expired', 'amber'],
    cancelled: ['Cancelled', 'amber'],
  };
  const [label, variant] = map[status] || [status, ''];
  return pill(label, variant);
}

function modeIcon(key) {
  return { rizz_battle: 'mic', word_chemistry: 'spark', spill_it: 'dice', blind_vibe: 'heart' }[key] || 'play';
}
