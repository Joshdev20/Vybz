/**
 * Responsive regression test.
 *
 * Loads every route at several viewport widths in a real browser and fails if:
 *   - any element's box sticks out past the viewport, or
 *   - any content is clipped by an ancestor's `overflow: hidden`.
 *
 * This guards the class of bug where a fixed width, or a grid/flex child that
 * defaults to `min-width: auto`, silently widens the page on a small screen.
 *
 * It also asserts each route actually rendered its own content, so a redirect
 * to the login page cannot pass as a clean layout.
 *
 *   npm run test:responsive        (server must be running)
 *   ROUTES=/profile node tests/responsive-audit.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { rmSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:12000';
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const PORT = Number(process.env.CDP_PORT || 9250);

const WIDTHS = (process.env.WIDTHS || '320,360,390,414,768,1024,1440').split(',').map(Number);

/** Route plus a phrase that must appear for the page to count as rendered. */
const ROUTES = (
  process.env.ROUTES ||
  [
    '/play|Play',
    '/discover|Discover',
    '/inbox|Inbox',
    '/connections|Connection',
    '/profile|Profile',
    '/signals|Secret Signal',
    '/rooms|Spill It',
    '/blind-vibe|Blind Vibe',
    // /login is deliberately excluded: an authenticated session redirects it to
    // /play, so it cannot be asserted from within this logged-in sweep.
  ].join(',')
)
  .split(',')
  .map((entry) => {
    const [path, expect] = entry.split('|');
    return { path: path.trim(), expect: (expect || '').trim() };
  })
  .filter((r) => r.path);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Register a throwaway account and return its session cookie. */
async function session() {
  if (process.env.COOKIE) return process.env.COOKIE;
  const username = `resp_${Date.now().toString(36).slice(-6)}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, email: `${username}@vybz.test`, password: 'VybzTest123!', ageConfirmed: true }),
  });
  const cookie = (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('vybz_session='));
  if (!cookie) throw new Error('could not register a session for the responsive test');
  // Leave onboarding so authenticated routes render their real content.
  await fetch(`${BASE}/api/profile/onboarding`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ complete: true }),
  });
  return cookie;
}

async function launch() {
  rmSync('/tmp/vybz-audit-profile', { recursive: true, force: true });
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${PORT}`,
      '--user-data-dir=/tmp/vybz-audit-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  await wait(2600);
  return proc;
}

async function attach(url, cookie) {
  const created = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: `/json/new?${encodeURIComponent(url)}`, method: 'PUT' },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body)));
      },
    );
    req.on('error', reject);
    req.end();
  });

  const { default: WebSocket } = await import('../node_modules/ws/index.js');
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await new Promise((r) => ws.on('open', r));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');

  // Inject the session before any page load so the SPA boots authenticated.
  if (cookie) {
    const [name, value] = cookie.split('=');
    await send('Network.setCookie', {
      name,
      value,
      domain: new URL(BASE).hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    });
  }

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return res.result?.result?.value;
  };
  return { send, evaluate };
}

/** Finds elements that overflow the viewport or get clipped by an ancestor. */
const PROBE = `(() => {
  // Neutralise clipping so genuine overflow becomes measurable.
  document.documentElement.style.overflowX = 'visible';
  document.body.style.overflowX = 'visible';
  // Compare against the visual viewport so a scrollbar gutter is not counted.
  const vw = Math.max(document.documentElement.clientWidth, window.innerWidth);
  const label = (el) =>
    el.tagName.toLowerCase() +
    (el.className && typeof el.className === 'string'
      ? '.' + el.className.split(/\\s+/).slice(0, 2).join('.')
      : '');
  const text = (el) => (el.textContent || '').trim().slice(0, 32);

  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const overRight = r.right - vw;
    const overLeft = -r.left;
    if (overRight > 1 || overLeft > 1) {
      offenders.push({ el: label(el), overRight: Math.round(overRight), overLeft: Math.round(overLeft), text: text(el) });
    }
  }

  // Content that does not fit its own box. A label wider than its tile is the
  // classic "text spills out left and right" symptom, and it never widens the
  // page, so the viewport check above cannot see it.
  const overflowing = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    // Horizontal scrollers are intentional; ignore them.
    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
    if (!el.clientWidth || el.scrollWidth <= el.clientWidth + 1) continue;
    // Visually-hidden helpers (.sr-only) are deliberately 1px boxes holding a
    // wider label, so they are not overflow.
    if (el.clientWidth <= 1 || el.clientHeight <= 1) continue;
    if (cs.clipPath && cs.clipPath !== 'none') continue;
    if (!el.textContent.trim()) continue;
    overflowing.push({
      el: label(el),
      contentW: el.scrollWidth,
      boxW: el.clientWidth,
      text: text(el),
    });
  }

  return {
    vw,
    overflow: Math.max(0, document.documentElement.scrollWidth - vw),
    offenders: offenders.slice(0, 5),
    offenderCount: offenders.length,
    overflowing: overflowing.slice(0, 5),
    overflowingCount: overflowing.length,
    body: (document.querySelector('#app')?.innerText || '').replace(/\\s+/g, ' ').trim(),
    errors: window.__vybzErrors || [],
  };
})()`;

async function main() {
  console.log(`\n=== VYBZ responsive test (${BASE}) ===\n`);
  const cookie = await session();
  const chrome = await launch();
  const t = await attach(BASE, cookie);

  const problems = [];
  let checks = 0;

  try {
    for (const route of ROUTES) {
      for (const width of WIDTHS) {
        await t.send('Emulation.setDeviceMetricsOverride', {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: width < 700,
        });
        // A real navigation per route and width, so the SPA boots fresh and the
        // session cookie is applied before the first render.
        await t.send('Page.navigate', { url: `${BASE}${route.path}` });
        await wait(1500);
        const r = await t.evaluate(PROBE);
        checks++;

        const reasons = [];
        if (r.overflow > 1) reasons.push(`page overflows by ${r.overflow}px`);
        if (r.overflowingCount > 0) reasons.push(`${r.overflowingCount} element(s) with content wider than their box`);
        if (route.expect && !r.body.includes(route.expect)) {
          reasons.push(`missing expected text "${route.expect}"`);
        }
        if (r.errors.length) reasons.push(`console error: ${r.errors[0]}`);

        if (reasons.length) {
          problems.push({ route: route.path, width, reasons, ...r });
          console.log(`  FAIL  ${route.path} @${width}px`);
          for (const reason of reasons) console.log(`          ${reason}`);
          for (const o of r.offenders) {
            console.log(`          OUT  <${o.el}> overR=${o.overRight} overL=${o.overLeft} "${o.text}"`);
          }
          for (const c of r.overflowing) {
            console.log(`          WIDE <${c.el}> content=${c.contentW} box=${c.boxW} "${c.text}"`);
          }
        } else {
          console.log(`  PASS  ${route.path} @${width}px`);
        }
      }
    }
  } finally {
    chrome.kill();
  }

  console.log(`\n=== RESPONSIVE: ${checks - problems.length} passed, ${problems.length} failed ===`);
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => {
  console.error('responsive test crashed:', e);
  process.exit(2);
});
