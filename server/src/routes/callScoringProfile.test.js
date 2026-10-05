// Real-DB, real-HTTP tests for GET /calls/producer-profile/:userId — the
// Call Scoring per-producer profile backing CallScoringProfilePage.jsx.
// Matches this app's established real-DB/real-HTTP convention (see
// leadAccess.test.js, userAdminActions.test.js) rather than mocking
// Prisma for logic that IS a database query.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyA, agencyB;
let ownerACookie, ownerBCookie, producerACookie;
let producerA;
let callIds = [];
let server, port;

async function makeAgencyAndOwner(label) {
  // coachingEnabled: true — requireSalesStudioAccess (calls.js's gate)
  // 403s with MODULE_NOT_ENTITLED otherwise; a freshly created Agency
  // defaults to not entitled.
  const agency = await prisma.agency.create({ data: { name: `CS Profile Test ${label} ${suffix}`, coachingEnabled: true } });
  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `cs-owner-${label}-${suffix}@test.local`, passwordHash: hash, firstName: label, lastName: 'Owner', role: 'AGENCY_OWNER', agencyId: agency.id, status: 'ACTIVE' },
  });
  const { rawToken } = await createSession(owner.id);
  return { agency, owner, cookie: `evenflow_session=${rawToken}` };
}

before(async () => {
  const a = await makeAgencyAndOwner('A');
  agencyA = a.agency;
  ownerACookie = a.cookie;

  const b = await makeAgencyAndOwner('B');
  agencyB = b.agency;
  ownerBCookie = b.cookie;

  producerA = await prisma.user.create({
    data: { email: `cs-producer-${suffix}@test.local`, firstName: 'Score', lastName: 'Producer', role: 'PRODUCER', status: 'ACTIVE', agencyId: agencyA.id },
  });
  const { rawToken } = await createSession(producerA.id);
  producerACookie = `evenflow_session=${rawToken}`;

  const dimensionSets = [
    { Opening: 85, Rapport: 85, Discovery: 85, 'Needs Analysis': 85, 'Question Quality': 85, 'Objection Handling': 30, Closing: 85, 'Next-Step Clarity': 85, 'Cross-Sell Awareness': 85, Professionalism: 85 },
    { Opening: 80, Rapport: 80, Discovery: 80, 'Needs Analysis': 80, 'Question Quality': 80, 'Objection Handling': 40, Closing: 80, 'Next-Step Clarity': 80, 'Cross-Sell Awareness': 80, Professionalism: 80 },
  ];
  for (const [i, dimensionScores] of dimensionSets.entries()) {
    const call = await prisma.call.create({
      data: {
        agencyId: agencyA.id, uploadedById: producerA.id, filename: `test-${i}.wav`, storageKey: `test/${suffix}-${i}`,
        status: 'COMPLETE', transcript: 'test transcript',
        analysis: {
          create: {
            summary: 'test', productsDiscussed: [], objections: [], buyingSignals: [],
            missedOpportunities: [], crossSellOpportunities: [], followUpCommitments: [],
            nextSteps: [], strengths: ['Great rapport'], coachingOpportunities: ['Handle price objections earlier'],
            overallScore: 75, dimensionScores, reviewRecommended: i === 0,
            managerOverrideScore: i === 1 ? 82 : null,
            aiModel: 'test',
          },
        },
      },
    });
    callIds.push(call.id);
  }

  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  await prisma.callAnalysis.deleteMany({ where: { callId: { in: callIds } } });
  await prisma.call.deleteMany({ where: { id: { in: callIds } } });
  const allUserIds = await prisma.user.findMany({ where: { agencyId: { in: [agencyA.id, agencyB.id] } }, select: { id: true } });
  await prisma.session.deleteMany({ where: { userId: { in: allUserIds.map((u) => u.id) } } });
  await prisma.user.deleteMany({ where: { agencyId: { in: [agencyA.id, agencyB.id] } } });
  await prisma.agency.deleteMany({ where: { id: { in: [agencyA.id, agencyB.id] } } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

function request(method, path, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { Connection: 'close', ...(cookie ? { Cookie: cookie } : {}) } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('an agency owner gets their producer\'s full call-scoring profile: coaching breakdown, recent calls, review/override counts', async () => {
  const res = await request('GET', `/api/calls/producer-profile/${producerA.id}`, ownerACookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, producerA.id);
  assert.equal(res.body.coaching.analyzedCallCount, 2);
  assert.equal(res.body.recentCalls.length, 2);
  assert.equal(res.body.flaggedForReviewCount, 1);
  assert.equal(res.body.managerOverrideCount, 1);
  assert.equal(res.body.scoreTrend.length, 2);
  const withStrength = res.body.recentCalls.find((c) => c.topStrength === 'Great rapport');
  assert.ok(withStrength, 'expected a real per-call strength surfaced, not fabricated');
});

test('a different agency\'s owner is forbidden from viewing this producer\'s profile', async () => {
  const res = await request('GET', `/api/calls/producer-profile/${producerA.id}`, ownerBCookie);
  assert.equal(res.status, 403);
});

test('a producer (not Owner/Manager/Platform Owner) cannot view the Call Scoring profile route at all', async () => {
  const res = await request('GET', `/api/calls/producer-profile/${producerA.id}`, producerACookie);
  assert.equal(res.status, 403);
});

test('a nonexistent user id 404s', async () => {
  const res = await request('GET', '/api/calls/producer-profile/00000000-0000-0000-0000-000000000000', ownerACookie);
  assert.equal(res.status, 404);
});
