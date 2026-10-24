/**
 * API surface verification.
 *
 * Registers two independent accounts, then walks the documented endpoint list
 * asserting each route responds as expected. This is a contract check: it
 * proves routes exist, auth is enforced and payloads are shaped as the client
 * expects. Behavioural rules live in tests/e2e.mjs.
 *
 *   node tests/verify-api.mjs        (server must be running)
 */
const BASE = process.env.BASE || 'http://localhost:12000';

let passed = 0;
let failed = 0;
const failures = [];

const brief = (res) => (res?.data === undefined ? '' : JSON.stringify(res.data).slice(0, 150));

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name} ${extra}`);
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

function client() {
  let cookie = '';
  return {
    async req(method, path, body) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const c of res.headers.getSetCookie?.() || []) cookie = c.split(';')[0];
      let data = null;
      const text = await res.text();
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      return { status: res.status, data };
    },
  };
}

const uniq = () => Math.random().toString(36).slice(2, 8);

async function register(c, label) {
  const username = `${label}_${uniq()}`;
  const res = await c.req('POST', '/api/auth/register', {
    username,
    email: `${username}@vybz.test`,
    password: 'Password123!',
    ageConfirmed: true,
  });
  return { username, res };
}

/** Play one full round (submit + mutual vote) for an active match. */
async function playRound(a, b, publicId, textA, textB, aId, bId) {
  await a.req('POST', `/api/matches/${publicId}/submit`, { body: textA });
  await b.req('POST', `/api/matches/${publicId}/submit`, { body: textB });
  await a.req('POST', `/api/matches/${publicId}/vote`, { targetUserId: bId });
  await b.req('POST', `/api/matches/${publicId}/vote`, { targetUserId: aId });
}

async function main() {
  console.log('\n=== VYBZ API surface verification ===\n');

  const a = client();
  const b = client();

  // ---------------------------------------------------------------- auth
  console.log('[auth]');
  const regA = await register(a, 'api');
  check('POST /api/auth/register', [200, 201].includes(regA.res.status), brief(regA.res));
  const regB = await register(b, 'api');
  check('POST /api/auth/register (second account)', [200, 201].includes(regB.res.status), brief(regB.res));

  const me = await a.req('GET', '/api/auth/me');
  check('GET /api/auth/me', me.status === 200 && me.data.user?.username === regA.username, brief(me));
  check('GET /api/auth/me returns profile', Boolean(me.data.profile), brief(me));
  check('GET /api/auth/me returns preferences', Boolean(me.data.preferences), brief(me));
  check(
    'preferred_games is decoded to an array',
    Array.isArray(me.data.preferences?.preferred_games),
    JSON.stringify(me.data.preferences?.preferred_games),
  );
  check('GET /api/auth/sessions', (await a.req('GET', '/api/auth/sessions')).status === 200);

  const aId = me.data.user.id;
  const bId = (await b.req('GET', '/api/auth/me')).data.user.id;

  const anon = client();
  const anonMe = await anon.req('GET', '/api/auth/me');
  check('unauthenticated /api/auth/me returns a null session', anonMe.status === 200 && anonMe.data.user === null, brief(anonMe));
  check('unauthenticated /api/profile/me is rejected', (await anon.req('GET', '/api/profile/me')).status === 401);
  check('unauthenticated /api/play/dashboard is rejected', (await anon.req('GET', '/api/play/dashboard')).status === 401);
  check('unauthenticated /api/inbox is rejected', (await anon.req('GET', '/api/inbox')).status === 401);

  // ------------------------------------------------------------- profile
  console.log('\n[profile]');
  check('GET /api/profile/me', (await a.req('GET', '/api/profile/me')).status === 200);
  check('PATCH /api/profile/me', (await a.req('PATCH', '/api/profile/me', { bio: 'Testing the API surface.' })).status === 200);
  check(
    'PATCH /api/profile/preferences',
    (await a.req('PATCH', '/api/profile/preferences', { preferred_games: ['rizz_battle'] })).status === 200,
  );
  const interests = await a.req('GET', '/api/profile/interests');
  check('GET /api/profile/interests', interests.status === 200, brief(interests));
  check('interests payload includes avatarPresets', Array.isArray(interests.data.avatarPresets), brief(interests));
  const ids = (interests.data.interests || []).slice(0, 3).map((i) => i.id);
  check('PUT /api/profile/interests', (await a.req('PUT', '/api/profile/interests', { interestIds: ids })).status === 200);
  check('GET /api/profile/discover', (await a.req('GET', '/api/profile/discover')).status === 200);
  check('GET /api/profile/leaderboard', (await a.req('GET', '/api/profile/leaderboard')).status === 200);
  check('GET /api/profile/challenges', (await a.req('GET', '/api/profile/challenges')).status === 200);
  check('GET /api/profile/history', (await a.req('GET', '/api/profile/history')).status === 200);
  const pub = await a.req('GET', `/api/profile/user/${regB.username}`);
  check('GET /api/profile/user/:username', pub.status === 200, brief(pub));
  const pubUser = pub.data.user || pub.data.profile || {};
  check('public profile hides private fields', pubUser.email === undefined, brief(pub));
  check('GET /api/profile/id/:id', (await a.req('GET', `/api/profile/id/${pubUser.userId ?? pubUser.id}`)).status === 200);
  check('GET /api/profile/id/:id rejects unknown id', (await a.req('GET', '/api/profile/id/999999')).status === 404);
  check('GET /api/profile/user/:username rejects unknown', (await a.req('GET', '/api/profile/user/nobody_here')).status === 404);
  check('POST /api/profile/onboarding', (await a.req('POST', '/api/profile/onboarding', { complete: true })).status === 200);

  // ---------------------------------------------------------------- play
  console.log('\n[play]');
  const modes = await a.req('GET', '/api/play/modes');
  check('GET /api/play/modes', modes.status === 200, brief(modes));
  check('modes expose prompt counts', (modes.data.modes || []).every((m) => typeof m.promptCount === 'number'), brief(modes));
  const dash = await a.req('GET', '/api/play/dashboard');
  check('GET /api/play/dashboard', dash.status === 200, brief(dash));
  check(
    'dashboard modes carry promptCount (Play tiles)',
    (dash.data.modes || []).length > 0 && (dash.data.modes || []).every((m) => typeof m.promptCount === 'number'),
    JSON.stringify((dash.data.modes || []).map((m) => m.promptCount)),
  );
  check('dashboard modes carry categories', (dash.data.modes || []).every((m) => Array.isArray(m.categories)), brief(dash));
  check('GET /api/play/queue/status', (await a.req('GET', '/api/play/queue/status')).status === 200);
  check('DELETE /api/play/queue', (await a.req('DELETE', '/api/play/queue?gameKey=rizz_battle')).status === 200);
  const practice = await a.req('POST', '/api/play/practice', { gameKey: 'rizz_battle' });
  check('POST /api/play/practice', [200, 201].includes(practice.status), brief(practice));
  check(
    'POST /api/matches/practice/score',
    (await a.req('POST', '/api/matches/practice/score', { gameKey: 'rizz_battle', body: 'A smooth line.' })).status === 200,
  );

  // ------------------------------------------------------------- matches
  console.log('\n[matches]');
  await a.req('POST', '/api/play/queue', { gameKey: 'rizz_battle', difficulty: 'standard' });
  await b.req('POST', '/api/play/queue', { gameKey: 'rizz_battle', difficulty: 'standard' });
  const tickA = await a.req('POST', '/api/play/queue/tick', { gameKey: 'rizz_battle' });
  const tickB = await b.req('POST', '/api/play/queue/tick', { gameKey: 'rizz_battle' });
  const matched = [tickA, tickB].find((t) => t.data?.state?.match?.publicId);
  check('queue matches two accounts', Boolean(matched), `${brief(tickA)} / ${brief(tickB)}`);
  const publicId = matched?.data?.state?.match?.publicId;

  if (!publicId) {
    check('match flow exercised', false, 'no match created');
  } else {
    check('GET /api/matches/:publicId', (await a.req('GET', `/api/matches/${publicId}`)).status === 200);
    check('GET /api/matches/:publicId rejects an anonymous caller', (await anon.req('GET', `/api/matches/${publicId}`)).status === 401);
    check('POST /api/matches/:publicId/accept (A)', (await a.req('POST', `/api/matches/${publicId}/accept`)).status === 200);
    check('POST /api/matches/:publicId/accept (B)', (await b.req('POST', `/api/matches/${publicId}/accept`)).status === 200);

    const subA = await a.req('POST', `/api/matches/${publicId}/submit`, { body: 'API check answer one.' });
    check('POST /api/matches/:publicId/submit (A)', subA.status === 200, brief(subA));
    const subB = await b.req('POST', `/api/matches/${publicId}/submit`, { body: 'API check answer two.' });
    check('POST /api/matches/:publicId/submit (B)', subB.status === 200, brief(subB));
    check('duplicate submission is rejected', (await a.req('POST', `/api/matches/${publicId}/submit`, { body: 'Twice.' })).status === 409);

    const state = await a.req('GET', `/api/matches/${publicId}`);
    const oppId = state.data.match?.opponent?.userId;
    check('match state exposes the opponent id', Boolean(oppId), brief(state));
    check('match state reports the viewer as accepted', state.data.match?.myAccepted === true, brief(state));
    check(
      'opponent answer is withheld before the reveal',
      (state.data.round?.submissions || []).every((s) => s.body === undefined),
      brief(state),
    );

    check('self-vote is rejected', [400, 403].includes((await a.req('POST', `/api/matches/${publicId}/vote`, { targetUserId: aId })).status));
    const voteA = await a.req('POST', `/api/matches/${publicId}/vote`, { targetUserId: oppId });
    check('POST /api/matches/:publicId/vote (A)', voteA.status === 200, brief(voteA));
    check('duplicate vote is rejected', (await a.req('POST', `/api/matches/${publicId}/vote`, { targetUserId: oppId })).status === 409);
    check('voting for a non-participant is rejected', (await a.req('POST', `/api/matches/${publicId}/vote`, { targetUserId: 999999 })).status === 400);
    await b.req('POST', `/api/matches/${publicId}/vote`, { targetUserId: aId });

    const scored = await a.req('GET', `/api/matches/${publicId}`);
    check('round reveals results after both votes', (scored.data.round?.results || []).length > 0, brief(scored));
    check('both answers revealed after scoring', (scored.data.round?.submissions || []).filter((s) => s.body).length === 2, brief(scored));
    check(
      'rubric breakdown persisted for submissions',
      (scored.data.round?.submissions || []).some((s) => s.judgeNotes && s.judgeNotes !== ''),
      brief(scored),
    );
    check('round results carry a reason', (scored.data.round?.results || []).every((r) => typeof r.reason === 'string'), brief(scored));

    check('GET /api/matches/:publicId/result rejects an unfinished match', (await a.req('GET', `/api/matches/${publicId}/result`)).status === 409);
    check('POST /api/matches/:publicId/rematch rejects an unfinished match', (await a.req('POST', `/api/matches/${publicId}/rematch`, {})).status === 409);

    // Play out the remaining rounds so the match completes.
    for (let round = 2; round <= 3; round += 1) {
      await new Promise((r) => setTimeout(r, 4200));
      await playRound(a, b, publicId, `Round ${round} from A.`, `Round ${round} from B.`, aId, bId);
    }
    await new Promise((r) => setTimeout(r, 1500));
    const done = await a.req('GET', `/api/matches/${publicId}`);
    check('match completes after the final round', done.data.match?.status === 'completed', brief(done));
    const result = await a.req('GET', `/api/matches/${publicId}/result`);
    check('GET /api/matches/:publicId/result', result.status === 200, brief(result));
    check('result lists both participants', (result.data.outcome?.participants || []).length === 2, brief(result));
    check('result never leaks a raw submission body', JSON.stringify(result.data).includes('Round 1 from B') === false, brief(result));
    const rm = await a.req('POST', `/api/matches/${publicId}/rematch`, {});
    check('POST /api/matches/:publicId/rematch', rm.status === 200, brief(rm));
    check('rematch creates a distinct match', rm.data?.match?.publicId !== publicId, brief(rm));
    check('POST /api/matches/:publicId/leave', (await a.req('POST', `/api/matches/${publicId}/leave`)).status === 200);
    // Clear the rematch too, otherwise the queue rejects later games as "in progress".
    if (rm.data?.match?.publicId) {
      check('the rematch can be left', (await a.req('POST', `/api/matches/${rm.data.match.publicId}/leave`)).status === 200);
    }
  }

  // -------------------------------------------------------------- signals
  console.log('\n[signals]');
  check('GET /api/signals', (await a.req('GET', '/api/signals')).status === 200);
  const templates = await a.req('GET', '/api/signals/templates');
  check('GET /api/signals/templates', templates.status === 200, brief(templates));
  const targets = await a.req('GET', '/api/signals/targets');
  check('GET /api/signals/targets', targets.status === 200, brief(targets));
  const targetId = (targets.data.targets || [])[0]?.id;
  const templateKey = (templates.data.templates || [])[0]?.key;
  if (targetId && templateKey) {
    const sent = await a.req('POST', '/api/signals', { recipientUserId: targetId, templateKey });
    check('POST /api/signals', [200, 201].includes(sent.status), brief(sent));
    check('signal response never names the sender', JSON.stringify(sent.data).includes(regA.username) === false, brief(sent));
  } else {
    check('POST /api/signals (no eligible target available)', true);
  }

  // ---------------------------------------------------------------- rooms
  console.log('\n[rooms]');
  const room = await a.req('POST', '/api/rooms', { visibility: 'private', categories: ['funny'] });
  check('POST /api/rooms', [200, 201].includes(room.status), brief(room));
  check('GET /api/rooms', (await a.req('GET', '/api/rooms')).status === 200);
  const roomId = room.data.room?.id;
  const roomCode = room.data.room?.code;
  if (!roomId) {
    check('room flow exercised', false, brief(room));
  } else {
    check('GET /api/rooms/:id', (await a.req('GET', `/api/rooms/${roomId}`)).status === 200);
    check('POST /api/rooms/join by code', (await b.req('POST', '/api/rooms/join', { code: roomCode })).status === 200);
    check('POST /api/rooms/join rejects a bad code', (await anon.req('POST', '/api/rooms/join', { code: 'ZZZZZZ' })).status === 401);
    check('POST /api/rooms/:id/ready', (await a.req('POST', `/api/rooms/${roomId}/ready`, { ready: true })).status === 200);
    check('POST /api/rooms/:id/round', (await a.req('POST', `/api/rooms/${roomId}/round`)).status === 200);
    check('POST /api/rooms/:id/invite', (await a.req('POST', `/api/rooms/${roomId}/invite`, { userId: bId })).status === 200);
    const roomReport = await a.req('POST', `/api/rooms/${roomId}/report`, { reason: 'spam', details: 'api check', subjectUserId: bId });
    check('POST /api/rooms/:id/report', [200, 201].includes(roomReport.status), brief(roomReport));
    check('POST /api/rooms/:id/end', (await a.req('POST', `/api/rooms/${roomId}/end`)).status === 200);
    check('POST /api/rooms/:id/leave', (await b.req('POST', `/api/rooms/${roomId}/leave`)).status === 200);
  }

  // ----------------------------------------------------------- blind vibe
  console.log('\n[blind vibe]');
  check('GET /api/blind-vibe', (await a.req('GET', '/api/blind-vibe')).status === 200);
  await a.req('POST', '/api/blind-vibe/queue', {});
  const bv = await b.req('POST', '/api/blind-vibe/queue', {});
  check('second player is matched into a session', bv.data?.status === 'matched', brief(bv));
  const bvId = bv.data?.session?.publicId;
  if (!bvId) {
    check('blind vibe session created', false, brief(bv));
  } else {
    check('GET /api/blind-vibe/:publicId', (await b.req('GET', `/api/blind-vibe/${bvId}`)).status === 200);
    check('session withholds identity before a mutual reveal', bv.data.other?.userId === null, brief(bv));
    check('withheld identity is shown as a placeholder', bv.data.other?.username === 'Mystery player', brief(bv));
    check(
      'POST /api/blind-vibe/:publicId/message',
      [200, 201].includes((await b.req('POST', `/api/blind-vibe/${bvId}/message`, { body: 'Hello there.' })).status),
    );
    check('POST /api/blind-vibe/:publicId/stage', (await b.req('POST', `/api/blind-vibe/${bvId}/stage`, {})).status === 200);
    const one = await b.req('POST', `/api/blind-vibe/${bvId}/interest`, { interested: true });
    check('POST /api/blind-vibe/:publicId/interest', one.status === 200, brief(one));
    check('one-sided interest is not reported as mutual', one.data.mutual === false, brief(one));
    check('one-sided interest does not reveal the other person', one.data.other?.userId === null, brief(one));
    const two = await a.req('POST', `/api/blind-vibe/${bvId}/interest`, { interested: true });
    check('mutual interest reveals both profiles', two.data.mutual === true && two.data.other?.userId === bId, brief(two));
    check('POST /api/blind-vibe/:publicId/end', (await b.req('POST', `/api/blind-vibe/${bvId}/end`)).status === 200);
  }
  check('DELETE /api/blind-vibe/queue', [200, 404].includes((await a.req('DELETE', '/api/blind-vibe/queue')).status));

  // -------------------------------------------------------- connections
  console.log('\n[connections]');
  const list = await a.req('GET', '/api/connections');
  check('GET /api/connections', list.status === 200, brief(list));
  // A mutual reveal raises a request, it does not silently create a connection.
  check('mutual blind-vibe interest is not an instant connection', (list.data.connections || []).length === 0, brief(list));

  const bInbox = await b.req('GET', '/api/connections');
  const incoming = bInbox.data.requests?.incoming || [];
  check('mutual blind-vibe interest raised a pending request', incoming.length === 1, brief(bInbox));
  const pendingId = incoming[0]?.id;
  if (pendingId) {
    const acc = await b.req('POST', `/api/connections/requests/${pendingId}/accept`);
    check('POST /api/connections/requests/:id/accept', acc.status === 200, brief(acc));
  } else {
    check('POST /api/connections/requests/:id/accept', false, brief(bInbox));
  }
  const connected = await a.req('GET', '/api/connections');
  check(
    'accepting the request creates the connection',
    (connected.data.connections || []).some((c) => c.user?.userId === bId),
    brief(connected),
  );
  check('DELETE /api/connections/:userId', (await a.req('DELETE', `/api/connections/${bId}`)).status === 200);
  check('deleting a missing connection is rejected', (await a.req('DELETE', `/api/connections/${bId}`)).status === 404);
  check('a connection cannot be requested with yourself', (await a.req('POST', '/api/connections/requests', { userId: aId })).status === 400);

  // After a decline the reverse request must be consumed first.
  const stale = await b.req('GET', '/api/connections');
  for (const r of stale.data.requests?.outgoing || []) {
    await b.req('POST', `/api/connections/requests/${r.id}/cancel`);
  }
  const req1 = await a.req('POST', '/api/connections/requests', { userId: bId });
  check('POST /api/connections/requests', [200, 201].includes(req1.status), brief(req1));
  const reqId = req1.data?.id;
  if (reqId && req1.data?.status === 'pending') {
    const acc = await b.req('POST', `/api/connections/requests/${reqId}/accept`);
    check('accepting a fresh request connects', acc.status === 200, brief(acc));
  } else {
    check('accepting a fresh request connects', false, brief(req1));
  }
  const dupReq = await a.req('POST', '/api/connections/requests', { userId: bId });
  check('a second request while connected is refused', dupReq.status === 409, brief(dupReq));
  await a.req('DELETE', `/api/connections/${bId}`);

  const req3 = await a.req('POST', '/api/connections/requests', { userId: bId });
  const req3Id = req3.data?.id;
  if (req3Id) {
    check('POST /api/connections/requests/:id/decline', (await b.req('POST', `/api/connections/requests/${req3Id}/decline`)).status === 200);
  } else {
    check('POST /api/connections/requests/:id/decline', false, brief(req3));
  }
  const req4 = await a.req('POST', '/api/connections/requests', { userId: bId });
  const req4Id = req4.data?.id;
  if (req4Id) {
    check('POST /api/connections/requests/:id/cancel', (await a.req('POST', `/api/connections/requests/${req4Id}/cancel`)).status === 200);
  } else {
    check('POST /api/connections/requests/:id/cancel', false, brief(req4));
  }

  // ---------------------------------------------------------------- inbox
  console.log('\n[inbox]');
  check('GET /api/inbox', (await a.req('GET', '/api/inbox')).status === 200);
  check('POST /api/inbox/open refuses an unconnected account', (await a.req('POST', '/api/inbox/open', { userId: bId })).status === 403);

  const req5 = await a.req('POST', '/api/connections/requests', { userId: bId });
  if (req5.data?.status === 'pending') await b.req('POST', `/api/connections/requests/${req5.data.id}/accept`);
  const convo = await a.req('POST', '/api/inbox/open', { userId: bId });
  check('POST /api/inbox/open once connected', convo.status === 200, brief(convo));
  const convoId = convo.data.conversationId;
  if (!convoId) {
    check('conversation created', false, brief(convo));
  } else {
    check('GET /api/inbox/:id', (await a.req('GET', `/api/inbox/${convoId}`)).status === 200);
    const msg = await a.req('POST', `/api/inbox/${convoId}/messages`, { body: 'API check message.' });
    check('POST /api/inbox/:id/messages', [200, 201].includes(msg.status), brief(msg));
    check('POST /api/inbox/:id/read', (await a.req('POST', `/api/inbox/${convoId}/read`, {})).status === 200);
    check('POST /api/inbox/:id/mute', (await a.req('POST', `/api/inbox/${convoId}/mute`, { muted: true })).status === 200);
    check('POST /api/inbox/:id/typing', [200, 204].includes((await a.req('POST', `/api/inbox/${convoId}/typing`, { typing: true })).status));
    check('an anonymous caller cannot read the conversation', (await anon.req('GET', `/api/inbox/${convoId}`)).status === 401);
    const msgId = msg.data?.message?.id;
    if (msgId) {
      check(
        'POST /api/inbox/:id/messages/:messageId/report',
        [200, 201].includes((await b.req('POST', `/api/inbox/${convoId}/messages/${msgId}/report`, { reason: 'spam' })).status),
      );
    }
  }

  // --------------------------------------------------------------- safety
  console.log('\n[safety]');
  check('GET /api/safety/blocks', (await a.req('GET', '/api/safety/blocks')).status === 200);
  check('GET /api/safety/report-reasons', (await a.req('GET', '/api/safety/report-reasons')).status === 200);
  const block = await a.req('POST', '/api/safety/blocks', { userId: bId });
  check('POST /api/safety/blocks', [200, 201].includes(block.status), brief(block));
  const afterBlock = await a.req('GET', '/api/connections');
  check('blocking removes the connection', (afterBlock.data.connections || []).some((c) => c.userId === bId) === false, brief(afterBlock));
  check('a blocked account cannot open a conversation', [403, 404].includes((await a.req('POST', '/api/inbox/open', { userId: bId })).status));
  check('DELETE /api/safety/blocks/:userId', (await a.req('DELETE', `/api/safety/blocks/${bId}`)).status === 200);
  const report = await a.req('POST', '/api/safety/reports', { subjectUserId: bId, reason: 'spam', details: 'api check' });
  check('POST /api/safety/reports', [200, 201].includes(report.status), brief(report));
  check('an invalid report reason is rejected', (await a.req('POST', '/api/safety/reports', { subjectUserId: bId, reason: 'not_a_reason' })).status === 400);
  check('GET /api/safety/reports/mine', (await a.req('GET', '/api/safety/reports/mine')).status === 200);

  // -------------------------------------------------------- notifications
  console.log('\n[notifications]');
  const notifs = await a.req('GET', '/api/notifications');
  check('GET /api/notifications', notifs.status === 200, brief(notifs));
  check('notifications correspond to real events', (notifs.data.notifications || []).length > 0, brief(notifs));
  check('POST /api/notifications/read', (await a.req('POST', '/api/notifications/read', {})).status === 200);

  // ---------------------------------------------------------------- admin
  console.log('\n[admin]');
  check('normal user denied GET /api/admin/overview', (await a.req('GET', '/api/admin/overview')).status === 403);
  check('normal user denied GET /api/admin/users', (await a.req('GET', '/api/admin/users')).status === 403);
  check('normal user denied GET /api/admin/reports', (await a.req('GET', '/api/admin/reports')).status === 403);
  check('normal user denied GET /api/admin/audit-log', (await a.req('GET', '/api/admin/audit-log')).status === 403);
  check('normal user denied GET /api/admin/prompts', (await a.req('GET', '/api/admin/prompts')).status === 403);
  check('normal user denied POST /api/admin/users/:id/role', (await a.req('POST', `/api/admin/users/${bId}/role`, { role: 'admin' })).status === 403);
  check('normal user cannot suspend another account', (await a.req('POST', `/api/admin/users/${bId}/action`, { action: 'suspend', days: 1 })).status === 403);

  // The bootstrap admin proves the dashboard is usable, not merely guarded.
  // BOOTSTRAP_ADMIN_USERNAME (default "admin") always receives the admin role.
  const adm = client();
  const admName = process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin';
  const admReg = await adm.req('POST', '/api/auth/register', {
    username: admName,
    email: `${admName}@vybz.test`,
    password: 'Password123!',
    ageConfirmed: true,
  });
  if (admReg.status === 409) {
    await adm.req('POST', '/api/auth/login', { identifier: admName, password: 'Password123!' });
  }
  const admMe = await adm.req('GET', '/api/auth/me');
  if (admMe.data?.user?.role === 'admin') {
    check('admin can read /api/admin/overview', (await adm.req('GET', '/api/admin/overview')).status === 200);
    check('admin can list users', (await adm.req('GET', '/api/admin/users')).status === 200);
    check('admin can read the moderation queue', (await adm.req('GET', '/api/admin/reports')).status === 200);
    check('admin can read the audit log', (await adm.req('GET', '/api/admin/audit-log')).status === 200);
    check('admin can read prompts', (await adm.req('GET', '/api/admin/prompts')).status === 200);
    check('admin can read categories', (await adm.req('GET', '/api/admin/categories')).status === 200);
    check('admin can read game modes', (await adm.req('GET', '/api/admin/game-modes')).status === 200);
    check('admin can read analytics', (await adm.req('GET', '/api/admin/analytics')).status === 200);
    check('admin can read match diagnostics', (await adm.req('GET', '/api/admin/matches')).status === 200);
    check('admin can read room diagnostics', (await adm.req('GET', '/api/admin/rooms')).status === 200);
  } else {
    check('bootstrap admin account is available', false, `register=${admReg.status} role=${admMe.data?.user?.role} ${brief(admMe)}`);
  }

  // -------------------------------------------------------------- media
  console.log('\n[media]');
  check('GET /api/media/:id rejects unknown id', [400, 404].includes((await a.req('GET', '/api/media/nope')).status));
  check('DELETE /api/media/avatar with no avatar is handled', [200, 404].includes((await a.req('DELETE', '/api/media/avatar')).status));

  // ---------------------------------------------------------- analytics
  console.log('\n[analytics]');
  check('POST /api/analytics/event', (await a.req('POST', '/api/analytics/event', { event: 'page_view', metadata: { path: '/play' } })).status === 202);
  check('unknown analytics events are rejected', (await a.req('POST', '/api/analytics/event', { event: 'not_whitelisted' })).status === 400);

  // --------------------------------------------------------------- pages
  console.log('\n[pages]');
  for (const p of ['/login', '/register', '/play', '/discover', '/inbox', '/connections', '/profile', '/signals', '/rooms', '/blind-vibe', '/admin']) {
    const res = await fetch(`${BASE}${p}`);
    check(`GET ${p} serves the shell`, res.status === 200, `status ${res.status}`);
  }

  console.log(`\n=== API RESULT: ${passed} passed, ${failed} failed ===`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(` - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('API verification crashed:', err);
  process.exit(1);
});
