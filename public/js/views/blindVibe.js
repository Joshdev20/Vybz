import { h, mount, clear, icon, avatarEl, timeAgo } from '../dom.js';
import { api } from '../api.js';
import { store, toast, showModal, closeModal, confirmDialog } from '../state.js';
import { on as onRealtime } from '../realtime.js';
import { pageHead, pill, stateBlock, errorBlock, loadingBlock, banner, sectionHead } from '../components.js';

export async function render(root, ctx) {
  const publicId = ctx.params?.publicId;
  if (publicId) return renderSession(root, ctx, publicId);
  return renderLobby(root, ctx);
}

/* -------------------------------- lobby -------------------------------- */

async function renderLobby(root, ctx) {
  mount(root, loadingBlock('Loading Blind Vibe…'));
  let data;
  const load = async (silent = false) => {
    if (!silent) mount(root, loadingBlock('Loading…'));
    try {
      data = await api.get('/api/blind-vibe');
      if (ctx.isCurrent()) paint();
    } catch (err) {
      if (ctx.isCurrent()) mount(root, errorBlock(err.message, () => load()));
    }
  };

  function paint() {
    const container = h('div', { class: 'stack stack--lg' });
    container.appendChild(
      pageHead({
        eyebrow: 'Blind Vibe',
        title: 'Talk first, reveal later',
        subtitle: 'Meet through conversation before either of you shows a profile. You both have to choose to reveal — one-sided interest stays private.',
      }),
    );

    container.appendChild(
      h(
        'div',
        { class: 'banner banner--info' },
        icon('shield', 18),
        h('div', { class: 'grow' }, 'Photos, location and contact details are never shared before a mutual reveal. You can leave at any stage.'),
      ),
    );

    const active = (data.sessions || []).filter((s) => s.status === 'active');
    const past = (data.sessions || []).filter((s) => s.status !== 'active');

    container.appendChild(
      h(
        'div',
        { class: 'card card--glow stack' },
        h('div', { class: 'eyebrow' }, 'Start'),
        h('h3', {}, 'Find a Blind Vibe partner'),
        h('p', { class: 'small muted' }, 'You will be paired with another player who also wants a staged conversation. If nobody is available, you will see an honest waiting state — never a simulated partner.'),
        h('button', { class: 'btn btn--primary btn--block', onclick: startQueue }, icon('heart', 18), 'Find a partner'),
        h('div', { id: 'bv-status' }),
      ),
    );

    if (active.length) {
      container.appendChild(
        h(
          'div',
          {},
          sectionHead('Active conversations'),
          h(
            'div',
            { class: 'stack stack--sm' },
            ...active.map((s) =>
              h(
                'button',
                { class: 'list-item', type: 'button', onclick: () => ctx.navigate(`/blind-vibe/${s.publicId}`) },
                h('div', { class: 'game-tile__icon' }, icon('heart', 20)),
                h('div', { class: 'grow', style: { textAlign: 'left' } },
                  h('div', { class: 'strong' }, s.other.revealed ? s.other.displayName || s.other.username : 'Mystery player'),
                  h('div', { class: 'tiny dim' }, `Stage ${s.stage} of ${s.totalStages} · ${s.isMutual ? 'Connected' : 'In progress'}`),
                ),
                s.isMutual ? pill('Revealed', 'green') : pill('Anonymous', 'violet'),
              ),
            ),
          ),
        ),
      );
    }

    if (past.length) {
      container.appendChild(
        h(
          'div',
          {},
          sectionHead('Past sessions'),
          h(
            'div',
            { class: 'stack stack--sm' },
            ...past.map((s) =>
              h(
                'div',
                { class: 'list-item list-item--static' },
                h('div', { class: 'game-tile__icon' }, icon('heart', 18)),
                h('div', { class: 'grow', style: { textAlign: 'left' } },
                  h('div', { class: 'small strong' }, s.other.revealed ? s.other.displayName || s.other.username : 'Anonymous player'),
                  h('div', { class: 'tiny dim' }, `${timeAgo(s.updatedAt)} · ${s.status === 'revealed' ? 'Mutual reveal' : 'Ended'}`),
                ),
                pill(s.status === 'revealed' ? 'Revealed' : 'Ended', s.status === 'revealed' ? 'green' : ''),
              ),
            ),
          ),
        ),
      );
    }

    mount(root, container);
  }

  async function startQueue() {
    const status = document.getElementById('bv-status');
    mount(status, h('div', { class: 'row', style: { marginTop: '10px' } }, h('div', { class: 'spinner' }), h('span', { class: 'small dim' }, 'Searching…')));
    try {
      const res = await api.post('/api/blind-vibe/queue', {});
      if (res.status === 'matched' && res.session) {
        ctx.navigate(`/blind-vibe/${res.session.publicId}`);
        return;
      }
      mount(
        status,
        banner(res.message || 'Searching for a partner.', 'info'),
        h('button', { class: 'btn btn--ghost btn--block', style: { marginTop: '10px' }, onclick: async () => { await api.del('/api/blind-vibe/queue'); toast('Search cancelled.', 'info'); await load(true); } }, 'Cancel search'),
      );
      // Poll for a partner.
      const poll = setInterval(async () => {
        try {
          const res2 = await api.post('/api/blind-vibe/queue', {});
          if (res2.status === 'matched' && res2.session) {
            clearInterval(poll);
            ctx.navigate(`/blind-vibe/${res2.session.publicId}`);
          }
        } catch {
          /* keep polling */
        }
      }, 3500);
    } catch (err) {
      mount(status, banner(err.message, 'error'));
    }
  }

  await load();
}

