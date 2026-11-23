// Real-DB, real-HTTP tests for PATCH /:agencyId's `ownerPhone` handling
// (same conventions as agencyInvite.test.js) — the one field on this route
// that isn't a real Agency column at all: it updates the CALLING user's own
// User.phone, collected here because Record Store's Boberdoo Partner
// creation requires a phone and this app never otherwise asks for one (see
// recordStoreProvisioning.js's MISSING_PHONE pre-check).
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const { wipeAgencyDemoData } = require('../lib/demoDataSeeder');
const app = require('../app');

const suffix = Date.now();
let server, baseUrl;
let agencyAId, ownerAId, ownerACookie;
let agencyBId, ownerBId, ownerBCookie;
let platformOwnerId, platformOwnerCookie;

before(async () => {
  const agencyA = await prisma.agency.create({ data: { name: `Agency Phone Test A ${suffix}` } });
  agencyAId = agencyA.id;
  const ownerA = await prisma.user.create({
    data: { email: `agy-phone-a-${suffix}@test.local`, passwordHash: await bcrypt.hash('TestPass123!', 12), firstName: 'Ann', lastName: 'OwnerA', role: 'AGENCY_OWNER', status: 'ACTIVE', agencyId: agencyAId },
  });
  ownerAId = ownerA.id;
  ownerACookie = `evenflow_session=${(await createSession(ownerAId)).rawToken}`;

  const agencyB = await prisma.agency.create({ data: { name: `Agency Phone Test B ${suffix}` } });
  agencyBId = agencyB.id;
  const ownerB = await prisma.user.create({
    data: { email: `agy-phone-b-${suffix}@test.local`, passwordHash: await bcrypt.hash('TestPass123!', 12), firstName: 'Bob', lastName: 'OwnerB', role: 'AGENCY_OWNER', status: 'ACTIVE', agencyId: agencyBId },
  });
  ownerBId = ownerB.id;
  ownerBCookie = `evenflow_session=${(await createSession(ownerBId)).rawToken}`;

  const platformOwner = await prisma.user.create({
    data: { email: `agy-phone-po-${suffix}@test.local`, passwordHash: await bcrypt.hash('TestPass123!', 12), firstName: 'Platform', lastName: 'Owner', role: 'PLATFORM_OWNER', status: 'ACTIVE' },
  });
  platformOwnerId = platformOwner.id;
  platformOwnerCookie = `evenflow_session=${(await createSession(platformOwnerId)).rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  try {
    const userIds = [ownerAId, ownerBId, platformOwnerId];
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.agency.deleteMany({ where: { id: { in: [agencyAId, agencyBId] } } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  }
});

async function patchAgency(agencyId, cookie, body) {
  const res = await fetch(`${baseUrl}/api/agencies/${agencyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

test('ownerPhone updates the calling agency owner\'s own User.phone', async () => {
  const { status, data } = await patchAgency(agencyAId, ownerACookie, { ownerPhone: '512-555-0101' });
  assert.equal(status, 200);
  assert.equal(data.success, true);

  const updatedOwner = await prisma.user.findUnique({ where: { id: ownerAId } });
  assert.equal(updatedOwner.phone, '512-555-0101');
});

test('ownerPhone never changes the Agency row itself', async () => {
  const before = await prisma.agency.findUnique({ where: { id: agencyAId } });
  await patchAgency(agencyAId, ownerACookie, { ownerPhone: '512-555-0102' });
  const after = await prisma.agency.findUnique({ where: { id: agencyAId } });
  assert.equal(after.name, before.name);
  assert.equal(after.timezone, before.timezone);
});

test('an agency owner cannot use ownerPhone (or any PATCH) to reach another agency, so another owner\'s phone is unreachable', async () => {
  const { status } = await patchAgency(agencyBId, ownerACookie, { ownerPhone: '512-555-0199' });
  assert.equal(status, 403);

  const ownerB = await prisma.user.findUnique({ where: { id: ownerBId } });
  assert.notEqual(ownerB.phone, '512-555-0199');
});

test('a Platform Owner editing an agency does not have ownerPhone applied to their own account', async () => {
  const { status, data } = await patchAgency(agencyBId, platformOwnerCookie, { ownerPhone: '512-555-0150', name: `Agency Phone Test B Renamed ${suffix}` });
  assert.equal(status, 200);
  assert.equal(data.agency.name, `Agency Phone Test B Renamed ${suffix}`);

  const platformOwnerAfter = await prisma.user.findUnique({ where: { id: platformOwnerId } });
  assert.equal(platformOwnerAfter.phone, null, 'ownerPhone must never be applied to a Platform Owner editing someone else\'s agency');

  const ownerB = await prisma.user.findUnique({ where: { id: ownerBId } });
  assert.notEqual(ownerB.phone, '512-555-0150', 'ownerPhone must also never silently apply to the target agency\'s real owner');
});

test('POST /agencies/demo is Platform-Owner-only, and a created demo agency shows isDemo:true in GET /agencies', async () => {
  const forbiddenRes = await fetch(`${baseUrl}/api/agencies/demo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerACookie },
    body: JSON.stringify({ agencyName: 'Should Not Be Created', owner: { firstName: 'X', lastName: 'Y', email: `blocked-${suffix}@test.local` }, password: 'password123' }),
  });
  assert.equal(forbiddenRes.status, 403);

  const createRes = await fetch(`${baseUrl}/api/agencies/demo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
    body: JSON.stringify({
      agencyName: `Route Demo Agency ${suffix}`,
      owner: { firstName: 'Route', lastName: 'Demo', email: `route-demo-owner-${suffix}@test.local` },
      password: 'password123',
      seedDemoData: false,
    }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.equal(created.password, 'password123');

  try {
    const listRes = await fetch(`${baseUrl}/api/agencies?pageSize=200`, { headers: { Cookie: platformOwnerCookie } });
    const listData = await listRes.json();
    const row = listData.agencies.find((a) => a.id === created.agency.id);
    assert.ok(row);
    assert.equal(row.isDemo, true);
  } finally {
    await prisma.agencySubscription.deleteMany({ where: { agencyId: created.agency.id } });
    await prisma.session.deleteMany({ where: { userId: created.owner.id } });
    await prisma.user.delete({ where: { id: created.owner.id } });
    await prisma.agency.delete({ where: { id: created.agency.id } });
  }
});

async function waitUntil(check, { timeoutMs = 20000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test('POST /agencies/demo responds before seeding finishes, and a reseed attempted immediately after is rejected as already in progress', async () => {
  const createRes = await fetch(`${baseUrl}/api/agencies/demo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
    body: JSON.stringify({
      agencyName: `Route Demo Agency Backgrounded ${suffix}`,
      owner: { firstName: 'Backgrounded', lastName: 'Demo', email: `route-demo-bg-owner-${suffix}@test.local` },
      producers: [{ firstName: 'Backgrounded', lastName: 'Producer', email: `route-demo-bg-producer-${suffix}@test.local` }],
      password: 'password123',
      seedDemoData: true,
      seedOptions: { months: 1, leadsPerDay: 5, transfersPerDay: 1, crossSellCount: 5, winbackCount: 5 },
    }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  // Not awaited server-side — the response comes back before seeding has
  // had any real chance to finish, so it must never claim real counts.
  assert.equal(created.seeded, null);

  try {
    // The fast, transactional part is already done by the time the
    // response lands — no polling needed for this part.
    const agency = await prisma.agency.findUnique({ where: { id: created.agency.id } });
    assert.ok(agency, 'the agency must already exist immediately after the response');
    const owner = await prisma.user.findUnique({ where: { id: created.owner.id } });
    assert.ok(owner, 'the owner must already exist immediately after the response');

    // The background seed was just kicked off — a reseed attempted right
    // now must be rejected rather than racing it.
    const reseedRes = await fetch(`${baseUrl}/api/agencies/${created.agency.id}/demo/reseed`, {
      method: 'POST', headers: { Cookie: platformOwnerCookie },
    });
    assert.equal(reseedRes.status, 409);
    const reseedData = await reseedRes.json();
    assert.equal(reseedData.error, 'RESEED_IN_PROGRESS');

    // The background seed itself must still actually run to completion —
    // confirms this isn't silently dropped, just delayed.
    const seeded = await waitUntil(async () => {
      const snapshot = await prisma.flowScoreSnapshot.findFirst({ where: { subjectType: 'AGENCY', subjectId: created.agency.id } });
      return Boolean(snapshot);
    });
    assert.ok(seeded, 'the background seed must eventually produce a real FlowScoreSnapshot for the agency');

    const leadCount = await prisma.lead.count({ where: { agencyId: created.agency.id } });
    assert.ok(leadCount > 0, 'the background seed must eventually create real leads');
  } finally {
    await wipeAgencyDemoData(created.agency.id);
    await prisma.agencySubscription.deleteMany({ where: { agencyId: created.agency.id } });
    await prisma.session.deleteMany({ where: { userId: { in: [created.owner.id, ...created.producers.map((p) => p.id)] } } });
    await prisma.user.deleteMany({ where: { id: { in: [created.owner.id, ...created.producers.map((p) => p.id)] } } });
    await prisma.agency.delete({ where: { id: created.agency.id } });
  }
});

test('GET /agencies enriches each row with its real active owner (ownerId/ownerName) — the "Log in as" button\'s target — and omits it for an agency with no active owner', async () => {
  const res = await fetch(`${baseUrl}/api/agencies?pageSize=200`, { headers: { Cookie: platformOwnerCookie } });
  assert.equal(res.status, 200);
  const data = await res.json();

  const rowA = data.agencies.find((a) => a.id === agencyAId);
  assert.ok(rowA, 'agency A must appear in the list');
  assert.equal(rowA.ownerId, ownerAId);
  assert.equal(rowA.ownerName, 'Ann OwnerA');

  const noOwnerAgency = await prisma.agency.create({ data: { name: `Agency No Owner Yet ${suffix}` } });
  try {
    const res2 = await fetch(`${baseUrl}/api/agencies?pageSize=200`, { headers: { Cookie: platformOwnerCookie } });
    const data2 = await res2.json();
    const noOwnerRow = data2.agencies.find((a) => a.id === noOwnerAgency.id);
    assert.ok(noOwnerRow, 'an agency with no active owner yet must still appear');
    assert.equal(noOwnerRow.ownerId, null, 'no real active owner exists yet, so there must be nothing to log in as');
    assert.equal(noOwnerRow.ownerName, null);
  } finally {
    await prisma.agency.delete({ where: { id: noOwnerAgency.id } });
  }
});
