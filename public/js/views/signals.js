import { h, mount, clear, icon, timeAgo } from '../dom.js';
import { api } from '../api.js';
import { store, toast, showModal, confirmDialog } from '../state.js';
import { pageHead, pill, stateBlock, errorBlock, loadingBlock, banner, sectionHead } from '../components.js';

export async function render(root, ctx) {
  mount(root, loadingBlock('Loading your signals…'));

  let data;
  const load = async (silent = false) => {
    if (!silent) mount(root, loadingBlock('Loading signals…'));
    try {
      data = await api.get('/api/signals');
      if (ctx.isCurrent()) paint();
    } catch (err) {
      if (ctx.isCurrent()) mount(root, errorBlock(err.message, () => load()));
    }
  };

  function paint() {
    const container = h('div', { class: 'stack stack--lg' });
    container.appendChild(
      pageHead({
        eyebrow: 'Secret Signals',
        title: 'Anonymous compliments',
        subtitle: 'Signals are only delivered to people who opted in. Senders stay anonymous until you both choose to connect.',
        actions: [h('button', { class: 'btn btn--primary btn--sm', onclick: () => openSendFlow() }, icon('send', 16), 'Send a signal')],
      }),
    );

    container.appendChild(
      h(
        'div',
        { class: 'banner banner--info' },
        icon('lock', 18),
        h('div', { class: 'grow' }, 'We never reveal who sent a signal unless you both say yes. Nothing here is simulated — every signal came from a real player.'),
      ),
    );

    // Quota
    if (data.quota) {
      container.appendChild(
        h(
          'div',
          { class: 'row row--wrap' },
          pill(`${data.quota.remaining} of ${data.quota.limit} signals left today`, data.quota.remaining > 0 ? 'violet' : 'amber'),
        ),
      );
    }

    /* ------------------------------- received ------------------------------- */
    const received = data.received || [];
    container.appendChild(
      h(
        'div',
        {},
        sectionHead(`Received (${received.length})`),
        received.length
          ? h(
              'div',
              { class: 'stack stack--sm' },
              ...received.map((s) => signalCard(s, load)),
            )
          : stateBlock({
              iconName: 'mask',
              title: 'No signals yet',
              body: 'When someone sends you an anonymous compliment it will appear here. Make sure signals are enabled in your privacy settings.',
              actions: [h('button', { class: 'btn btn--ghost', onclick: () => ctx.navigate('/profile') }, 'Privacy settings')],
            }),
      ),
    );

    /* --------------------------------- sent --------------------------------- */
    const sent = data.sent || [];
    if (sent.length) {
      container.appendChild(
        h(
          'div',
          {},
          sectionHead(`Sent (${sent.length})`),
          h(
            'div',
            { class: 'stack stack--sm' },
            ...sent.map((s) =>
              h(
                'div',
                { class: 'list-item list-item--static' },
                h('div', { class: 'game-tile__icon' }, icon('send', 18)),
                h('div', { class: 'grow', style: { textAlign: 'left' } },
                  h('div', { class: 'small strong' }, kindLabel(s.kind)),
                  h('div', { class: 'tiny dim' }, `Sent ${timeAgo(s.createdAt)}`),
                ),
                pill(sentStatus(s.status), sentStatusVariant(s.status)),
              ),
            ),
          ),
          h('p', { class: 'tiny dim' }, 'For privacy we never show whether a recipient dismissed your signal.'),
        ),
      );
    }

    mount(root, container);
  }

  function signalCard(s, reload) {
    return h(
      'div',
      { class: 'card card--pink stack stack--sm' },
      h(
        'div',
        { class: 'row row--between' },
        h('div', { class: 'row' }, icon('mask', 18), h('span', { class: 'strong small' }, kindLabel(s.kind))),
        h('span', { class: 'tiny dim' }, timeAgo(s.createdAt)),
      ),
      h('p', { style: { margin: '0', color: 'var(--text)' } }, `"${s.body}"`),
      h('div', { class: 'tiny dim' }, 'From an anonymous player'),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn btn--pink btn--sm grow', onclick: () => react(s, 'mutual', reload) }, icon('heart', 15), 'Interested too'),
        h('button', { class: 'btn btn--ghost btn--sm', onclick: () => react(s, 'dismiss', reload) }, 'Dismiss'),
        h('button', { class: 'btn btn--ghost btn--sm', onclick: () => react(s, 'block', reload) }, 'Block'),
        h('button', { class: 'btn btn--ghost btn--sm', onclick: () => react(s, 'report', reload) }, 'Report'),
      ),
      h('p', { class: 'tiny dim', style: { marginBottom: '0' } }, 'Choosing "Interested too" only connects you if they also said yes. If not, nobody is told.'),
    );
  }

  async function react(s, action, reload) {
    if (action === 'block') {
      if (!(await confirmDialog({ title: 'Block this sender?', message: 'They will not be able to send you signals again, and you will not be matched together.', confirmLabel: 'Block', danger: true }))) return;
    }
    if (action === 'report') {
      if (!(await confirmDialog({ title: 'Report this signal?', message: 'Our moderation team will review it. The sender stays anonymous to you.', confirmLabel: 'Report', danger: true }))) return;
    }
    try {
      const res = await api.post(`/api/signals/${s.id}/react`, { action });
      if (action === 'mutual') {
        if (res.connected) toast('You matched! A connection has been created.', 'success');
        else toast('Your interest is saved privately. If they feel the same, you will connect.', 'info');
      } else if (action === 'dismiss') {
        toast('Signal dismissed.', 'info');
      } else if (action === 'block') {
        toast('Blocked.', 'success');
      } else {
        toast('Report submitted. Thank you.', 'success');
      }
      await reload(true);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ------------------------------ send flow ------------------------------ */
  async function openSendFlow() {
    let templates;
    let targets;
    try {
      [templates, targets] = await Promise.all([api.get('/api/signals/templates'), api.get('/api/signals/targets')]);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    if (!targets.targets.length) {
      showModal({
        title: 'Send a signal',
        body: h('div', { class: 'stack' }, banner('There is nobody eligible to receive a signal right now. People must opt in and be discoverable.', 'warn')),
        actions: [{ label: 'Close', variant: 'ghost' }],
      });
      return;
    }

    let recipientId = targets.targets[0].userId;
    let templateKey = templates.templates[0]?.key || null;
    let customBody = '';

    const body = h('div', { class: 'stack' });

    // Recipient picker
    const recipientList = h('div', { class: 'stack stack--sm' });
    const paintRecipients = () => {
      mount(
        recipientList,
        ...targets.targets.map((t) => {
          const btn = h(
            'button',
            { class: 'list-item', type: 'button', 'aria-pressed': String(t.userId === recipientId) },
            h('div', { class: 'grow', style: { textAlign: 'left' } },
              h('div', { class: 'strong small' }, t.displayName || t.username),
              h('div', { class: 'tiny dim' }, t.sharedInterests?.length ? `Shares ${t.sharedInterests.map((i) => i.label).join(', ')}` : 'Discoverable player'),
            ),
            t.userId === recipientId ? pill('Selected', 'violet') : null,
          );
          btn.onclick = () => {
            recipientId = t.userId;
            paintRecipients();
          };
          return btn;
        }),
      );
    };
    paintRecipients();
    body.appendChild(h('div', { class: 'eyebrow', style: { marginBottom: '0' } }, 'Send to'));
    body.appendChild(recipientList);

    // Template picker
    const templateHost = h('div', { class: 'row row--wrap', style: { gap: '7px' } });
    const customField = h('div', { class: 'field hide' },
      h('label', { class: 'field__label', for: 'custom' }, 'Your compliment'),
      h('textarea', { class: 'textarea', id: 'custom', maxlength: '240', placeholder: 'Keep it kind, specific and free of contact details…' }),
      h('div', { class: 'field__hint' }, 'Written compliments are screened for contact details and abusive language, and are rate limited.'),
    );
    const paintTemplates = () => {
      mount(
        templateHost,
        ...templates.templates.map((t) => {
          const btn = h('button', { class: 'pill pill--selectable', type: 'button', 'aria-pressed': String(t.key === templateKey) }, t.body);
          btn.onclick = () => {
            templateKey = t.key;
            customField.classList.add('hide');
            paintTemplates();
          };
          return btn;
        }),
        (() => {
          const btn = h('button', { class: 'pill pill--selectable', type: 'button', 'aria-pressed': String(templateKey === 'custom') }, 'Write my own');
          btn.onclick = () => {
            templateKey = 'custom';
            customField.classList.remove('hide');
            paintTemplates();
          };
          return btn;
        })(),
      );
    };
    paintTemplates();
    body.appendChild(h('div', { class: 'eyebrow', style: { marginBottom: '0', marginTop: '8px' } }, 'Message'));
    body.appendChild(templateHost);
    body.appendChild(customField);

    const status = h('div', {});
    body.appendChild(status);

    showModal({
      title: 'Send a signal',
      body,
      actions: [
        {
          label: 'Send signal',
          variant: 'pink',
          onClick: async () => {
            const payload = { recipientId };
            if (templateKey === 'custom') {
              const text = document.getElementById('custom')?.value?.trim();
              if (!text || text.length < 4) {
                mount(status, banner('Write a slightly longer compliment.', 'error'));
                return false;
              }
              payload.body = text;
            } else {
              payload.templateKey = templateKey;
            }
            try {
              await api.post('/api/signals', payload);
              toast('Signal sent. They will never see it was you unless you both connect.', 'success');
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

  await load();
}

function kindLabel(kind) {
  return {
    compliment: 'Anonymous compliment',
    interest: 'Anonymous interest',
    flirty: 'Playful signal',
    friendly: 'Friendly signal',
  }[kind] || 'Anonymous signal';
}

function sentStatus(status) {
  return {
    delivered: 'Delivered',
    reacted: 'Seen',
    mutual: 'Matched',
    dismissed: 'Closed',
    blocked: 'Closed',
    reported: 'Under review',
  }[status] || status;
}

function sentStatusVariant(status) {
  return { mutual: 'green', delivered: 'violet', reported: 'red' }[status] || '';
}
