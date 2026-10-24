/**
 * Responsive regression test.
 *
 * Loads every route at several viewport widths in a real browser and fails if:
 *   - any element's box sticks out past the viewport,
 *   - any content is wider than its own box, or
 *   - any text field is under 16px, which makes iOS Safari zoom the page on
 *     focus and makes the layout look like it overflows.
 *
 * Two isolated browsers are used: one with no session, to check the screens a
 * logged-out visitor sees, and one with a session for the app itself. Sharing a
 * browser between the two would leak cookies and silently skip the public pages.
 *
 * It also asserts each route rendered its own content, so a redirect to the
 * login page cannot pass as a clean layout.
 *
 *   npm run test:responsive        (server must be running)
 *   ROUTES=/profile node tests/responsive-audit.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFileSync, rmSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:12000';
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const WIDTHS = (process.env.WIDTHS || '320,360,390,414,768,1024,1440').split(',').map(Number);

/** Public routes, loaded with no session. These only render when logged out. */
const PUBLIC_ROUTES = parseRoutes(
  process.env.PUBLIC_ROUTES || '/login|Log in,/register|Create your account,/onboarding|',
);

/** Routes requiring a session, plus a phrase that must appear once rendered. */
const ROUTES = parseRoutes(
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
    ].join(','),
);

function parseRoutes(value) {
  return value
    .split(',')
    .map((entry) => {
      const [path, expect] = entry.split('|');
      return { path: (path || '').trim(), expect: (expect || '').trim() };
    })
    .filter((r) => r.path);
}

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

/**
 * Starts Chromium with an isolated profile and returns its debugger endpoint.
 *
 * The port is allocated by Chromium (`--remote-debugging-port=0`) and read back
 * from the profile directory, so concurrent runs cannot collide on a fixed port
 * and accidentally attach to a browser from an earlier run.
 */
async function launch(tag) {
  const dir = `/tmp/vybz-audit-${tag}-${process.pid}`;
  rmSync(dir, { recursive: true, force: true });
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  );
  // Detached so the whole process group can be killed, leaving no stale browser
  // holding a port for the next run.
  const kill = () => {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      proc.kill('SIGKILL');
    }
  };

  let port;
  for (let i = 0; i < 60 && !port; i++) {
    await wait(250);
    try {
      port = Number(readFileSync(`${dir}/DevToolsActivePort`, 'utf8').split('\n')[0]);
    } catch {
      /* not ready yet */
    }
  }
  if (!port) {
    kill();
    throw new Error('Chromium did not expose a debugging port');
  }
  return { port, kill };
}

async function attach(port, cookie) {
  const created = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: `/json/new?${encodeURIComponent(BASE)}`, method: 'PUT' },
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

/** Collects overflow and iOS-zoom problems on the current page. */
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
    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
    if (!el.clientWidth || el.scrollWidth <= el.clientWidth + 1) continue;
    // Visually-hidden helpers are deliberately 1px boxes holding a wider label.
    if (el.clientWidth <= 1 || el.clientHeight <= 1) continue;
    if (cs.clipPath && cs.clipPath !== 'none') continue;
    if (!el.textContent.trim()) continue;
    overflowing.push({ el: label(el), contentW: el.scrollWidth, boxW: el.clientWidth, text: text(el) });
  }

  return {
    vw,
    overflow: Math.max(0, document.documentElement.scrollWidth - vw),
    offenders: offenders.slice(0, 5),
    offenderCount: offenders.length,
    overflowing: overflowing.slice(0, 5),
    overflowingCount: overflowing.length,
    // iOS Safari zooms the page when a focused field's text is under 16px,
    // which reads as the layout overflowing. Flag any such control.
    smallControls: [...document.querySelectorAll('input, textarea, select')]
      .filter((el) => {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        return !['checkbox', 'radio', 'file', 'submit', 'button', 'range', 'hidden'].includes(type);
      })
      .map((el) => ({ cls: String(el.className || '').slice(0, 24), font: parseFloat(getComputedStyle(el).fontSize) }))
      .filter((c) => c.font < 16),
    body: (document.querySelector('#app')?.innerText || '').replace(/\\s+/g, ' ').trim(),
    errors: window.__vybzErrors || [],
  };
})()`;

async function main() {
  console.log(`\n=== VYBZ responsive test (${BASE}) ===\n`);
  const cookie = await session();
  const problems = [];
  let checks = 0;

  /** Loads each route at every width and records any layout problem. */
  const sweep = async (t, routes) => {
    for (const route of routes) {
      for (const width of WIDTHS) {
        await t.send('Emulation.setDeviceMetricsOverride', {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: width < 700,
        });
        // A real navigation per route and width, so the SPA boots fresh.
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
        if (r.smallControls.length) {
          const worst = r.smallControls[0];
          reasons.push(`${r.smallControls.length} input(s) under 16px (iOS zoom): ${worst.cls}=${worst.font}px`);
        }
        if (r.errors.length) reasons.push(`console error: ${r.errors[0]}`);

        if (reasons.length) {
          problems.push({ route: route.path, width, reasons });
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
  };

  // Pass 1: public screens in a browser with no session.
  const anon = await launch('anon');
  try {
    await sweep(await attach(anon.port, null), PUBLIC_ROUTES);
  } finally {
    anon.kill();
  }

  // Pass 2: the app itself, authenticated, in a separate browser.
  const auth = await launch('auth');
  try {
    await sweep(await attach(auth.port, cookie), ROUTES);
  } finally {
    auth.kill();
  }

  console.log(`\n=== RESPONSIVE: ${checks - problems.length} passed, ${problems.length} failed ===`);
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => {
  console.error('responsive test crashed:', e);
  process.exit(2);
});
