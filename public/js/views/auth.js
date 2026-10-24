import { h, mount, clear, icon } from '../dom.js';
import { api, ApiError } from '../api.js';
import { setState, store, toast } from '../state.js';
import { brand, banner } from '../components.js';
import { connect } from '../realtime.js';

function authShell(...content) {
  return h(
    'main',
    { class: 'shell__main', id: 'main', style: { display: 'grid', placeItems: 'center', minHeight: '100vh' } },
    h('div', { class: 'wrap', style: { maxWidth: '440px' } }, h('div', { class: 'stack stack--lg' }, ...content)),
  );
}

function field({ label, id, type = 'text', value = '', hint, autocomplete, placeholder, required = true }) {
  return h(
    'div',
    { class: 'field' },
    h('label', { class: 'field__label', for: id }, label),
    h('input', {
      class: 'input',
      id,
      name: id,
      type,
      value,
      placeholder: placeholder || '',
      autocomplete: autocomplete || 'off',
      required,
      'aria-describedby': hint ? `${id}-hint` : null,
    }),
    hint ? h('div', { class: 'field__hint', id: `${id}-hint` }, hint) : null,
    h('div', { class: 'field__error', id: `${id}-error`, hidden: true }),
  );
}

function setFieldError(form, id, message) {
  const err = form.querySelector(`#${id}-error`);
  const input = form.querySelector(`#${id}`);
  if (err) {
    err.textContent = message || '';
    err.hidden = !message;
  }
  if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

async function submitAuth(app, { path, payload, form, submitBtn }) {
  submitBtn.disabled = true;
  submitBtn.textContent = 'Please wait…';
  try {
    const res = await api.post(path, payload);
    setState({ user: res.user });
    const me = await api.get('/api/auth/me');
    setState({ user: me.user, profile: me.profile, preferences: me.preferences, statistics: me.statistics });
    connect();
    const { boot } = await import('../app.js');
    await boot();
  } catch (err) {
    const box = form.querySelector('.auth-error');
    if (err instanceof ApiError) {
      if (/username/i.test(err.message) && /taken|exist/i.test(err.message)) setFieldError(form, 'username', err.message);
      else if (/email/i.test(err.message)) setFieldError(form, 'email', err.message);
      else if (/password/i.test(err.message)) setFieldError(form, 'password', err.message);
      else if (box) {
        box.hidden = false;
        box.textContent = err.message;
      }
    } else if (box) {
      box.hidden = false;
      box.textContent = err.message;
    }
    submitBtn.disabled = false;
    submitBtn.textContent = submitBtn.dataset.label || 'Continue';
  }
}

export function renderLogin(app) {
  clear(app);
  const form = h('form', { class: 'card stack', novalidate: true });
  const submitBtn = h(
    'button',
    { class: 'btn btn--primary btn--block', type: 'submit', dataset: { label: 'Log in' } },
    'Log in',
  );

  form.appendChild(h('div', { class: 'auth-error banner banner--error', hidden: true, role: 'alert' }));
  form.appendChild(
    field({ label: 'Username or email', id: 'identifier', autocomplete: 'username', placeholder: 'yourname' }),
  );
  form.appendChild(field({ label: 'Password', id: 'password', type: 'password', autocomplete: 'current-password' }));
  form.appendChild(submitBtn);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.querySelectorAll('.field__error').forEach((el) => {
      el.hidden = true;
      el.textContent = '';
    });
    const identifier = form.querySelector('#identifier').value.trim();
    const password = form.querySelector('#password').value;
    let valid = true;
    if (!identifier) {
      setFieldError(form, 'identifier', 'Enter your username or email.');
      valid = false;
    }
    if (!password) {
      setFieldError(form, 'password', 'Enter your password.');
      valid = false;
    }
    if (!valid) return;
    await submitAuth(app, { path: '/api/auth/login', payload: { identifier, password }, form, submitBtn });
  });

  const goRegister = (e) => {
    e.preventDefault();
    history.pushState({}, '', '/register');
    renderRegister(app);
  };

  mount(
    app,
    authShell(
      h('div', { class: 'center' }, brand({ tagline: true })),
      h(
        'div',
        { class: 'card card--glow stack' },
        h(
          'div',
          {},
          h('h1', {}, 'Welcome back'),
          h('p', { class: 'small muted', style: { margin: '6px 0 0' } }, 'Sign in to keep playing.'),
        ),
        form,
      ),
      h('p', { class: 'center small muted' }, 'New to VYBZ? ', h('a', { href: '/register', onclick: goRegister }, 'Create an account')),
      h('p', { class: 'center tiny dim' }, 'VYBZ is for adults 18 and over.'),
    ),
  );
}

