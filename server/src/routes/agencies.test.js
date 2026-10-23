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
