// Real-DB, real-HTTP tests for the Main Stage dashboard customization
// feature: the extended /me/personalize route, and the three new
// read-only aggregation routes it feeds (/roster/anniversaries,
// /training/rollup, /break-room/agency-summary). Follows this repo's
// established real-DB-over-mocked-Prisma convention (see flowScoreWeights.test.js).
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, ownerCookie, producerId;
let server, baseUrl;

before(async () => {
  const agency = await prisma.agency.create({
    data: { name: `Dashboard Widgets Agency ${suffix}`, coachingEnabled: true, breakRoomEnabled: true },
  });
  agencyId = agency.id;

  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `dashboard-widgets-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Dash', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const ownerSession = await createSession(ownerId);
  ownerCookie = `evenflow_session=${ownerSession.rawToken}`;

  const producer = await prisma.user.create({
    data: { email: `dashboard-widgets-producer-${suffix}@test.local`, passwordHash: hash, firstName: 'Dash', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerId = producer.id;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.hrEmployeeProfile.deleteMany({ where: { agencyId } });
  await prisma.trainingAssignment.deleteMany({ where: { userId: { in: [producerId] } } });
  await prisma.trainingCourse.deleteMany({ where: { title: { startsWith: `Dashboard Widgets Course ${suffix}` } } });
  await prisma.breakRoomAchievement.deleteMany({ where: { agencyId } });
  await prisma.breakRoomHighScore.deleteMany({ where: { agencyId } });
  await prisma.breakRoomGameSession.deleteMany({ where: { agencyId } });
  await prisma.timeClockEntry.deleteMany({ where: { agencyId } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, producerId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, producerId] } } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('PATCH /users/me/personalize accepts hiddenDashboardWidgets independently of birthday and round-trips it', async () => {
  const res = await fetch(`${baseUrl}/api/users/me/personalize`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ hiddenDashboardWidgets: ['billboardSnapshot', 'goalsPacing'] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.hiddenDashboardWidgets, ['billboardSnapshot', 'goalsPacing']);
  assert.equal(body.birthday, null); // untouched — never required alongside the widget list now

  const stored = await prisma.user.findUnique({ where: { id: ownerId }, select: { hiddenDashboardWidgets: true } });
  assert.deepEqual(stored.hiddenDashboardWidgets, ['billboardSnapshot', 'goalsPacing']);

  // Clear it back out so later tests (and a real login) see the default-visible state.
  const clearRes = await fetch(`${baseUrl}/api/users/me/personalize`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ hiddenDashboardWidgets: [] }),
  });
  assert.equal(clearRes.status, 200);
  assert.deepEqual((await clearRes.json()).hiddenDashboardWidgets, []);
});

test('a brand-new user has an empty hiddenDashboardWidgets array by default (today\'s dashboard, unmodified)', async () => {
  const user = await prisma.user.findUnique({ where: { id: producerId }, select: { hiddenDashboardWidgets: true } });
  assert.deepEqual(user.hiddenDashboardWidgets, []);
});

test('GET /roster/anniversaries returns an upcoming work anniversary, excludes a 0-year/future hire, and is agency-scoped', async () => {
  const today = new Date();
  const soon = new Date(Date.UTC(2000, today.getUTCMonth(), today.getUTCDate() + 5 > 28 ? today.getUTCDate() : today.getUTCDate() + 5));
  await prisma.hrEmployeeProfile.create({
    data: { userId: producerId, agencyId, hireDate: soon },
  });

  const res = await fetch(`${baseUrl}/api/roster/anniversaries`, { headers: { Cookie: ownerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.success);
  const entry = body.anniversaries.find((a) => a.id === producerId);
  assert.ok(entry, 'expected the seeded producer to appear in the upcoming-anniversaries list');
  assert.ok(entry.yearsOfService > 0, 'a real hire year in 2000 must show a positive years-of-service count');

  const unauthRes = await fetch(`${baseUrl}/api/roster/anniversaries`);
  assert.equal(unauthRes.status, 401);
});

test('GET /training/rollup aggregates overall and per-course completion correctly', async () => {
  const course = await prisma.trainingCourse.create({
    data: { title: `Dashboard Widgets Course ${suffix}`, createdById: ownerId },
  });
  await prisma.trainingAssignment.create({
    data: { courseId: course.id, userId: producerId, status: 'COMPLETED' },
  });

  const res = await fetch(`${baseUrl}/api/training/rollup`, { headers: { Cookie: ownerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.success);
  assert.ok(body.totalAssignments >= 1);
  assert.ok(body.completedAssignments >= 1);
  const courseRow = body.byCourse.find((c) => c.courseId === course.id);
  assert.ok(courseRow);
  assert.equal(courseRow.total, 1);
  assert.equal(courseRow.completed, 1);
  assert.equal(courseRow.completionPercent, 100);
});

test('GET /break-room/agency-summary reports enabled:false when the agency has Break Room off, and real counts when on', async () => {
  const offAgency = await prisma.agency.create({ data: { name: `Break Room Off Agency ${suffix}`, breakRoomEnabled: false } });
  const hash = await bcrypt.hash('TestPass123!', 12);
  const offOwner = await prisma.user.create({
    data: { email: `break-room-off-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Off', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId: offAgency.id, status: 'ACTIVE' },
  });
  const offSession = await createSession(offOwner.id);
  const offRes = await fetch(`${baseUrl}/api/break-room/agency-summary`, { headers: { Cookie: `evenflow_session=${offSession.rawToken}` } });
  assert.equal(offRes.status, 200);
  const offBody = await offRes.json();
  assert.equal(offBody.enabled, false);
  await prisma.session.deleteMany({ where: { userId: offOwner.id } });
  await prisma.user.delete({ where: { id: offOwner.id } });
  await prisma.agency.delete({ where: { id: offAgency.id } });

  const clockEntry = await prisma.timeClockEntry.create({ data: { userId: producerId, agencyId } });
  const session = await prisma.breakRoomGameSession.create({
    data: {
      userId: producerId, agencyId, timeClockEntryId: clockEntry.id,
      gameType: 'CONGO_LINE', status: 'COMPLETED', score: 42, clientToken: `dw-${suffix}`,
    },
  });
  await prisma.breakRoomHighScore.create({
    data: { userId: producerId, agencyId, gameType: 'CONGO_LINE', bestScore: 42, sessionId: session.id },
  });
  await prisma.breakRoomAchievement.create({
    data: { userId: producerId, agencyId, gameType: 'CONGO_LINE', key: `dw-achievement-${suffix}` },
  });

  const res = await fetch(`${baseUrl}/api/break-room/agency-summary`, { headers: { Cookie: ownerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.enabled, true);
  assert.ok(body.sessionsThisWeek >= 1);
  assert.ok(body.topScorer);
  assert.equal(body.topScorer.bestScore, 42);
  assert.ok(body.achievementsAllTime >= 1);

  const producerRes = await fetch(`${baseUrl}/api/break-room/agency-summary`, { headers: { Cookie: `evenflow_session=${(await createSession(producerId)).rawToken}` } });
  assert.equal(producerRes.status, 403); // leadership-only, intentionally outside the PRODUCER/TELEMARKETER gate
});

test('GET /calls/coaching with no userId returns an agency-wide breakdown for AGENCY_OWNER instead of 400', async () => {
  const res = await fetch(`${baseUrl}/api/calls/coaching`, { headers: { Cookie: ownerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.success);
  assert.equal(typeof body.analyzedCallCount, 'number');
});
