// Real-DB, real-HTTP tests for offices.js's new geographic routing fields,
// the alpha-assignments route, isDefaultOffice exclusivity, geography
// conflict detection, and the cascade/cleanup behaviors (office delete,
// producer office change) that lib/leadDistribution.js's two-stage engine
// depends on.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, ownerCookie, producerAId, producerBId, server, baseUrl;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Offices Test Agency ${suffix}` } });
  agencyId = agency.id;
  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `off-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Office', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const session = await createSession(ownerId);
  ownerCookie = `evenflow_session=${session.rawToken}`;

  const producerA = await prisma.user.create({
    data: { email: `off-prod-a-${suffix}@test.local`, passwordHash: hash, firstName: 'Alpha', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerAId = producerA.id;
  const producerB = await prisma.user.create({
    data: { email: `off-prod-b-${suffix}@test.local`, passwordHash: hash, firstName: 'Beta', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerBId = producerB.id;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.officeAlphaAssignment.deleteMany({ where: { office: { agencyId } } });
  await prisma.office.deleteMany({ where: { agencyId } });
  await prisma.session.deleteMany({ where: { userId: ownerId } });
  await prisma.user.deleteMany({ where: { agencyId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function createOffice(name) {
  const res = await fetch(`${baseUrl}/api/offices`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: JSON.stringify({ name }),
  });
  const body = await res.json();
  return body.office;
}

test('PATCH routingCities/routingZipRanges/isDefaultOffice/routingMode persist', async () => {
  const office = await createOffice('Tallahassee');
  const res = await fetch(`${baseUrl}/api/offices/${office.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ routingCities: ['tallahassee', ' Crawfordville '], routingZipRanges: [{ start: '32300', end: '32399' }], isDefaultOffice: true, routingMode: 'ALPHA_SPLIT' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.office.routingCities, ['TALLAHASSEE', 'CRAWFORDVILLE']);
  assert.equal(body.office.isDefaultOffice, true);
  assert.equal(body.office.routingMode, 'ALPHA_SPLIT');
});

test('isDefaultOffice is exclusive — setting it on a second office unsets the first', async () => {
  const officeA = await createOffice('Default A');
  const officeB = await createOffice('Default B');
  await fetch(`${baseUrl}/api/offices/${officeA.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: JSON.stringify({ isDefaultOffice: true }),
  });
  await fetch(`${baseUrl}/api/offices/${officeB.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: JSON.stringify({ isDefaultOffice: true }),
  });
  const refreshedA = await prisma.office.findUnique({ where: { id: officeA.id } });
  const refreshedB = await prisma.office.findUnique({ where: { id: officeB.id } });
  assert.equal(refreshedA.isDefaultOffice, false);
  assert.equal(refreshedB.isDefaultOffice, true);
});

test('a conflicting city/zip range with another office is rejected with 409', async () => {
  const officeA = await createOffice('Conflict A');
  const officeB = await createOffice('Conflict B');
  await fetch(`${baseUrl}/api/offices/${officeA.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ routingCities: ['JACKSONVILLE'], routingZipRanges: [{ start: '32200', end: '32299' }] }),
  });
  const cityConflict = await fetch(`${baseUrl}/api/offices/${officeB.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: JSON.stringify({ routingCities: ['Jacksonville'] }),
  });
  assert.equal(cityConflict.status, 409);

  const zipConflict = await fetch(`${baseUrl}/api/offices/${officeB.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: JSON.stringify({ routingZipRanges: [{ start: '32250', end: '32260' }] }),
  });
  assert.equal(zipConflict.status, 409);
});

test('PUT /:officeId/alpha-assignments requires exactly one fallback and rejects a duplicate letter claim', async () => {
  const office = await createOffice('Alpha Office');
  await prisma.user.updateMany({ where: { id: { in: [producerAId, producerBId] } }, data: { officeId: office.id } });

  const noFallback = await fetch(`${baseUrl}/api/offices/${office.id}/alpha-assignments`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ assignments: [{ userId: producerAId, letters: ['A'] }] }),
  });
  assert.equal(noFallback.status, 400);

  const producerC = await prisma.user.create({
    data: { email: `off-prod-c-${suffix}@test.local`, passwordHash: await bcrypt.hash('TestPass123!', 12), firstName: 'Gamma', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE', officeId: office.id },
  });
  const dupeLetter = await fetch(`${baseUrl}/api/offices/${office.id}/alpha-assignments`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({
      assignments: [
        { userId: producerAId, letters: ['A'] },
        { userId: producerBId, letters: ['A'] },
        { userId: producerC.id, letters: [], isFallback: true },
      ],
    }),
  });
  assert.equal(dupeLetter.status, 400, 'two non-fallback producers must not both claim letter A');
  await prisma.user.delete({ where: { id: producerC.id } });

  const valid = await fetch(`${baseUrl}/api/offices/${office.id}/alpha-assignments`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({
      assignments: [
        { userId: producerAId, letters: ['A', 'B'] },
        { userId: producerBId, letters: [], isFallback: true },
      ],
    }),
  });
  assert.equal(valid.status, 200);
  const validBody = await valid.json();
  assert.equal(validBody.assignments.length, 2);

  await prisma.officeAlphaAssignment.deleteMany({ where: { officeId: office.id } });
  await prisma.user.updateMany({ where: { id: { in: [producerAId, producerBId] } }, data: { officeId: null } });
});

test('a producer not assigned to this office is rejected from its alpha-assignments', async () => {
  const office = await createOffice('Strict Office');
  const res = await fetch(`${baseUrl}/api/offices/${office.id}/alpha-assignments`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ assignments: [{ userId: producerAId, letters: [], isFallback: true }] }),
  });
  assert.equal(res.status, 400);
});

test('deleting an office cascades its alpha assignments and unassigns its producers', async () => {
  const office = await createOffice('Doomed Office');
  await prisma.user.update({ where: { id: producerAId }, data: { officeId: office.id } });
  await fetch(`${baseUrl}/api/offices/${office.id}/alpha-assignments`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ assignments: [{ userId: producerAId, letters: [], isFallback: true }] }),
  });

  const del = await fetch(`${baseUrl}/api/offices/${office.id}`, { method: 'DELETE', headers: { Cookie: ownerCookie } });
  assert.equal(del.status, 200);

  const remainingAssignments = await prisma.officeAlphaAssignment.count({ where: { officeId: office.id } });
  assert.equal(remainingAssignments, 0);
  const producer = await prisma.user.findUnique({ where: { id: producerAId } });
  assert.equal(producer.officeId, null);
});

test('moving a producer to a different office deletes their stale alpha-assignment at the old office', async () => {
  const officeA = await createOffice('Stale Old Office');
  const officeB = await createOffice('New Office');
  await prisma.user.update({ where: { id: producerBId }, data: { officeId: officeA.id } });
  await fetch(`${baseUrl}/api/offices/${officeA.id}/alpha-assignments`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ assignments: [{ userId: producerBId, letters: [], isFallback: true }] }),
  });

  const patchRes = await fetch(`${baseUrl}/api/users/${producerBId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ officeId: officeB.id }),
  });
  assert.equal(patchRes.status, 200);

  const staleAssignment = await prisma.officeAlphaAssignment.findFirst({ where: { officeId: officeA.id, userId: producerBId } });
  assert.equal(staleAssignment, null, 'the stale claim at the old office must be gone once the producer moves');
});
