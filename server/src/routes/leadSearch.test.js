// Real-database, real-HTTP test for GET /api/leads/search — the new
// agency-wide name/phone/email lookup for a returning prospect.
//
//   node --test src/routes/leadSearch.test.js
//
// Covers: name/phone/email each independently find the right lead; a
// Producer's search returns a lead assigned to a DIFFERENT producer in
// the same agency (the deliberate widening) but never a lead from a
// different agency; an archived (DUPLICATE-dispositioned) lead IS
// returned by search but still excluded from the default GET /leads
// list; a short query returns empty, not an error; PLATFORM_OWNER
// without agencyId 400s; TELEMARKETER 403s; neither this route nor
// GET /:leadId ever mutates assignedToId/status/archivedAt/firstAttemptAt.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, otherAgencyId, ownerId, producerId, producer2Id, telemarketerId, platformOwnerId;
let ownerCookie, producerCookie, producer2Cookie, telemarketerCookie, platformOwnerCookie;
let server, baseUrl;
let targetLead, otherProducerLead, archivedLead, otherAgencyLead;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Lead Search Test Agency ${suffix}` } });
  agencyId = agency.id;
  const otherAgency = await prisma.agency.create({ data: { name: `Lead Search Other Agency ${suffix}` } });
  otherAgencyId = otherAgency.id;

  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `leadsearch-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Search', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const producer = await prisma.user.create({
    data: { email: `leadsearch-producer-${suffix}@test.local`, passwordHash: hash, firstName: 'Search', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerId = producer.id;
  const producer2 = await prisma.user.create({
    data: { email: `leadsearch-producer2-${suffix}@test.local`, passwordHash: hash, firstName: 'Second', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producer2Id = producer2.id;
  const telemarketer = await prisma.user.create({
    data: { email: `leadsearch-tm-${suffix}@test.local`, passwordHash: hash, firstName: 'Search', lastName: 'TM', role: 'TELEMARKETER', status: 'ACTIVE' },
  });
  telemarketerId = telemarketer.id;
  const platformOwner = await prisma.user.create({
    data: { email: `leadsearch-platform-${suffix}@test.local`, passwordHash: hash, firstName: 'Search', lastName: 'Platform', role: 'PLATFORM_OWNER', status: 'ACTIVE' },
  });
  platformOwnerId = platformOwner.id;

  for (const [cookieSetter, userId] of [
    [(c) => (ownerCookie = c), ownerId],
    [(c) => (producerCookie = c), producerId],
    [(c) => (producer2Cookie = c), producer2Id],
    [(c) => (telemarketerCookie = c), telemarketerId],
    [(c) => (platformOwnerCookie = c), platformOwnerId],
  ]) {
    const session = await createSession(userId);
    cookieSetter(`evenflow_session=${session.rawToken}`);
  }

  // targetLead: assigned to producer2, findable by name/phone/email —
  // this is the one producer (assigned to producer, not producer2)
  // searches FOR, to confirm the deliberate cross-producer widening.
  const targetCustomer = await prisma.customer.create({
    data: { firstName: 'Returning', lastName: `Prospect${suffix}`, phoneNormalized: `5551230${String(suffix).slice(-4)}`, email: `returning-prospect-${suffix}@test.local` },
  });
  targetLead = await prisma.lead.create({
    data: { agencyId, customerId: targetCustomer.id, source: 'manual', status: 'LOST', product: 'Auto', createdById: ownerId, assignedToId: producer2Id },
  });
  otherProducerLead = targetLead;

  // archivedLead: dispositioned DUPLICATE, so archivedAt is set — must
  // still be findable via search, but excluded from the default list.
  const archivedCustomer = await prisma.customer.create({
    data: { firstName: 'Archived', lastName: `Record${suffix}`, phoneNormalized: `5559990${String(suffix).slice(-4)}`, email: `archived-record-${suffix}@test.local` },
  });
  archivedLead = await prisma.lead.create({
    data: { agencyId, customerId: archivedCustomer.id, source: 'manual', status: 'DUPLICATE', product: 'Auto', createdById: ownerId, assignedToId: producerId, archivedAt: new Date() },
  });

  // otherAgencyLead: same-ish name, but in a different agency — must
  // never surface in agency-scoped search results.
  const otherAgencyCustomer = await prisma.customer.create({
    data: { firstName: 'CrossTenant', lastName: `Prospect${suffix}`, phoneNormalized: `5558880${String(suffix).slice(-4)}` },
  });
  const otherAgencyOwner = await prisma.user.create({
    data: { email: `leadsearch-other-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Other', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId: otherAgencyId, status: 'ACTIVE' },
  });
  otherAgencyLead = await prisma.lead.create({
    data: { agencyId: otherAgencyId, customerId: otherAgencyCustomer.id, source: 'manual', status: 'NEW', product: 'Auto', createdById: otherAgencyOwner.id, assignedToId: otherAgencyOwner.id },
  });

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.lead.deleteMany({ where: { agencyId: { in: [agencyId, otherAgencyId] } } });
  await prisma.customer.deleteMany({ where: { id: { in: [targetLead.customerId, archivedLead.customerId, otherAgencyLead.customerId] } } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, producerId, producer2Id, telemarketerId, platformOwnerId] } } });
  await prisma.user.deleteMany({ where: { OR: [{ agencyId: { in: [agencyId, otherAgencyId] } }, { id: { in: [telemarketerId, platformOwnerId] } }] } });
  await prisma.agency.deleteMany({ where: { id: { in: [agencyId, otherAgencyId] } } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('search by last name finds the right lead', async () => {
  const res = await fetch(`${baseUrl}/api/leads/search?q=${encodeURIComponent(`Prospect${suffix}`.slice(0, 10))}`, { headers: { Cookie: ownerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.leads.some((l) => l.id === targetLead.id), 'the target lead must be found by last name');
});

test('search by phone finds the right lead', async () => {
  const phone = `5551230${String(suffix).slice(-4)}`;
  const res = await fetch(`${baseUrl}/api/leads/search?q=${encodeURIComponent(phone)}`, { headers: { Cookie: ownerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.leads.some((l) => l.id === targetLead.id), 'the target lead must be found by phone');
});

test('search by email finds the right lead', async () => {
  const res = await fetch(`${baseUrl}/api/leads/search?q=${encodeURIComponent(`returning-prospect-${suffix}@test.local`)}`, { headers: { Cookie: ownerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.leads.some((l) => l.id === targetLead.id), 'the target lead must be found by email');
});

test('a Producer\'s search returns a lead assigned to a DIFFERENT producer in the same agency (deliberate widening)', async () => {
  const res = await fetch(`${baseUrl}/api/leads/search?q=${encodeURIComponent(`Prospect${suffix}`.slice(0, 10))}`, { headers: { Cookie: producerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  const found = body.leads.find((l) => l.id === targetLead.id);
  assert.ok(found, 'a Producer must be able to find a lead assigned to a different producer via search');
  assert.equal(found.assignedTo?.id, producer2Id, 'the result must show the real assigned producer');
  assert.equal(found.status, 'LOST', 'the result must show the real current status');
});

test('a Producer\'s search never returns a lead from a different agency', async () => {
  const res = await fetch(`${baseUrl}/api/leads/search?q=${encodeURIComponent(`Prospect${suffix}`.slice(0, 10))}`, { headers: { Cookie: producerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.leads.some((l) => l.id === otherAgencyLead.id), false, 'a cross-agency lead must never appear, even with a matching name');
});

test('an archived (DUPLICATE) lead IS returned by search, but still excluded from the default GET /leads list', async () => {
  const searchRes = await fetch(`${baseUrl}/api/leads/search?q=${encodeURIComponent(`Record${suffix}`.slice(0, 8))}`, { headers: { Cookie: ownerCookie } });
  assert.equal(searchRes.status, 200);
  const searchBody = await searchRes.json();
  const found = searchBody.leads.find((l) => l.id === archivedLead.id);
  assert.ok(found, 'search must surface archived/closed leads — that is the whole point of this lookup tool');
  assert.ok(found.archivedAt, 'the archivedAt value must be included so the client can badge it');

  const listRes = await fetch(`${baseUrl}/api/leads?pageSize=100`, { headers: { Cookie: ownerCookie } });
  const listBody = await listRes.json();
  assert.equal(listBody.leads.some((l) => l.id === archivedLead.id), false, 'the default list must still exclude archived leads — unchanged, regression check');
});

test('a query under 2 characters returns an empty result, not an error', async () => {
  const res = await fetch(`${baseUrl}/api/leads/search?q=a`, { headers: { Cookie: ownerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.leads, []);
  assert.equal(body.total, 0);
});

test('PLATFORM_OWNER without agencyId gets 400 AGENCY_REQUIRED; with it, results are correctly scoped', async () => {
  const noAgency = await fetch(`${baseUrl}/api/leads/search?q=${encodeURIComponent(`Prospect${suffix}`.slice(0, 10))}`, { headers: { Cookie: platformOwnerCookie } });
  assert.equal(noAgency.status, 400);
  assert.equal((await noAgency.json()).error, 'AGENCY_REQUIRED');

  const withAgency = await fetch(`${baseUrl}/api/leads/search?q=${encodeURIComponent(`Prospect${suffix}`.slice(0, 10))}&agencyId=${agencyId}`, { headers: { Cookie: platformOwnerCookie } });
  assert.equal(withAgency.status, 200);
  const body = await withAgency.json();
  assert.ok(body.leads.some((l) => l.id === targetLead.id));
  assert.equal(body.leads.some((l) => l.id === otherAgencyLead.id), false);
});

test('TELEMARKETER is forbidden from this endpoint', async () => {
  const res = await fetch(`${baseUrl}/api/leads/search?q=${encodeURIComponent(`Prospect${suffix}`.slice(0, 10))}`, { headers: { Cookie: telemarketerCookie } });
  assert.equal(res.status, 403);
});

test('neither GET /leads/search nor GET /:leadId ever mutates assignedToId/status/archivedAt/firstAttemptAt', async () => {
  const before1 = await prisma.lead.findUnique({ where: { id: targetLead.id } });

  await fetch(`${baseUrl}/api/leads/search?q=${encodeURIComponent(`Prospect${suffix}`.slice(0, 10))}`, { headers: { Cookie: producerCookie } });
  // The Producer here isn't the assignee, so a direct GET /:leadId would
  // 403 (existing, unchanged authorizeLeadAccess) — read via the Owner
  // instead, which the search result's own summary data already makes
  // unnecessary in real use, but still a pure-read regression check.
  await fetch(`${baseUrl}/api/leads/${targetLead.id}`, { headers: { Cookie: ownerCookie } });

  const after1 = await prisma.lead.findUnique({ where: { id: targetLead.id } });
  assert.deepEqual(
    { assignedToId: before1.assignedToId, status: before1.status, archivedAt: before1.archivedAt, firstAttemptAt: before1.firstAttemptAt },
    { assignedToId: after1.assignedToId, status: after1.status, archivedAt: after1.archivedAt, firstAttemptAt: after1.firstAttemptAt },
    'finding or opening a lead must never reassign, reactivate, or otherwise mutate it',
  );
});