export function renderRegister(app) {
  clear(app);
  const form = h('form', { class: 'card card--glow stack', novalidate: true });
  const submitBtn = h(
    'button',
    { class: 'btn btn--primary btn--block', type: 'submit', dataset: { label: 'Create account' } },
    'Create account',
  );

  form.appendChild(h('div', { class: 'auth-error banner banner--error', hidden: true, role: 'alert' }));
  form.appendChild(
    field({
      label: 'Username',
      id: 'username',
      autocomplete: 'username',
      placeholder: 'yourname',
      hint: '3-20 characters. Letters, numbers and underscores.',
    }),
  );
  form.appendChild(field({ label: 'Email', id: 'email', type: 'email', autocomplete: 'email', placeholder: 'you@example.com' }));
  form.appendChild(
    field({ label: 'Password', id: 'password', type: 'password', autocomplete: 'new-password', hint: 'At least 8 characters.' }),
  );

  const age = h('label', { class: 'checkbox' });
  age.appendChild(h('input', { type: 'checkbox', id: 'ageConfirmed' }));
  age.appendChild(
    h(
      'span',
      { class: 'small' },
      'I confirm I am 18 years or older and I agree to the community rules: no harassment, no threats, no impersonation, and no sharing anyone else\u2019s private information.',
    ),
  );
  const ageError = h('div', { class: 'field__error', hidden: true, role: 'alert' }, 'You must confirm you are 18 or older.');
  form.appendChild(h('div', { class: 'field' }, age, ageError));
  form.appendChild(submitBtn);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    form.querySelectorAll('.field__error').forEach((el) => {
      if (el !== ageError) {
        el.hidden = true;
        el.textContent = '';
      }
    });
    const username = form.querySelector('#username').value.trim();
    const email = form.querySelector('#email').value.trim();
    const password = form.querySelector('#password').value;
    const ageConfirmed = form.querySelector('#ageConfirmed').checked;
    let valid = true;
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      setFieldError(form, 'username', 'Use 3-20 letters, numbers or underscores.');
      valid = false;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFieldError(form, 'email', 'Enter a valid email address.');
      valid = false;
    }
    if (password.length < 8) {
      setFieldError(form, 'password', 'Use at least 8 characters.');
      valid = false;
    }
    ageError.hidden = ageConfirmed;
    if (!ageConfirmed) valid = false;
    if (!valid) return;
    await submitAuth(app, {
      path: '/api/auth/register',
      payload: { username, email, password, ageConfirmed },
      form,
      submitBtn,
    });
  });

  const goLogin = (e) => {
    e.preventDefault();
    history.pushState({}, '', '/');
    renderLogin(app);
  };

  mount(
    app,
    authShell(
      h('div', { class: 'center' }, brand({ tagline: true })),
      h(
        'div',
        { class: 'card card--glow stack' },
        h(
          'div',
          {},
          h('h1', {}, 'Create your account'),
          h('p', { class: 'small muted', style: { margin: '6px 0 0' } }, 'Play games, meet people, build real chemistry.'),
        ),
        form,
      ),
      h('p', { class: 'center small muted' }, 'Already have an account? ', h('a', { href: '/', onclick: goLogin }, 'Log in')),
    ),
  );
}
