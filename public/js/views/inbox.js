import { h, mount, clear, icon, avatarEl, timeAgo, plural } from '../dom.js';
import { api } from '../api.js';
import { store, setState, toast, showModal, confirmDialog } from '../state.js';
import { on as onRealtime, send as wsSend } from '../realtime.js';
import { pageHead, pill, stateBlock, errorBlock, loadingBlock, banner, sectionHead } from '../components.js';

export async function render(root, ctx) {
  const conversationId = ctx.params?.conversationId ? Number(ctx.params.conversationId) : null;
  if (conversationId) return renderChat(root, ctx, conversationId);
  return renderList(root, ctx);
}

/* --------------------------------- list --------------------------------- */

async function renderList(root, ctx) {
  mount(root, loadingBlock('Loading your conversations…'));
  let data;
  try {
    data = await api.get('/api/inbox');
  } catch (err) {
    mount(root, errorBlock(err.message, () => ctx.navigate('/inbox')));
    return;
  }
  if (!ctx.isCurrent()) return;
  setState({ counters: { ...store.counters, unreadMessages: data.unread } });

  const container = h('div', { class: 'stack stack--lg' });
  container.appendChild(
    pageHead({
      eyebrow: 'Inbox',
      title: 'Conversations',
      subtitle: 'Only people you have connected with can message you. Blocked accounts cannot start a new conversation.',
    }),
  );

  if (!data.conversations.length) {
    container.appendChild(
      stateBlock({
        iconName: 'chat',
        title: 'No conversations yet',
        body: 'Play a match and connect afterwards, accept a connection request, or send a Secret Signal. Conversations you are allowed to have will appear here.',
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
        { class: 'stack stack--sm' },
        ...data.conversations.map((c) =>
          h(
            'button',
            { class: `list-item ${c.unread > 0 ? 'list-item--unread' : ''}`, type: 'button', onclick: () => ctx.navigate(`/inbox/${c.id}`) },
            avatarEl(c.other, 'md'),
            h(
              'div',
              { class: 'grow', style: { textAlign: 'left', minWidth: '0' } },
              h(
                'div',
                { class: 'row', style: { gap: '7px' } },
                h('span', { class: 'strong truncate' }, c.other.displayName || c.other.username),
                c.muted ? pill('Muted') : null,
                c.other.presence === 'online' ? pill('Online', 'green') : null,
              ),
              h('div', { class: 'small dim truncate' }, c.lastMessage?.body || 'No messages yet'),
            ),
            h(
              'div',
              { class: 'stack stack--sm', style: { alignItems: 'flex-end' } },
              h('span', { class: 'tiny dim' }, timeAgo(c.lastMessage?.at || c.createdAt)),
              c.unread > 0 ? h('span', { class: 'pill pill--pink' }, String(c.unread)) : null,
            ),
          ),
        ),
      ),
    );
  }
  mount(root, container);
}

/* --------------------------------- chat --------------------------------- */

async function renderChat(root, ctx, conversationId) {
  mount(root, loadingBlock('Opening conversation…'));

  let conversation;
  try {
    const list = await api.get('/api/inbox');
    conversation = list.conversations.find((c) => c.id === conversationId);
    if (!conversation) {
      // The conversation may exist but be empty and not yet in the list summary.
      const messages = await api.get(`/api/inbox/${conversationId}`);
      if (!messages.conversation) throw new Error('not found');
      conversation = messages.conversation;
    }
  } catch (err) {
    mount(
      root,
      err.status === 403
        ? stateBlock({ iconName: 'lock', title: 'You cannot open this conversation', body: 'You are not a participant, or the conversation is blocked.' })
        : stateBlock({ iconName: 'chat', title: 'Conversation unavailable', body: err.message, actions: [h('button', { class: 'btn btn--primary', onclick: () => ctx.navigate('/inbox') }, 'Back to inbox')] }),
    );
    return;
  }
  if (!ctx.isCurrent()) return;

  let messages = [];
  const other = conversation.other;

  const container = h('div', { class: 'wrap' });
  const head = h('div', { class: 'chat__head' });
  const body = h('div', { class: 'chat__body', 'aria-live': 'polite' });
  const composer = h('div', { class: 'chat__composer' });
  const chat = h('div', { class: 'chat' }, head, body, composer);
  container.appendChild(chat);

  /* ------------------------------- header ------------------------------- */
  function paintHead() {
    clear(head);
    head.appendChild(
      h('button', { class: 'btn btn--ghost btn--icon', 'aria-label': 'Back to inbox', onclick: () => ctx.navigate('/inbox') }, icon('back', 18)),
    );
    head.appendChild(avatarEl({ ...other, presence: other.presence }, 'sm'));
    head.appendChild(
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'strong truncate' }, other.displayName || other.username),
        h('div', { class: 'tiny dim' }, other.presence === 'online' ? 'Online now' : 'Offline'),
      ),
    );
    head.appendChild(
      h('button', { class: 'btn btn--ghost btn--icon', 'aria-label': 'Conversation options', onclick: openOptions }, icon('settings', 18)),
    );
  }

  /* ------------------------------- messages ------------------------------- */
  function paintMessages(scrollToBottom = false) {
    if (!messages.length) {
      mount(body, stateBlock({ iconName: 'chat', title: 'Say hello', body: 'You are connected. Start with a game challenge or a simple hello.' }));
      return;
    }
    mount(body, ...messages.map(messageEl));
    if (scrollToBottom) body.scrollTop = body.scrollHeight;
  }

  function messageEl(m) {
    const wrap = h(
      'div',
      { class: `msg ${m.mine ? 'msg--mine' : 'msg--them'}`, dataset: { id: m.id } },
      h('div', {}, m.body),
      h('div', { class: 'msg__meta' }, timeAgo(m.at)),
    );
    wrap.addEventListener('contextmenu', (e) => {
      if (m.mine) return;
      e.preventDefault();
      reportMessage(m);
    });
    if (!m.mine) {
      wrap.style.cursor = 'pointer';
      wrap.title = 'Long-press or right-click to report';
      let timer = null;
      wrap.addEventListener('touchstart', () => {
        timer = setTimeout(() => reportMessage(m), 550);
      });
      wrap.addEventListener('touchend', () => clearTimeout(timer));
    }
    return wrap;
  }

  /* ------------------------------- composer ------------------------------- */
  const textarea = h('textarea', {
    class: 'textarea',
    rows: '1',
    maxlength: '2000',
    placeholder: 'Write a message…',
    'aria-label': 'Message',
  });
  const sendBtn = h('button', { class: 'btn btn--primary btn--icon', 'aria-label': 'Send message' }, icon('send', 18));
  composer.appendChild(textarea);
  composer.appendChild(sendBtn);

  let typingTimer = null;
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(130, textarea.scrollHeight)}px`;
    if (typingTimer) return;
    typingTimer = setTimeout(() => {
      typingTimer = null;
      wsSend('typing', { conversationId });
    }, 900);
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });
  sendBtn.onclick = doSend;

  async function doSend() {
    const bodyText = textarea.value.trim();
    if (!bodyText) return;
    sendBtn.disabled = true;
    // Optimistic render is deliberately avoided: the message appears once the
    // server confirms it, so the UI never claims a message was delivered when
    // it was not.
    try {
      const res = await api.post(`/api/inbox/${conversationId}/messages`, { body: bodyText });
      textarea.value = '';
      textarea.style.height = 'auto';
      if (res.message) {
        messages.push(res.message);
        paintMessages(true);
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      sendBtn.disabled = false;
    }
  }

  /* ------------------------------- options ------------------------------- */
  async function openOptions() {
    const muted = Boolean(conversation.muted);
    const muteInput = h('input', { type: 'checkbox', checked: muted, 'aria-label': 'Mute conversation' });
    showModal({
      title: other.displayName || other.username,
      body: h(
        'div',
        { class: 'stack' },
        h('div', { class: 'switch' }, h('div', { class: 'switch__text' }, h('div', { class: 'switch__title' }, 'Mute notifications'), h('div', { class: 'switch__desc' }, 'Stop notifications for new messages here.')), muteInput),
        h('button', { class: 'btn btn--ghost btn--block', onclick: () => { closeModal(); ctx.navigate(`/profile/${other.userId}`); } }, 'View profile'),
        h('button', { class: 'btn btn--danger btn--block', onclick: blockOther }, icon('block', 16), 'Block'),
        h('button', { class: 'btn btn--danger btn--block', onclick: reportOther }, icon('flag', 16), 'Report'),
      ),
      actions: [
        {
          label: 'Save',
          variant: 'primary',
          onClick: async () => {
            try {
              await api.post(`/api/inbox/${conversationId}/mute`, { muted: muteInput.checked });
              conversation.muted = muteInput.checked;
              toast('Preferences saved.', 'success');
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
      ],
    });
  }

  async function blockOther() {
    closeModal();
    if (!(await confirmDialog({ title: `Block ${other.displayName || other.username}?`, message: 'They will not be able to message you, see you in Discover, or be matched with you. This conversation will be hidden.', confirmLabel: 'Block', danger: true }))) return;
    try {
      await api.post('/api/safety/blocks', { userId: other.userId });
      toast('Blocked.', 'success');
      ctx.navigate('/inbox');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function reportOther() {
    closeModal();
    reportFlow(other.userId, `Conversation with ${other.displayName || other.username}`);
  }

  function reportMessage(m) {
    reportFlow(other.userId, 'Reported message', { messageId: m.id });
  }

  function reportFlow(subjectUserId, context, { messageId } = {}) {
    const reasons = [
      ['harassment', 'Harassment or abuse'],
      ['spam', 'Spam or advertising'],
      ['sexual_content', 'Unwanted sexual content'],
      ['threats', 'Threats or stalking'],
      ['impersonation', 'Impersonation'],
      ['underage', 'Suspected underage account'],
      ['other', 'Something else'],
    ];
    let reason = 'harassment';
    const details = h('textarea', { class: 'textarea', maxlength: '500', placeholder: 'What happened?' });
    showModal({
      title: 'Report',
      body: h(
        'div',
        { class: 'stack stack--sm' },
        h('p', { class: 'small muted' }, `${context}. Reports are confidential.`),
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
              if (messageId) {
                await api.post(`/api/inbox/${conversationId}/messages/${messageId}/report`, { reason, details: details.value.trim() });
              } else {
                await api.post('/api/safety/reports', { subjectUserId, targetType: 'user', reason, details: details.value.trim() });
              }
              toast('Report submitted. Thank you.', 'success');
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
      ],
    });
  }

  /* ------------------------------- loading ------------------------------- */
  try {
    const res = await api.get(`/api/inbox/${conversationId}`);
    messages = res.messages || [];
    await api.post(`/api/inbox/${conversationId}/read`, {});
    setState({ counters: { ...store.counters, unreadMessages: Math.max(0, store.counters.unreadMessages - messages.filter((m) => !m.mine).length) } });
  } catch (err) {
    if (err.status === 403) {
      mount(root, stateBlock({ iconName: 'lock', title: 'You cannot open this conversation', body: 'You are not a participant, or the conversation is blocked.' }));
      return;
    }
  }

  paintHead();
  paintMessages(true);
  mount(root, container);
  textarea.focus();

  /* ------------------------------ realtime ------------------------------ */
  const offNew = onRealtime('message', (payload) => {
    if (payload?.conversationId !== conversationId || !ctx.isCurrent()) return;
    const m = payload.message;
    if (!m || messages.some((x) => x.id === m.id)) return;
    messages.push(m);
    paintMessages(true);
    if (!m.mine) api.post(`/api/inbox/${conversationId}/read`, {}).catch(() => {});
  });

  const offTyping = onRealtime('typing', (payload) => {
    if (payload?.conversationId !== conversationId || !ctx.isCurrent()) return;
    showTyping();
  });

  let typingEl = null;
  let typingHideTimer = null;
  function showTyping() {
    if (!typingEl) {
      typingEl = h('div', { class: 'msg msg--them', style: { padding: '12px 16px' } }, h('div', { class: 'typing-dots' }, h('span'), h('span'), h('span')));
      body.appendChild(typingEl);
      body.scrollTop = body.scrollHeight;
    }
    clearTimeout(typingHideTimer);
    typingHideTimer = setTimeout(() => {
      typingEl?.remove();
      typingEl = null;
    }, 3000);
  }

  const observer = new MutationObserver(() => {
    if (!document.body.contains(root)) {
      offNew?.();
      offTyping?.();
      observer.disconnect();
    }
  });
  observer.observe(document.getElementById('app'), { childList: true, subtree: true });
}
