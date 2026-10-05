// Real-DB, real-HTTP tests for the Break Room routes — matches this
// app's established convention (see callScoringProfile.test.js): a real
// http.Server, real session cookies via createSession, no mocked Prisma.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyA, agencyB;
let producerA, producerB, platformOwner;
let producerACookie, producerBCookie, platformOwnerCookie;
let server, port;

async function makeAgencyWithProducer(label) {
  const agency = await prisma.agency.create({ data: { name: `Break Room Route Test ${label} ${suffix}`, breakRoomEnabled: true } });
  const producer = await prisma.user.create({
    data: { email: `br-producer-${label}-${suffix}@test.local`, passwordHash: 'x', firstName: label, lastName: 'Producer', role: 'PRODUCER', agencyId: agency.id, status: 'ACTIVE' },
  });
  const { rawToken } = await createSession(producer.id);
  return { agency, producer, cookie: `evenflow_session=${rawToken}` };
}

async function putOnBreak(producerId, agencyId) {
  // Close any still-open entry rather than deleting it — a real
  // TimeClockEntry is never deleted (and BreakRoomGameSession rows may
  // already reference one from an earlier test in this same run).
  await prisma.timeClockEntry.updateMany({ where: { userId: producerId, clockOutAt: null }, data: { clockOutAt: new Date() } });
  return prisma.timeClockEntry.create({ data: { userId: producerId, agencyId, breakStartAt: new Date() } });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

before(async () => {
  const a = await makeAgencyWithProducer('A');
  agencyA = a.agency; producerA = a.producer; producerACookie = a.cookie;

  const b = await makeAgencyWithProducer('B');
  agencyB = b.agency; producerB = b.producer; producerBCookie = b.cookie;

  platformOwner = await prisma.user.create({
    data: { email: `br-platform-${suffix}@test.local`, passwordHash: 'x', firstName: 'Platform', lastName: 'Owner', role: 'PLATFORM_OWNER', status: 'ACTIVE' },
  });
  const { rawToken } = await createSession(platformOwner.id);
  platformOwnerCookie = `evenflow_session=${rawToken}`;

  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  await prisma.breakRoomAchievement.deleteMany({ where: { agencyId: { in: [agencyA.id, agencyB.id] } } });
  await prisma.breakRoomHighScore.deleteMany({ where: { agencyId: { in: [agencyA.id, agencyB.id] } } });
  await prisma.breakRoomGameSession.deleteMany({ where: { agencyId: { in: [agencyA.id, agencyB.id] } } });
  await prisma.timeClockEntry.deleteMany({ where: { agencyId: { in: [agencyA.id, agencyB.id] } } });
  await prisma.breakRoomPlatformSettings.deleteMany({ where: { id: 'singleton' } });
  const allUserIds = [producerA.id, producerB.id, platformOwner.id];
  await prisma.session.deleteMany({ where: { userId: { in: allUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: allUserIds } } });
  await prisma.agency.deleteMany({ where: { id: { in: [agencyA.id, agencyB.id] } } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

function request(method, path, cookie, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1', port, path, method,
        headers: {
          Connection: 'close',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('a producer NOT on break cannot start a game session', async () => {
  await prisma.timeClockEntry.deleteMany({ where: { userId: producerA.id } });
  const res = await request('POST', '/api/break-room/sessions', producerACookie, { gameType: 'CONGO_LINE' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'NOT_CLOCKED_IN');
});

test('a producer ON break can start a session, submit a plausible score, and it becomes their personal best', async () => {
  await putOnBreak(producerA.id, agencyA.id);
  const start = await request('POST', '/api/break-room/sessions', producerACookie, { gameType: 'CONGO_LINE' });
  assert.equal(start.status, 201);
  assert.ok(start.body.sessionId);

  // Long enough that a real 3200-point, 18-dancer run stays under the
  // per-second rate cap too (not just the minimum-duration floor).
  await sleep(9000);
  const end = await request('POST', `/api/break-room/sessions/${start.body.sessionId}/end`, producerACookie, {
    score: 3200, metrics: { dancersCollected: 18 },
  });
  assert.equal(end.status, 200);
  assert.equal(end.body.newPersonalBest, true);
  assert.equal(end.body.flagged, false);

  const home = await request('GET', '/api/break-room/home', producerACookie);
  const congo = home.body.games.find((g) => g.gameType === 'CONGO_LINE');
  assert.equal(congo.personalBest, 3200);
});

test('an implausible score is rejected outright, not stored as a valid high score', async () => {
  await putOnBreak(producerA.id, agencyA.id);
  const start = await request('POST', '/api/break-room/sessions', producerACookie, { gameType: 'CONGO_LINE' });
  const end = await request('POST', `/api/break-room/sessions/${start.body.sessionId}/end`, producerACookie, {
    score: 999999, metrics: { dancersCollected: 5 },
  });
  assert.equal(end.status, 422);
  assert.equal(end.body.error, 'SCORE_REJECTED');
});

test('a session cannot be ended twice, and cannot be ended by a different user', async () => {
  await putOnBreak(producerA.id, agencyA.id);
  const start = await request('POST', '/api/break-room/sessions', producerACookie, { gameType: 'BUCKETS' });
  await sleep(2100);
  const first = await request('POST', `/api/break-room/sessions/${start.body.sessionId}/end`, producerACookie, { score: 500 });
  assert.equal(first.status, 200);

  const second = await request('POST', `/api/break-room/sessions/${start.body.sessionId}/end`, producerACookie, { score: 600 });
  assert.equal(second.status, 409);

  await putOnBreak(producerB.id, agencyB.id);
  const start2 = await request('POST', '/api/break-room/sessions', producerACookie, { gameType: 'BUCKETS' });
  await putOnBreak(producerA.id, agencyA.id);
  const stolen = await request('POST', `/api/break-room/sessions/${start2.body.sessionId}/end`, producerBCookie, { score: 100 });
  assert.equal(stolen.status, 404, 'a different user cannot end someone else\'s session');
});

test('leaderboard is tenant-isolated: agency B never sees agency A\'s scores under scope=agency', async () => {
  const leaderboardA = await request('GET', '/api/break-room/leaderboard?gameType=CONGO_LINE&scope=agency', producerACookie);
  assert.equal(leaderboardA.status, 200);
  assert.ok(leaderboardA.body.rows.every((r) => r.userId !== producerB.id));

  await putOnBreak(producerB.id, agencyB.id);
  const startB = await request('POST', '/api/break-room/sessions', producerBCookie, { gameType: 'CONGO_LINE' });
  await sleep(2100);
  await request('POST', `/api/break-room/sessions/${startB.body.sessionId}/end`, producerBCookie, { score: 700, metrics: { dancersCollected: 8 } });

  const leaderboardB = await request('GET', '/api/break-room/leaderboard?gameType=CONGO_LINE&scope=agency', producerBCookie);
  assert.ok(leaderboardB.body.rows.some((r) => r.userId === producerB.id));
  const leaderboardAAgain = await request('GET', '/api/break-room/leaderboard?gameType=CONGO_LINE&scope=agency', producerACookie);
  assert.ok(leaderboardAAgain.body.rows.every((r) => r.userId !== producerB.id), 'agency A still never sees agency B after B plays');
});

test('global leaderboard scope is refused until a Platform Owner enables it', async () => {
  const res = await request('GET', '/api/break-room/leaderboard?gameType=CONGO_LINE&scope=global', producerACookie);
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'GLOBAL_LEADERBOARD_DISABLED');
});

test('a disabled game cannot be launched even while on break', async () => {
  await request('PATCH', `/api/agencies/${agencyA.id}/break-room-settings`, producerACookie, { games: { CONGO_LINE: false } });
  // Producer lacks permission for the settings route itself — use the
  // platform owner, which is the one role always authorized.
  const asAdmin = await request('PATCH', `/api/agencies/${agencyA.id}/break-room-settings`, platformOwnerCookie, { games: { CONGO_LINE: false } });
  assert.equal(asAdmin.status, 200);

  await putOnBreak(producerA.id, agencyA.id);
  const start = await request('POST', '/api/break-room/sessions', producerACookie, { gameType: 'CONGO_LINE' });
  assert.equal(start.status, 403);
  assert.equal(start.body.error, 'GAME_DISABLED');

  // Re-enable for any later test runs / clarity.
  await request('PATCH', `/api/agencies/${agencyA.id}/break-room-settings`, platformOwnerCookie, { games: { CONGO_LINE: true } });
});

test('a non-Platform-Owner cannot reach Break Room admin routes', async () => {
  const list = await request('GET', '/api/break-room/admin/sessions', producerACookie);
  assert.equal(list.status, 403);
  const settings = await request('PATCH', '/api/break-room/admin/platform-settings', producerACookie, { globalLeaderboardEnabled: true });
  assert.equal(settings.status, 403);
});

test('Super Admin (Platform Owner) can flag/remove a fraudulent-looking session and it drops off the leaderboard', async () => {
  await putOnBreak(producerA.id, agencyA.id);
  const start = await request('POST', '/api/break-room/sessions', producerACookie, { gameType: 'PILL_POP' });
  await sleep(2100);
  await request('POST', `/api/break-room/sessions/${start.body.sessionId}/end`, producerACookie, { score: 5000, metrics: { level: 3, bugsCleared: 20 } });

  const flagged = await request('GET', '/api/break-room/admin/sessions', platformOwnerCookie);
  assert.equal(flagged.status, 200);
  const mySession = flagged.body.sessions.find((s) => s.id === start.body.sessionId);
  assert.ok(mySession);

  const removed = await request('DELETE', `/api/break-room/admin/sessions/${start.body.sessionId}`, platformOwnerCookie, { reason: 'test removal' });
  assert.equal(removed.status, 200);

  const leaderboard = await request('GET', '/api/break-room/leaderboard?gameType=PILL_POP&scope=agency', producerACookie);
  assert.ok(leaderboard.body.rows.every((r) => !(r.userId === producerA.id && r.score === 5000)));
});

test('Super Admin can enable the global leaderboard platform flag', async () => {
  const enable = await request('PATCH', '/api/break-room/admin/platform-settings', platformOwnerCookie, { globalLeaderboardEnabled: true });
  assert.equal(enable.status, 200);
  assert.equal(enable.body.settings.globalLeaderboardEnabled, true);

  const now = await request('GET', '/api/break-room/leaderboard?gameType=CONGO_LINE&scope=global', producerACookie);
  assert.equal(now.status, 200);
});
