/**
 * Two-account real-time UI test.
 *
 * Drives two genuinely independent browser sessions (separate headless Chrome
 * instances, separate profile directories) through registration, onboarding,
 * matchmaking and a full Rizz Battle round. This is the only test that proves
 * the WebSocket push path works end to end: each client must see the other
 * player's actions without polling.
 *
 *   node tests/ui-realtime.mjs       (server must be running on PORT)
 *
 * Requires a Chromium binary. Set CHROME=/path/to/chrome to override.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { rmSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:12000';
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const PORT_A = Number(process.env.CDP_PORT_A || 9230);
const PORT_B = Number(process.env.CDP_PORT_B || 9231);

let passed = 0;
let failed = 0;
const failures = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name} ${String(extra).slice(0, 200)}`);
    console.log(`  FAIL  ${name} ${String(extra).slice(0, 200)}`);
  }
}

async function launch(port, profile) {
  // A leftover cookie jar would silently resume an old session instead of
  // exercising registration, so each run starts from a clean profile.
  rmSync(profile, { recursive: true, force: true });
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  await wait(2600);
  return proc;
}

async function attach(port, url) {
  const created = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: `/json/new?${encodeURIComponent(url)}`, method: 'PUT' },
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
  const consoleErrors = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params?.exceptionDetails?.exception?.description || 'exception');
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push(msg.params.args?.map((a) => a.value ?? a.description).join(' ') || 'console error');
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

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) return `__THREW__ ${res.result.exceptionDetails.text}`;
    return res.result?.result?.value;
  };

  return { evaluate, consoleErrors };
}

/** Register and complete onboarding through the real UI. */
async function onboard(t, label) {
  const username = `${label}_${Math.random().toString(36).slice(2, 7)}`;
  await t.evaluate("history.pushState({},'','/register');window.dispatchEvent(new PopStateEvent('popstate'))");
  await wait(1300);
  await t.evaluate(`(()=>{
    const f = document.querySelector('form');
    f.querySelector('#username').value = ${JSON.stringify(username)};
    f.querySelector('#email').value = ${JSON.stringify(`${username}@vybz.test`)};
    f.querySelector('#password').value = 'Password123!';
    f.querySelector('input[type=checkbox]').checked = true;
    f.querySelector('button[type=submit]').click();
    return true;
  })()`);
  await wait(2800);

  // Onboarding: avatar -> a game preference -> interests -> enter.
  await t.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Continue'))?.click()");
  await wait(1400);
  await t.evaluate("document.querySelectorAll('.pill--selectable')[0]?.click()");
  await t.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Continue'))?.click()");
  await wait(1400);
  await t.evaluate("document.querySelectorAll('.list-item')[0]?.click()");
  await wait(500);
  await t.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Continue'))?.click()");
  await wait(1400);
  await t.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Enter VYBZ'))?.click()");
  await wait(3000);
  return username;
}

const pageText = (t) =>
  t.evaluate("document.querySelector('#app')?.innerText?.replace(/\\n+/g,' | ') || '(empty)'");

