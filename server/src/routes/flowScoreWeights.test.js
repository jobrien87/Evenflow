// Real-DB, real-HTTP test for the "Flow Settings" feature: an Agency
// Owner/Manager can see and adjust the weighted components behind Flow
// Score for their own agency (Agency + Producer), while Telemarketer
// weights stay platform-wide/read-only, and no agency can ever see or
// change another agency's weights.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyAId, agencyBId, ownerAId, ownerBId, producerAId, ownerACookie, ownerBCookie, producerACookie;
let server, baseUrl;

async function makeAgencyWithOwner(name, role = 'AGENCY_OWNER') {
  const agency = await prisma.agency.create({ data: { name } });
  const hash = await bcrypt.hash('TestPass123!', 12);
  const user = await prisma.user.create({
    data: { email: `${name.replace(/\s+/g, '-').toLowerCase()}@test.local`, passwordHash: hash, firstName: 'Test', lastName: role, role, agencyId: agency.id, status: 'ACTIVE' },
  });
  const session = await createSession(user.id);
  return { agencyId: agency.id, userId: user.id, cookie: `evenflow_session=${session.rawToken}` };
}

before(async () => {
  const a = await makeAgencyWithOwner(`Flow Weights Agency A ${suffix}`);
  agencyAId = a.agencyId; ownerAId = a.userId; ownerACookie = a.cookie;

  const b = await makeAgencyWithOwner(`Flow Weights Agency B ${suffix}`);
  agencyBId = b.agencyId; ownerBId = b.userId; ownerBCookie = b.cookie;

  const hash = await bcrypt.hash('TestPass123!', 12);
  const producer = await prisma.user.create({
    data: { email: `flow-weights-producer-${suffix}@test.local`, passwordHash: hash, firstName: 'Test', lastName: 'Producer', role: 'PRODUCER', agencyId: agencyAId, status: 'ACTIVE' },
  });
  producerAId = producer.id;
  const producerSession = await createSession(producerAId);
  producerACookie = `evenflow_session=${producerSession.rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.flowScoreWeightConfig.deleteMany({ where: { agencyId: { in: [agencyAId, agencyBId] } } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerAId, ownerBId, producerAId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerAId, ownerBId, producerAId] } } });
  await prisma.agency.deleteMany({ where: { id: { in: [agencyAId, agencyBId] } } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('GET /flow-score/weights/:agencyId returns Agency + Producer (editable) and Telemarketer (read-only) with today\'s real defaults', async () => {
  const res = await fetch(`${baseUrl}/api/flow-score/weights/${agencyAId}`, { headers: { Cookie: ownerACookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.success);
  assert.equal(body.configs.AGENCY.editable, true);
  assert.equal(body.configs.PRODUCER.editable, true);
  assert.equal(body.configs.TELEMARKETER.editable, false);
  assert.deepEqual(body.configs.AGENCY.weights, { responseSpeed: 20, funnelHealth: 45, teamCallQuality: 35 });
  assert.deepEqual(body.configs.PRODUCER.weights, { responsiveness: 25, pipelineDiscipline: 20, conversion: 35, callQuality: 20 });
  assert.deepEqual(body.configs.TELEMARKETER.weights, { leadQuality: 50, downstreamQuality: 50 });
});

test('a Producer cannot read or write Flow Settings weights (403)', async () => {
  const getRes = await fetch(`${baseUrl}/api/flow-score/weights/${agencyAId}`, { headers: { Cookie: producerACookie } });
  assert.equal(getRes.status, 403);
  const patchRes = await fetch(`${baseUrl}/api/flow-score/weights/${agencyAId}/AGENCY`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: producerACookie },
    body: JSON.stringify({ weights: { responseSpeed: 50, funnelHealth: 30, teamCallQuality: 20 } }),
  });
  assert.equal(patchRes.status, 403);
});

test('an Agency Owner can never read or write a different agency\'s weights (cross-tenant isolation)', async () => {
  const getRes = await fetch(`${baseUrl}/api/flow-score/weights/${agencyBId}`, { headers: { Cookie: ownerACookie } });
  assert.equal(getRes.status, 403);
  const patchRes = await fetch(`${baseUrl}/api/flow-score/weights/${agencyBId}/AGENCY`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerACookie },
    body: JSON.stringify({ weights: { responseSpeed: 50, funnelHealth: 30, teamCallQuality: 20 } }),
  });
  assert.equal(patchRes.status, 403);
});

test('PATCH rejects the TELEMARKETER role (platform-wide, not agency-editable)', async () => {
  const res = await fetch(`${baseUrl}/api/flow-score/weights/${agencyAId}/TELEMARKETER`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerACookie },
    body: JSON.stringify({ weights: { leadQuality: 60, downstreamQuality: 40 } }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'NOT_EDITABLE');
});

test('PATCH rejects weights that don\'t sum to 100', async () => {
  const res = await fetch(`${baseUrl}/api/flow-score/weights/${agencyAId}/AGENCY`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerACookie },
    body: JSON.stringify({ weights: { responseSpeed: 50, funnelHealth: 30, teamCallQuality: 30 } }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'VALIDATION');
});

test('PATCH rejects a missing/extra component key', async () => {
  const res = await fetch(`${baseUrl}/api/flow-score/weights/${agencyAId}/AGENCY`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerACookie },
    body: JSON.stringify({ weights: { responseSpeed: 50, funnelHealth: 50 } }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'VALIDATION');
});

test('a valid PATCH updates this agency\'s weights, bumps the version, and never touches a different agency\'s config', async () => {
  const patchRes = await fetch(`${baseUrl}/api/flow-score/weights/${agencyAId}/AGENCY`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerACookie },
    body: JSON.stringify({ weights: { responseSpeed: 10, funnelHealth: 60, teamCallQuality: 30 } }),
  });
  assert.equal(patchRes.status, 200);
  const patchBody = await patchRes.json();
  assert.deepEqual(patchBody.config.weights, { responseSpeed: 10, funnelHealth: 60, teamCallQuality: 30 });
  assert.equal(patchBody.config.version, 2);

  const getRes = await fetch(`${baseUrl}/api/flow-score/weights/${agencyAId}`, { headers: { Cookie: ownerACookie } });
  const getBody = await getRes.json();
  assert.deepEqual(getBody.configs.AGENCY.weights, { responseSpeed: 10, funnelHealth: 60, teamCallQuality: 30 });
  assert.equal(getBody.configs.AGENCY.version, 2);
  // Producer weights for this same agency are completely unaffected.
  assert.deepEqual(getBody.configs.PRODUCER.weights, { responsiveness: 25, pipelineDiscipline: 20, conversion: 35, callQuality: 20 });

  // Agency B (never customized) still sees the untouched platform default.
  const bRes = await fetch(`${baseUrl}/api/flow-score/weights/${agencyBId}`, { headers: { Cookie: ownerBCookie } });
  const bBody = await bRes.json();
  assert.deepEqual(bBody.configs.AGENCY.weights, { responseSpeed: 20, funnelHealth: 45, teamCallQuality: 35 });
  assert.equal(bBody.configs.AGENCY.version, 1);

  // Exactly one active row exists for Agency A's AGENCY config — the old
  // version was deactivated, not left dangling as a second active row.
  const activeRows = await prisma.flowScoreWeightConfig.findMany({ where: { role: 'AGENCY', agencyId: agencyAId, isActive: true } });
  assert.equal(activeRows.length, 1);
  assert.equal(activeRows[0].version, 2);
});

test('an audit event is recorded for the weight change', async () => {
  const events = await prisma.auditEvent.findMany({ where: { agencyId: agencyAId, action: 'flow_score.weights_updated' } });
  assert.ok(events.length >= 1);
  assert.equal(events[0].actorId, ownerAId);
});
