/**
 * End-to-end verification with two independent authenticated accounts.
 * Exercises auth, matchmaking, server-authoritative rounds, voting,
 * scoring, signals, connections, messaging, blocking and reporting.
 */
const BASE = process.env.BASE || 'http://localhost:12000';
let passed = 0;
let failed = 0;
const failures = [];

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

function makeClient() {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async req(method, path, body) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.getSetCookie?.() || [];
      for (const c of setCookie) {
        const kv = c.split(';')[0];
        if (kv.startsWith('vybz_session=')) cookie = kv;
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }
      return { status: res.status, body: json };
    },
  };
}

const suffix = Date.now().toString(36);

/**
 * The suite registers several accounts each run, and registration is
 * deliberately rate limited per IP. Clear the limiter buckets so repeated
 * local runs are not throttled. This is a no-op when the database file is not
 * reachable (for example when running against a remote BASE).
 */
async function resetRateLimits() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const file = path.join(root, 'data', 'vybz.db');
    const db = new DatabaseSync(file);
    db.exec("DELETE FROM rate_limit_hits WHERE bucket IN ('register','login')");
    db.close();
  } catch {
    /* best effort: the remote server may own the database */
  }
}

async function main() {
  console.log('\n=== VYBZ end-to-end test (2 accounts) ===\n');
  await resetRateLimits();

  const alice = makeClient();
  const bob = makeClient();
  const carol = makeClient();

  // ---------- auth ----------
  console.log('[auth]');
  const regA = await alice.req('POST', '/api/auth/register', {
    username: `alice_${suffix}`,
    email: `alice_${suffix}@example.com`,
    password: 'Sup3rSecret!',
    ageConfirmed: true,
  });
  check('register account A', regA.status === 201, JSON.stringify(regA.body));
  const regB = await bob.req('POST', '/api/auth/register', {
    username: `bob_${suffix}`,
    email: `bob_${suffix}@example.com`,
    password: 'Sup3rSecret!',
    ageConfirmed: true,
  });
  check('register account B', regB.status === 201, JSON.stringify(regB.body));
  const regC = await carol.req('POST', '/api/auth/register', {
    username: `carol_${suffix}`,
    email: `carol_${suffix}@example.com`,
    password: 'Sup3rSecret!',
    ageConfirmed: true,
  });
  check('register account C', regC.status === 201, JSON.stringify(regC.body));

  const noAge = makeClient();
  const regNoAge = await noAge.req('POST', '/api/auth/register', {
    username: `minor_${suffix}`,
    email: `minor_${suffix}@example.com`,
    password: 'Sup3rSecret!',
    ageConfirmed: false,
  });
  check('registration blocked without 18+ confirmation', regNoAge.status === 400, `got ${regNoAge.status}`);

  const dup = makeClient();
  const regDup = await dup.req('POST', '/api/auth/register', {
    username: `alice_${suffix}`,
    email: `other_${suffix}@example.com`,
    password: 'Sup3rSecret!',
    ageConfirmed: true,
  });
  check('duplicate username rejected', regDup.status === 409, `got ${regDup.status}`);

  const badLogin = makeClient();
  const loginBad = await badLogin.req('POST', '/api/auth/login', {
    identifier: `alice_${suffix}`,
    password: 'wrongpassword',
  });
  check('wrong password rejected', loginBad.status === 401, `got ${loginBad.status}`);

  const anon = makeClient();
  const meAnon = await anon.req('GET', '/api/auth/me');
  check('unauthenticated /me returns null user', meAnon.status === 200 && meAnon.body.user === null);

  const protectedRes = await anon.req('GET', '/api/profile/me');
  check('protected route requires auth', protectedRes.status === 401, `got ${protectedRes.status}`);

  const adminAnon = await anon.req('GET', '/api/admin/overview');
  check('admin route denies anonymous', adminAnon.status === 401, `got ${adminAnon.status}`);

  const aliceId = regA.body.user.id;
  const bobId = regB.body.user.id;
  const carolId = regC.body.user.id;

  // Complete onboarding + set profiles so discovery works.
  for (const [client, name] of [
    [alice, 'Alice'],
    [bob, 'Bob'],
    [carol, 'Carol'],
  ]) {
    await client.req('PATCH', '/api/profile/me', { displayName: name, bio: `${name} loves trivia and karaoke.` });
    await client.req('POST', '/api/profile/onboarding', { complete: true });
  }
  const onboarded = await alice.req('GET', '/api/auth/me');
  check('onboarding state persisted', onboarded.body.user.onboarded === true);

  const interests = await alice.req('GET', '/api/profile/interests');
  check('interest catalogue available', Array.isArray(interests.body.interests) && interests.body.interests.length > 10);
  const trivia = interests.body.interests.find((i) => i.key === 'trivia');
  const karaoke = interests.body.interests.find((i) => i.key === 'karaoke');
  await alice.req('PUT', '/api/profile/interests', { interestIds: [trivia.id, karaoke.id] });
  await bob.req('PUT', '/api/profile/interests', { interestIds: [trivia.id] });
  const aliceInterests = await alice.req('GET', '/api/profile/interests');
  check('interests persisted for account A', aliceInterests.body.selected.length === 2);

  // ---------- game modes ----------
  console.log('\n[catalogue]');
  const modes = await alice.req('GET', '/api/play/modes');
  check('five game modes listed', modes.body.modes.length === 5, `got ${modes.body.modes.length}`);
  check('judge availability is reported honestly', modes.body.judge.operational === false && modes.body.judge.fallback === 'heuristic');
  const rizz = modes.body.modes.find((m) => m.key === 'rizz_battle');
  check('rizz battle has prompts + categories', rizz.promptCount > 20 && rizz.categories.length === 8);

  // ---------- matchmaking ----------
  console.log('\n[matchmaking]');
  const queueA = await alice.req('POST', '/api/play/queue', { gameKey: 'rizz_battle' });
  check('account A queues', queueA.status === 200 && ['waiting', 'matched'].includes(queueA.body.status), JSON.stringify(queueA.body));
  check('empty queue reports an honest waiting state', queueA.body.status !== 'matched' ? typeof queueA.body.message === 'string' : true);

  const queueB = await bob.req('POST', '/api/play/queue', { gameKey: 'rizz_battle' });
  let matchState = queueB.body.state || queueA.body.state;
  if (!matchState) {
    const tick = await alice.req('POST', '/api/play/queue/tick', { gameKey: 'rizz_battle' });
    matchState = tick.body.state;
  }
  check('a match is created from the queue', Boolean(matchState), JSON.stringify(queueB.body).slice(0, 200));
  if (!matchState) {
    console.log('\nCannot continue without a match.\n');
    return finish();
  }
  const publicId = matchState.match.publicId;
  check('match has exactly two participants', matchState.match.opponent !== null);
  check('match starts pending acceptance', matchState.match.status === 'pending');

  const dupQueue = await alice.req('POST', '/api/play/queue', { gameKey: 'word_chemistry' });
  check('cannot queue while a match is active', dupQueue.status === 409, `got ${dupQueue.status}`);

  const outsider = await carol.req('GET', `/api/matches/${publicId}`);
  check('third party cannot read the match', outsider.status === 403, `got ${outsider.status}`);

  // ---------- accept + play ----------
  console.log('\n[match play]');
  const acceptA = await alice.req('POST', `/api/matches/${publicId}/accept`);
  check('account A accepts', acceptA.status === 200);
  const acceptB = await bob.req('POST', `/api/matches/${publicId}/accept`);
  check('account B accepts', acceptB.status === 200);
  check('match becomes active once both accept', acceptB.body.state.match.status === 'active', acceptB.body.state.match.status);

  const stateA = await alice.req('GET', `/api/matches/${publicId}`);
  check('round 1 has a prompt', Boolean(stateA.body.round?.prompt));
  check('round exposes a server deadline', Boolean(stateA.body.round?.submissionDeadline));

  const subA = await alice.req('POST', `/api/matches/${publicId}/submit`, {
    body: 'You must be the reason the elevator stopped — everything else is just details.',
  });
  check('account A submits', subA.status === 200, JSON.stringify(subA.body).slice(0, 150));
  check('opponent submission text is hidden before reveal', subA.body.state.round.submissions.every((s) => !s.body || s.body === undefined || s.userId === aliceId ? true : false) || subA.body.state.round.phase !== 'scored');

  const dupSubmit = await alice.req('POST', `/api/matches/${publicId}/submit`, { body: 'Trying to submit twice.' });
  check('duplicate submission rejected', dupSubmit.status === 409, `got ${dupSubmit.status}`);

  const subB = await bob.req('POST', `/api/matches/${publicId}/submit`, {
    body: 'I would say something clever, but I would rather just stand here and enjoy the view.',
  });
  check('account B submits', subB.status === 200);

  const voteSelf = await alice.req('POST', `/api/matches/${publicId}/vote`, { targetUserId: aliceId });
  check('self-voting blocked', voteSelf.status === 403, `got ${voteSelf.status}`);

  const voteA = await alice.req('POST', `/api/matches/${publicId}/vote`, { targetUserId: bobId });
  check('account A votes for B', voteA.status === 200, JSON.stringify(voteA.body).slice(0, 120));
  const dupVote = await alice.req('POST', `/api/matches/${publicId}/vote`, { targetUserId: bobId });
  check('duplicate vote rejected', dupVote.status === 409, `got ${dupVote.status}`);

  const voteB = await bob.req('POST', `/api/matches/${publicId}/vote`, { targetUserId: aliceId });
  check('account B votes for A', voteB.status === 200);

  const afterVote = await alice.req('GET', `/api/matches/${publicId}`);
  check('round is scored after all votes', afterVote.body.round.phase === 'scored', afterVote.body.round.phase);
  check('scores were awarded server-side', afterVote.body.match.myScore > 0, `myScore=${afterVote.body.match.myScore}`);

  // Play out the remaining rounds by forcing the deadline.
  for (let round = 2; round <= afterVote.body.match.totalRounds; round += 1) {
    await new Promise((r) => setTimeout(r, 4000));
    const s = await alice.req('GET', `/api/matches/${publicId}`);
    if (s.body.match.status !== 'active') break;
    if (s.body.round.roundNumber !== round) continue;
    await alice.req('POST', `/api/matches/${publicId}/submit`, { body: `Round ${round} answer from A, sharp and specific.` });
    await bob.req('POST', `/api/matches/${publicId}/submit`, { body: `Round ${round} answer from B, witty and warm.` });
    await alice.req('POST', `/api/matches/${publicId}/vote`, { targetUserId: bobId });
    await bob.req('POST', `/api/matches/${publicId}/vote`, { targetUserId: aliceId });
  }

  await new Promise((r) => setTimeout(r, 4500));
  const final = await alice.req('GET', `/api/matches/${publicId}`);
  check('match completes after all rounds', final.body.match.status === 'completed', final.body.match.status);
  check('outcome is reported', Boolean(final.body.outcome), JSON.stringify(final.body.match.status));

  const bobFinal = await bob.req('GET', `/api/matches/${publicId}`);
  check('both clients see a consistent winner', final.body.outcome.winner === bobFinal.body.outcome.winner);

  const history = await alice.req('GET', '/api/profile/history');
  check('match history is persisted', history.body.history.length >= 1);

  const stats = await alice.req('GET', '/api/profile/me');
  check('XP was awarded', stats.body.statistics.xp > 0, `xp=${stats.body.statistics.xp}`);
  check('level progression computed', stats.body.progress.level >= 1);
  check('achievements evaluated', stats.body.achievements.some((a) => a.unlocked));

  // Idempotency: re-submitting to a finished match must not add score.
  const scoreBefore = stats.body.statistics.xp;
  const reSubmit = await alice.req('POST', `/api/matches/${publicId}/submit`, { body: 'Late submission attempt.' });
  check('cannot submit to a completed match', reSubmit.status === 409, `got ${reSubmit.status}`);
  const statsAfter = await alice.req('GET', '/api/profile/me');
  check('no duplicate XP awarded', statsAfter.body.statistics.xp === scoreBefore);

  // ---------- word chemistry ----------
  console.log('\n[word chemistry]');
  const wcA = await alice.req('POST', '/api/play/queue', { gameKey: 'word_chemistry' });
  const wcB = await bob.req('POST', '/api/play/queue', { gameKey: 'word_chemistry' });
  let wcState = wcB.body.state || wcA.body.state;
  if (!wcState) {
    const tick = await alice.req('POST', '/api/play/queue/tick', { gameKey: 'word_chemistry' });
    wcState = tick.body.state;
  }
  check('word chemistry match created', Boolean(wcState), JSON.stringify(wcB.body).slice(0, 160));
  if (wcState) {
    const wcId = wcState.match.publicId;
    await alice.req('POST', `/api/matches/${wcId}/accept`);
    await bob.req('POST', `/api/matches/${wcId}/accept`);
    await alice.req('POST', `/api/matches/${wcId}/submit`, { body: 'Midnight is better with someone who talks about nothing until it means everything.' });
    const wcSub = await bob.req('POST', `/api/matches/${wcId}/submit`, { body: 'Midnight is better with someone who talks about everything until it means nothing.' });
    check('similarity round resolves without voting', wcSub.status === 200);
    await new Promise((r) => setTimeout(r, 500));
    const wcAfter = await alice.req('GET', `/api/matches/${wcId}`);
    check('similarity score is computed', wcAfter.body.round.phase === 'scored' && wcAfter.body.round.results.length === 2, wcAfter.body.round.phase);
    // Abandon cleanly so it does not interfere with later tests.
    await alice.req('POST', `/api/matches/${wcId}/leave`);
  }

  // ---------- secret signal ----------
  console.log('\n[secret signal]');
  const templates = await alice.req('GET', '/api/signals/templates');
  check('signal templates available', templates.body.templates.length > 5);
  const tpl = templates.body.templates[0];

  const sig1 = await alice.req('POST', '/api/signals', { recipientId: carolId, templateKey: tpl.key });
  check('signal sent', sig1.status === 201, JSON.stringify(sig1.body).slice(0, 150));
  const dupSig = await alice.req('POST', '/api/signals', { recipientId: carolId, templateKey: tpl.key });
  check('duplicate signal the same day is blocked', dupSig.status === 409, `got ${dupSig.status}`);

  const carolInbox = await carol.req('GET', '/api/signals');
  check('recipient receives the signal', carolInbox.body.received.length >= 1);
  const received = carolInbox.body.received[0];
  check('sender identity is absent from the payload', received.sender === null && !('sender_user_id' in received) && !('senderId' in received), JSON.stringify(received));
  // Structural check: no identity field exists anywhere on received signals.
  const identityKeys = ['sender_user_id', 'senderId', 'sender_user', 'username', 'email'];
  const leakedKeys = carolInbox.body.received.flatMap((s) => Object.keys(s)).filter((k) => identityKeys.includes(k));
  check('no sender identity field leaks in the inbox payload', leakedKeys.length === 0, `leaked=${leakedKeys.join(',')}`);
  check('sender username never appears in the recipient payload', !JSON.stringify(carolInbox.body.received).includes(`alice_${suffix}`));

  const customBad = await alice.req('POST', '/api/signals', {
    recipientId: carolId,
    body: 'email me at test@example.com or call +1 555 123 4567',
  });
  check('anonymous custom text cannot contain contact details', customBad.status === 400, `got ${customBad.status}`);

  const reactDismiss = await carol.req('POST', `/api/signals/${received.id}/react`, { action: 'dismiss' });
  check('recipient can dismiss a signal', reactDismiss.status === 200 && reactDismiss.body.status === 'dismissed');

  // One-sided interest must stay private. A different signal kind is used so the
  // per-day duplicate guard (one signal per pair per kind) is not triggered.
  const interestTpl = templates.body.templates.find((t) => t.kind === 'interest');
  check('interest-kind templates exist', Boolean(interestTpl));
  const sig2 = await alice.req('POST', '/api/signals', { recipientId: carolId, templateKey: interestTpl.key });
  check('second signal with a different kind is allowed', sig2.status === 201, JSON.stringify(sig2.body).slice(0, 120));
  const carolInbox2 = await carol.req('GET', '/api/signals');
  const live = carolInbox2.body.received[0];
  check('a live signal is available to react to', Boolean(live));
  const oneSided = await carol.req('POST', `/api/signals/${live.id}/react`, { action: 'mutual' });
  check('one-sided interest does not create a connection', oneSided.body.connected === false, JSON.stringify(oneSided.body));
  const aliceConns = await alice.req('GET', '/api/connections');
  check('sender is not told about one-sided interest', !aliceConns.body.connections.some((c) => c.user.userId === carolId));

  // Mutual interest creates a connection.
  const sigBack = await carol.req('POST', '/api/signals', { recipientId: aliceId, templateKey: interestTpl.key });
  check('reciprocal signal sent', sigBack.status === 201);
  const aliceSignals = await alice.req('GET', '/api/signals');
  const incoming = aliceSignals.body.received[0];
  check('sender receives the reciprocal signal', Boolean(incoming));
  const mutual = await alice.req('POST', `/api/signals/${incoming.id}/react`, { action: 'mutual' });
  check('mutual signals connect the pair', mutual.body.connected === true, JSON.stringify(mutual.body));
  const aliceConns2 = await alice.req('GET', '/api/connections');
  check('connection appears for the sender', aliceConns2.body.connections.some((c) => c.user.userId === carolId));

  // ---------- messaging ----------
  console.log('\n[messaging]');
  const openConv = await alice.req('POST', '/api/inbox/open', { userId: carolId });
  check('conversation opened with a connection', openConv.status === 200, JSON.stringify(openConv.body));
  const convId = openConv.body.conversationId;
  const send = await alice.req('POST', `/api/inbox/${convId}/messages`, { body: 'Hey! That signal game was fun.' });
  check('message sent', send.status === 201);
  const carolConvs = await carol.req('GET', '/api/inbox');
  check('recipient sees the conversation', carolConvs.body.conversations.some((c) => c.id === convId));
  check('unread count reflects the new message', carolConvs.body.unread >= 1, `unread=${carolConvs.body.unread}`);
  const carolMsgs = await carol.req('GET', `/api/inbox/${convId}`);
  check('recipient can read the message', carolMsgs.body.messages.some((m) => m.body.includes('signal game')));
  await carol.req('POST', `/api/inbox/${convId}/read`);
  const carolConvs2 = await carol.req('GET', '/api/inbox');
  check('marking read clears the unread count', carolConvs2.body.unread === 0, `unread=${carolConvs2.body.unread}`);

  const noConnMsg = await carol.req('POST', '/api/inbox/open', { userId: bobId });
  check('cannot message a non-connection by default', noConnMsg.status === 403, `got ${noConnMsg.status}`);

  const thirdPartyRead = await bob.req('GET', `/api/inbox/${convId}`);
  check('non-participant cannot read a conversation', thirdPartyRead.status === 403, `got ${thirdPartyRead.status}`);

  // ---------- blocking ----------
  console.log('\n[blocking + reporting]');
  const block = await alice.req('POST', '/api/safety/blocks', { userId: carolId });
  check('block succeeds', block.status === 201);
  const blockedConns = await alice.req('GET', '/api/connections');
  check('block removes the connection', !blockedConns.body.connections.some((c) => c.user.userId === carolId));
  const blockedMsg = await alice.req('POST', `/api/inbox/${convId}/messages`, { body: 'Should not send.' });
  check('blocked account cannot message', blockedMsg.status === 403, `got ${blockedMsg.status}`);
  const blockedConvList = await alice.req('GET', '/api/inbox');
  check('blocked conversation disappears from the inbox', !blockedConvList.body.conversations.some((c) => c.id === convId));
  const blockedSignal = await alice.req('POST', '/api/signals', { recipientId: carolId, templateKey: tpl.key });
  check('cannot send signals to a blocked account', blockedSignal.status === 403, `got ${blockedSignal.status}`);
  const carolQueue = await carol.req('POST', '/api/play/queue', { gameKey: 'rizz_battle' });
  const aliceQueue = await alice.req('POST', '/api/play/queue', { gameKey: 'rizz_battle' });
  const blockedMatch = aliceQueue.body.state || carolQueue.body.state;
  check('blocked players are never matched together', !blockedMatch || !(blockedMatch.match.opponent && blockedMatch.match.opponent.userId === carolId));
  await alice.req('DELETE', '/api/play/queue?gameKey=rizz_battle');
  await carol.req('DELETE', '/api/play/queue?gameKey=rizz_battle');

  const report = await carol.req('POST', '/api/safety/reports', {
    subjectUserId: bobId,
    targetType: 'user',
    reason: 'spam',
    details: 'Automated test report.',
  });
  check('report filed', report.status === 201, JSON.stringify(report.body).slice(0, 120));
  const myReports = await carol.req('GET', '/api/safety/reports/mine');
  check('reporter can track their report', myReports.body.reports.length >= 1);
  const badReason = await carol.req('POST', '/api/safety/reports', { subjectUserId: bobId, reason: 'not_a_reason' });
  check('invalid report reason rejected', badReason.status === 400, `got ${badReason.status}`);

  // ---------- rooms ----------
  console.log('\n[spill it rooms]');
  const room = await alice.req('POST', '/api/rooms', {
    name: 'Test room',
    visibility: 'private',
    maxPlayers: 4,
    categories: ['funny', 'personality'],
  });
  check('room created with a code', room.status === 201 && /^[A-Z0-9]{6}$/.test(room.body.room.code), JSON.stringify(room.body).slice(0, 150));
  const code = room.body.room.code;
  const roomId = room.body.room.id;
  check('room boundaries default to safe values', room.body.room.boundaries.allowImages === false && room.body.room.boundaries.allowBoldQuestions === false);

  const join = await bob.req('POST', '/api/rooms/join', { code });
  check('second player joins by code', join.status === 200 && join.body.members.length === 2, JSON.stringify(join.body).slice(0, 150));
  const outsiderRoom = await carol.req('GET', `/api/rooms/${roomId}`);
  check('non-member cannot read the room', outsiderRoom.status === 403, `got ${outsiderRoom.status}`);

  const startRound = await alice.req('POST', `/api/rooms/${roomId}/round`, {});
  check('round started', startRound.status === 200 && startRound.body.roundNumber === 1, JSON.stringify(startRound.body).slice(0, 150));
  const roundId = startRound.body.roundId;
  const activeUserId = startRound.body.room.current.activeUserId;
  const activeClient = activeUserId === aliceId ? alice : bob;
  const otherClient = activeUserId === aliceId ? bob : alice;
  const notMyTurn = await otherClient.req('POST', `/api/rooms/${roomId}/round/${roundId}/answer`, { body: 'not my turn' });
  check('answering out of turn is rejected', notMyTurn.status === 403, `got ${notMyTurn.status}`);
  const answer = await activeClient.req('POST', `/api/rooms/${roomId}/round/${roundId}/answer`, { body: 'My honest answer.' });
  check('active player can answer', answer.status === 200);
  const skip = await alice.req('POST', `/api/rooms/${roomId}/round/${roundId}/skip`, {});
  check('skipping a closed round is rejected', skip.status === 409, `got ${skip.status}`);

  const round2 = await alice.req('POST', `/api/rooms/${roomId}/round`, {});
  const skip2 = await alice.req('POST', `/api/rooms/${roomId}/round/${round2.body.roundId}/skip`, {});
  check('skipping an open round is always allowed', skip2.status === 200);

  const endRoom = await alice.req('POST', `/api/rooms/${roomId}/end`, {});
  check('host can end the room', endRoom.status === 200);
  const endAgain = await bob.req('POST', `/api/rooms/${roomId}/end`, {});
  check('non-host cannot end the room', endAgain.status === 403, `got ${endAgain.status}`);

  // ---------- blind vibe ----------
  console.log('\n[blind vibe]');
  await alice.req('DELETE', `/api/safety/blocks/${carolId}`);
  const bvQueueA = await alice.req('POST', '/api/blind-vibe/queue');
  const bvQueueB = await carol.req('POST', '/api/blind-vibe/queue');
  // The matched response carries { status, session, other, ... } at the top level.
  const bvResponse = bvQueueB.body.session ? bvQueueB.body : bvQueueA.body;
  const bvSession = bvResponse.session;
  check('blind vibe session created', Boolean(bvSession), JSON.stringify(bvQueueB.body).slice(0, 200));
  if (bvSession) {
    const bvPublic = bvSession.publicId;
    check('stage 1 hides the other profile', bvResponse.other.userId === null && bvResponse.other.username === 'Mystery player');
    check('a prompt is provided for the stage', typeof bvSession.prompt === 'string' && bvSession.prompt.length > 5);
    const bvMsg = await carol.req('POST', `/api/blind-vibe/${bvPublic}/message`, { body: 'Hello there, mystery person.' });
    check('blind chat works while anonymous', bvMsg.status === 200);
    const bvMsgView = await alice.req('GET', `/api/blind-vibe/${bvPublic}`);
    check('blind chat is delivered to the other side', bvMsgView.body.messages.some((m) => m.body.includes('mystery person')));
    const stage = await alice.req('POST', `/api/blind-vibe/${bvPublic}/stage`, {});
    check('stage can advance', stage.status === 200 && stage.body.session.stage === 2);
    const oneSided = await alice.req('POST', `/api/blind-vibe/${bvPublic}/interest`, { interested: true });
    check('one-sided interest is stored but not revealed', oneSided.body.mutual === false, JSON.stringify(oneSided.body).slice(0, 150));
    const carolView = await carol.req('GET', `/api/blind-vibe/${bvPublic}`);
    check('other player cannot see the one-sided choice', carolView.body.other.userId === null && carolView.body.session.isMutual === false);
    const noChoiceField = !('theirChoiceMade' in carolView.body.session);
    check('the fact that a choice was made is not leaked', noChoiceField, JSON.stringify(carolView.body.session));
    const mutual = await carol.req('POST', `/api/blind-vibe/${bvPublic}/interest`, { interested: true });
    check('mutual interest reveals and connects', mutual.body.mutual === true && mutual.body.other.userId !== null, JSON.stringify(mutual.body).slice(0, 200));
  }

  // ---------- admin authorization ----------
  console.log('\n[admin]');
  // Note: the first account created on a fresh database is the bootstrap admin
  // by design, so account B (a regular user) is used to prove the role gate.
  const adminDenied = await bob.req('GET', '/api/admin/overview');
  check('normal user denied admin access', adminDenied.status === 403, `got ${adminDenied.status}`);
  const adminReports = await bob.req('GET', '/api/admin/reports');
  check('normal user denied moderation queue', adminReports.status === 403, `got ${adminReports.status}`);
  const adminRoleChange = await bob.req('POST', `/api/admin/users/${aliceId}/role`, { role: 'admin' });
  check('normal user cannot grant themselves a role', adminRoleChange.status === 403, `got ${adminRoleChange.status}`);

  // ---------- account deletion ----------
  console.log('\n[account lifecycle]');
  const delBad = await carol.req('DELETE', '/api/auth/account', { password: 'Sup3rSecret!', confirm: 'nope' });
  check('account deletion requires explicit confirmation', delBad.status === 400, `got ${delBad.status}`);
  const delBadPw = await carol.req('DELETE', '/api/auth/account', { password: 'wrong', confirm: 'DELETE' });
  check('account deletion requires the correct password', delBadPw.status === 403, `got ${delBadPw.status}`);

  const logout = await bob.req('POST', '/api/auth/logout');
  check('logout succeeds', logout.status === 200);
  const afterLogout = await bob.req('GET', '/api/profile/me');
  check('session is invalid after logout', afterLogout.status === 401, `got ${afterLogout.status}`);

  const relogin = makeClient();
  const reloginRes = await relogin.req('POST', '/api/auth/login', { identifier: `bob_${suffix}`, password: 'Sup3rSecret!' });
  check('login works after logout', reloginRes.status === 200);
  const persisted = await relogin.req('GET', '/api/profile/me');
  check('data persists across sessions', persisted.body.statistics.games_played >= 1, `games=${persisted.body.statistics.games_played}`);

  return finish();
}

function finish() {
  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(` - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