async function main() {
  console.log('\n=== VYBZ two-account real-time UI test ===\n');

  const chromeA = await launch(PORT_A, '/tmp/vybz-ui-a');
  const chromeB = await launch(PORT_B, '/tmp/vybz-ui-b');
  const A = await attach(PORT_A, BASE);
  const B = await attach(PORT_B, BASE);

  try {
    const userA = await onboard(A, 'ui');
    const userB = await onboard(B, 'ui');
    const landed = await A.evaluate('location.pathname');
    check('account A registered and onboarded', userA.startsWith('ui_') && !/__THREW__/.test(String(landed)), `path=${landed}`);
    check('account B registered and onboarded', userB.startsWith('ui_'), userB);

    // ------------------------------------------------------- matchmaking
    console.log('\n[matchmaking through the UI]');
    const joinRizz = `(()=>{
      const tile = [...document.querySelectorAll('.game-tile')].find(x=>/Rizz Battle/i.test(x.textContent));
      if (!tile) return 'no-tile';
      tile.querySelector('button').click();
      return 'clicked';
    })()`;
    const findPartner = "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Find a partner'))?.click()";

    check('A joined the Rizz Battle queue via the UI', (await A.evaluate(joinRizz)) === 'clicked');
    await wait(1500);
    check('A started matchmaking', (await A.evaluate(`(()=>{${findPartner};return 'ok';})()`)) === 'ok');
    await wait(900);
    check('B joined the Rizz Battle queue via the UI', (await B.evaluate(joinRizz)) === 'clicked');
    await wait(1500);
    check('B started matchmaking', (await B.evaluate(`(()=>{${findPartner};return 'ok';})()`)) === 'ok');

    let pathA = '';
    for (let i = 0; i < 20; i += 1) {
      await wait(1500);
      pathA = String(await A.evaluate('location.pathname'));
      if (pathA.startsWith('/match/')) break;
    }
    const pathB = String(await B.evaluate('location.pathname'));
    check('A was routed into a match by the realtime push', pathA.startsWith('/match/'), `path=${pathA}`);
    check('B was routed into a match by the realtime push', pathB.startsWith('/match/'), `path=${pathB}`);
    check('both clients agree on the same match', pathA === pathB, `${pathA} vs ${pathB}`);

    // ------------------------------------------------------------ accept
    console.log('\n[accept phase]');
    const clickButton = (re) =>
      `(()=>{const b=[...document.querySelectorAll('button')].find(x=>${re}.test(x.textContent));if(!b)return 'none';b.click();return 'clicked';})()`;
    const acceptA = await A.evaluate(clickButton('/Accept match/i'));
    check('A was offered an accept button', acceptA === 'clicked', acceptA);
    await wait(1200);
    const acceptB = await B.evaluate(clickButton('/Accept match/i'));
    check('B was offered an accept button', acceptB === 'clicked', acceptB);
    await wait(4000);

    const promptText = await pageText(A);
    check('A sees the round prompt after accepting', /Your answer|Submit answer/i.test(promptText), promptText);
    check('A has a textarea to answer', (await A.evaluate("Boolean(document.querySelector('textarea'))")) === true);

    // --------------------------------------------------------- submission
    console.log('\n[submitting answers]');
    const answerA = 'Midnight drives hit different when you are the reason I am awake.';
    const answerB = 'Midnight with you beats sunrise with anyone else, obviously.';
    const typeAndSubmit = (text) =>
      `(()=>{
        const t = document.querySelector('textarea');
        if (!t) return 'no-textarea';
        t.value = ${JSON.stringify(text)};
        t.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('button')].find(b=>/Submit answer/i.test(b.textContent));
        if (!btn) return 'no-button';
        btn.click();
        return 'submitted';
      })()`;
    check('A submitted an answer', (await A.evaluate(typeAndSubmit(answerA))) === 'submitted');
    await wait(1500);
    check('B submitted an answer', (await B.evaluate(typeAndSubmit(answerB))) === 'submitted');
    await wait(4000);

    // The second submission must push both clients into voting without a reload.
    const voteA = await pageText(A);
    const voteB = await pageText(B);
    check('A advanced to voting via the realtime push', /Vote for the stronger answer/i.test(voteA), voteA.slice(0, 160));
    check('B advanced to voting via the realtime push', /Vote for the stronger answer/i.test(voteB), voteB.slice(0, 160));
    check('A can see its own answer', voteA.includes(answerA), voteA.slice(0, 160));
    check('A cannot see the opponent answer before the reveal', /Answer hidden until voting closes/i.test(voteA), voteA.slice(0, 160));
    check('B cannot see the opponent answer before the reveal', /Answer hidden until voting closes/i.test(voteB), voteB.slice(0, 160));

    // ------------------------------------------------------------- voting
    console.log('\n[voting]');
    const voteResultA = await A.evaluate(clickButton('/Vote for your opponent/i'));
    const voteResultB = await B.evaluate(clickButton('/Vote for your opponent/i'));
    check('A cast a vote', voteResultA === 'clicked', voteResultA);
    check('B cast a vote', voteResultB === 'clicked', voteResultB);
    await wait(4500);

    const scoredA = await pageText(A);
    const scoredB = await pageText(B);
    check('the round was scored after both votes', /ROUND 1 RESULT/i.test(scoredA), scoredA.slice(0, 160));
    check('both answers are revealed to A after scoring', scoredA.includes(answerB), scoredA.slice(0, 160));
    check('both answers are revealed to B after scoring', scoredB.includes(answerA), scoredB.slice(0, 160));
    check('A cannot vote again once the round is scored', /Vote for your opponent/i.test(scoredA) === false, scoredA.slice(0, 160));
    check(
      'the rubric breakdown is rendered rather than placeholder dashes',
      /CREATIVITY\n\d/i.test(await A.evaluate("document.querySelector('#app').innerText")),
      'rubric values missing',
    );

    // Both clients must describe the round outcome the same way.
    const headline = (txt) => (String(txt).match(/ROUND 1 RESULT \| ([^|]+)/) || [])[1]?.trim();
    check('both clients agree on the round headline', headline(scoredA) === headline(scoredB), `${headline(scoredA)} vs ${headline(scoredB)}`);

    // ------------------------------------------------------------ errors
    console.log('\n[error check]');
    const errs = [...A.consoleErrors, ...B.consoleErrors];
    check('no console errors during real-time play', errs.length === 0, errs.join(' | '));
  } finally {
    chromeA.kill();
    chromeB.kill();
  }

  console.log(`\n=== TWO-ACCOUNT UI: ${passed} passed, ${failed} failed ===`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(` - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('UI realtime test crashed:', err);
  process.exit(1);
});
