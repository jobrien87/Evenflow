// Real-database, real-HTTP test for the Manager "My Leads" / "All Leads"
// server-side scope on GET /leads (?assignedToId=) —
//   DATABASE_URL=postgresql://... node --test src/routes/leadManagerScope.test.js
//
// Covers: an AGENCY_MANAGER with no assignedToId param sees the full
// agency-wide list (unchanged default); with ?assignedToId=self they see
// only their own leads; a PRODUCER's assignedToId is always forced to
// themselves regardless of any assignedToId query param (never widened
// by this change).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, managerId, producerId, producer2Id;
let managerCookie, producerCookie;
let server, baseUrl;
let managerLead, producerLead, producer2Lead;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Manager Scope Test Agency ${suffix}` } });
  agencyId = agency.id;
  const hash = await bcrypt.hash('TestPass123!', 12);

  const owner = await prisma.user.create({
    data: { email: `mgrscope-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Scope', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const manager = await prisma.user.create({
    data: { email: `mgrscope-manager-${suffix}@test.local`, passwordHash: hash, firstName: 'Julie', lastName: 'Manager', role: 'AGENCY_MANAGER', agencyId, status: 'ACTIVE' },
  });
  managerId = manager.id;
  const producer = await prisma.user.create({
    data: { email: `mgrscope-producer-${suffix}@test.local`, passwordHash: hash, firstName: 'Scope', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerId = producer.id;
  const producer2 = await prisma.user.create({
    data: { email: `mgrscope-producer2-${suffix}@test.local`, passwordHash: hash, firstName: 'Second', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producer2Id = producer2.id;

  const managerSession = await createSession(managerId);
  managerCookie = `evenflow_session=${managerSession.rawToken}`;
  const producerSession = await createSession(producerId);
  producerCookie = `evenflow_session=${producerSession.rawToken}`;

  const customer1 = await prisma.customer.create({ data: { firstName: 'Mgr', lastName: `Own${suffix}`, phoneNormalized: `mgrown${suffix}` } });
  managerLead = await prisma.lead.create({
    data: { agencyId, customerId: customer1.id, source: 'manual', status: 'NEW', product: 'Auto', createdById: ownerId, assignedToId: managerId },
  });
  const customer2 = await prisma.customer.create({ data: { firstName: 'Prod', lastName: `Own${suffix}`, phoneNormalized: `prodown${suffix}` } });
  producerLead = await prisma.lead.create({
    data: { agencyId, customerId: customer2.id, source: 'manual', status: 'NEW', product: 'Auto', createdById: ownerId, assignedToId: producerId },
  });
  const customer3 = await prisma.customer.create({ data: { firstName: 'Prod2', lastName: `Own${suffix}`, phoneNormalized: `prod2own${suffix}` } });
  producer2Lead = await prisma.lead.create({
    data: { agencyId, customerId: customer3.id, source: 'manual', status: 'NEW', product: 'Auto', createdById: ownerId, assignedToId: producer2Id },
  });

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.customer.deleteMany({ where: { id: { in: [managerLead.customerId, producerLead.customerId, producer2Lead.customerId] } } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, managerId, producerId, producer2Id] } } });
  await prisma.user.deleteMany({ where: { agencyId } });
  await prisma.agency.delete({ where: { id: agencyId } }).catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('a Manager with no assignedToId param sees the full agency-wide list ("All Leads", unchanged default)', async () => {
  const res = await fetch(`${baseUrl}/api/leads?pageSize=100`, { headers: { Cookie: managerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  const ids = body.leads.map((l) => l.id);
  assert.ok(ids.includes(managerLead.id));
  assert.ok(ids.includes(producerLead.id));
  assert.ok(ids.includes(producer2Lead.id));
});

test('a Manager with ?assignedToId=self sees only their own leads ("My Leads", real server-side scope)', async () => {
  const res = await fetch(`${baseUrl}/api/leads?pageSize=100&assignedToId=${managerId}`, { headers: { Cookie: managerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  const ids = body.leads.map((l) => l.id);
  assert.deepEqual(ids, [managerLead.id], 'must contain exactly the Manager\'s own lead, nothing else');
});

test('a Manager with ?assignedToId=<another producer> sees only that producer\'s leads', async () => {
  const res = await fetch(`${baseUrl}/api/leads?pageSize=100&assignedToId=${producerId}`, { headers: { Cookie: managerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  const ids = body.leads.map((l) => l.id);
  assert.deepEqual(ids, [producerLead.id]);
});

test('a PRODUCER\'s assignedToId is always forced to themselves, even with an assignedToId query param trying to widen it', async () => {
  const res = await fetch(`${baseUrl}/api/leads?pageSize=100&assignedToId=${producer2Id}`, { headers: { Cookie: producerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  const ids = body.leads.map((l) => l.id);
  assert.deepEqual(ids, [producerLead.id], 'a Producer must never see another producer\'s leads via this param');
});