/* ------------------------------- session ------------------------------- */

async function renderSession(root, ctx, publicId) {
  mount(root, loadingBlock('Opening Blind Vibe…'));

  let view;
  const load = async (silent = false) => {
    if (!silent) mount(root, loadingBlock('Loading…'));
    try {
      view = await api.get(`/api/blind-vibe/${publicId}`);
      if (ctx.isCurrent()) paint();
    } catch (err) {
      if (!ctx.isCurrent()) return;
      mount(
        root,
        err.status === 403
          ? stateBlock({ iconName: 'lock', title: 'Not available', body: 'You are not part of this session.' })
          : errorBlock(err.message, () => load()),
      );
    }
  };

  function paint() {
    const s = view.session;
    const other = view.other;
    const container = h('div', { class: 'stack stack--lg' });
    const revealed = Boolean(other.userId);

    container.appendChild(
      pageHead({
        eyebrow: revealed ? 'Revealed' : `Stage ${s.stage} of ${view.stages.length}`,
        title: revealed ? other.displayName || other.username : 'Mystery player',
        subtitle: revealed
          ? 'You both chose to reveal. You can now see each other and keep talking.'
          : view.stages.find((x) => x.stage === s.stage)?.description || 'Getting to know each other.',
        actions: [h('button', { class: 'btn btn--ghost btn--sm', onclick: leave }, 'Leave')],
      }),
    );

    // Stage progress
    container.appendChild(
      h(
        'div',
        { class: 'row', style: { gap: '6px' } },
        ...view.stages.map((st) =>
          h('div', { class: 'grow', title: st.label }, h('div', { class: 'progress progress--thin' }, h('div', { class: 'progress__bar', style: { width: st.stage <= s.stage ? '100%' : '0%' } }))),
        ),
      ),
    );

    // Reveal card
    container.appendChild(
      h(
        'div',
        { class: `card stack ${revealed ? 'card--pink' : ''}` },
        h(
          'div',
          { class: 'row' },
          avatarEl(revealed ? other : { avatarValue: 'mystery' }, revealed ? 'lg' : 'lg'),
          h(
            'div',
            { class: 'grow' },
            h('div', { class: 'strong' }, revealed ? other.displayName || other.username : 'Anonymous'),
            h('div', { class: 'small dim' }, revealed ? (other.bio || 'No bio yet.') : 'Profile hidden until you both reveal.'),
            view.sharedInterests?.length
              ? h('div', { class: 'row row--wrap', style: { gap: '5px', marginTop: '6px' } }, ...view.sharedInterests.map((i) => pill(i.label, 'pink')))
              : null,
          ),
        ),
        !revealed
          ? h('div', { class: 'banner banner--info' }, icon('lock', 16), h('div', { class: 'grow' }, 'No photos, location or contact details are shared at this stage.'))
          : null,
      ),
    );

    // Stage prompt
    if (!revealed && s.prompt) {
      container.appendChild(h('div', { class: 'prompt-card' }, h('div', { class: 'eyebrow', style: { color: 'rgba(255,255,255,0.6)' } }, 'Try this'), h('div', { class: 'prompt-card__text' }, s.prompt)));
    }

    // Chat
    const chatBody = h('div', { class: 'chat__body', style: { maxHeight: '320px', minHeight: '160px' } });
    if (view.messages?.length) {
      mount(chatBody, ...view.messages.map((m) => h('div', { class: `msg ${m.mine ? 'msg--mine' : 'msg--them'}` }, h('div', {}, m.body), h('div', { class: 'msg__meta' }, timeAgo(m.at)))));
    } else {
      mount(chatBody, h('div', { class: 'state__body' }, 'No messages yet. Say hello.'));
    }
    const input = h('textarea', { class: 'textarea', rows: '1', maxlength: '600', placeholder: 'Write a message…', 'aria-label': 'Message' });
    const sendBtn = h('button', { class: 'btn btn--primary btn--icon', 'aria-label': 'Send' }, icon('send', 18));
    const doSend = async () => {
      const text = input.value.trim();
      if (!text) return;
      sendBtn.disabled = true;
      try {
        const res = await api.post(`/api/blind-vibe/${publicId}/message`, { body: text });
        input.value = '';
        view = res;
        paint();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        sendBtn.disabled = false;
      }
    };
    sendBtn.onclick = doSend;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });

    container.appendChild(
      h('div', { class: 'card card--flush' }, h('div', { class: 'card__pad' },
        h('div', { class: 'eyebrow' }, 'Conversation'),
        chatBody,
        h('div', { class: 'chat__composer' }, input, sendBtn),
      )),
    );

    // Interest / reveal controls
    if (!revealed) {
      const iSaid = s.myInterest === true;
      container.appendChild(
        h(
          'div',
          { class: 'card stack' },
          h('div', { class: 'eyebrow' }, 'Do you want to reveal?'),
          h('p', { class: 'small muted' }, 'Your answer is private. You only reveal if you both say yes. If only one of you does, nobody is told which of you it was.'),
          h(
            'div',
            { class: 'btn-row' },
            h('button', { class: `btn ${iSaid ? 'btn--ghost' : 'btn--pink'} grow`, onclick: () => express(!iSaid) }, icon('heart', 16), iSaid ? 'You said yes — undo' : 'Yes, reveal'),
            h('button', { class: 'btn btn--ghost', onclick: () => express(false) }, 'Not yet'),
          ),
          iSaid ? banner('Your interest is saved privately. We will connect you if they feel the same.', 'info') : null,
        ),
      );
    } else {
      container.appendChild(
        h(
          'div',
          { class: 'btn-row' },
          h('button', { class: 'btn btn--primary grow', onclick: openChat }, icon('chat', 16), 'Continue in inbox'),
          h('button', { class: 'btn btn--ghost', onclick: report }, 'Report'),
        ),
      );
    }

    if (!revealed) {
      container.appendChild(
        h('div', { class: 'btn-row' }, h('button', { class: 'btn btn--ghost', onclick: () => advance() }, 'Next stage'), h('button', { class: 'btn btn--ghost', onclick: report }, 'Report')),
      );
    }

    mount(root, container);
  }

  async function express(interested) {
    try {
      const res = await api.post(`/api/blind-vibe/${publicId}/interest`, { interested });
      view = res;
      if (res.mutual) toast('You matched! You can both see each other now.', 'success');
      paint();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function advance() {
    try {
      view = await api.post(`/api/blind-vibe/${publicId}/stage`, {});
      paint();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function leave() {
    if (!(await confirmDialog({ title: 'Leave this session?', message: 'The conversation ends for both of you. This cannot be undone.', confirmLabel: 'Leave', danger: true }))) return;
    try {
      await api.post(`/api/blind-vibe/${publicId}/end`, {});
      ctx.navigate('/blind-vibe');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function openChat() {
    api.post('/api/inbox/open', { userId: view.other.userId }).then(
      (res) => ctx.navigate(`/inbox/${res.conversationId}`),
      (err) => toast(err.message, 'error'),
    );
  }

  function report() {
    let reason = 'harassment';
    const reasons = [
      ['harassment', 'Harassment or abuse'],
      ['sexual_content', 'Unwanted sexual content'],
      ['threats', 'Threats or stalking'],
      ['spam', 'Spam'],
      ['underage', 'Suspected underage account'],
      ['other', 'Something else'],
    ];
    const details = h('textarea', { class: 'textarea', maxlength: '500', placeholder: 'What happened?' });
    showModal({
      title: 'Report this session',
      body: h(
        'div',
        { class: 'stack stack--sm' },
        h('p', { class: 'small muted' }, 'Reports are reviewed by moderators. The other player is not told who reported them.'),
        ...reasons.map(([key, label]) => {
          const input = h('input', { type: 'radio', name: 'reason', value: key, checked: key === reason, style: { accentColor: 'var(--violet)' } });
          input.addEventListener('change', () => { reason = key; });
          return h('label', { class: 'row', style: { gap: '10px', cursor: 'pointer', padding: '4px 0' } }, input, h('span', { class: 'small' }, label));
        }),
        details,
      ),
      actions: [
        {
          label: 'Submit report',
          variant: 'danger',
          onClick: async () => {
            try {
              const res = await api.post(`/api/blind-vibe/${publicId}/report`, { reason, details: details.value.trim() });
              toast(res.note || 'Report submitted.', 'success');
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
      ],
    });
  }

  const offMsg = onRealtime('blind_vibe_message', (payload) => {
    if (payload?.publicId === publicId && ctx.isCurrent()) load(true);
  });
  const offUpdate = onRealtime('blind_vibe_update', (payload) => {
    if (payload?.publicId === publicId && ctx.isCurrent()) load(true);
  });

  const observer = new MutationObserver(() => {
    if (!document.body.contains(root)) {
      offMsg?.();
      offUpdate?.();
      observer.disconnect();
    }
  });
  observer.observe(document.getElementById('app'), { childList: true, subtree: true });

  await load();
}
