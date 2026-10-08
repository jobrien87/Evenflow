// Real-DB, real-HTTP tests for item 8 of the production-correction round:
// POST /:leadId/reassign — hand an already-assigned lead to a different
// eligible active LSP in the same agency, without ever touching
// assignedAt/firstAttemptAt (so reassignment can't restart the SLA clock).
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, otherAgencyId, server, baseUrl;
let ownerId, producer1Id, producer2Id, managerId, inactiveProducerId, otherAgencyProducerId;
let ownerCookie, producer1Cookie, producer2Cookie;
let leadIds = [];

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Reassign Test Agency ${suffix}` } });
  agencyId = agency.id;
  const otherAgency = await prisma.agency.create({ data: { name: `Reassign Other Agency ${suffix}` } });
  otherAgencyId = otherAgency.id;

  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `reassign-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Reassign', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const producer1 = await prisma.user.create({
    data: { email: `reassign-p1-${suffix}@test.local`, passwordHash: hash, firstName: 'Prod', lastName: 'One', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producer1Id = producer1.id;
  const producer2 = await prisma.user.create({
    data: { email: `reassign-p2-${suffix}@test.local`, passwordHash: hash, firstName: 'Prod', lastName: 'Two', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producer2Id = producer2.id;
  const manager = await prisma.user.create({
    data: { email: `reassign-mgr-${suffix}@test.local`, passwordHash: hash, firstName: 'Mgr', lastName: 'Selling', role: 'AGENCY_MANAGER', agencyId, status: 'ACTIVE' },
  });
  managerId = manager.id;
  const inactive = await prisma.user.create({
    data: { email: `reassign-inactive-${suffix}@test.local`, passwordHash: hash, firstName: 'In', lastName: 'Active', role: 'PRODUCER', agencyId, status: 'DEACTIVATED' },
  });
  inactiveProducerId = inactive.id;
  const otherAgencyProducer = await prisma.user.create({
    data: { email: `reassign-otheragency-${suffix}@test.local`, passwordHash: hash, firstName: 'Other', lastName: 'Agency', role: 'PRODUCER', agencyId: otherAgencyId, status: 'ACTIVE' },
  });
  otherAgencyProducerId = otherAgencyProducer.id;

  ownerCookie = `evenflow_session=${(await createSession(ownerId)).rawToken}`;
  producer1Cookie = `evenflow_session=${(await createSession(producer1Id)).rawToken}`;
  producer2Cookie = `evenflow_session=${(await createSession(producer2Id)).rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.leadEvent.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, producer1Id, producer2Id] } } });
  await prisma.user.deleteMany({ where: { agencyId: { in: [agencyId, otherAgencyId] } } });
  await prisma.agency.deleteMany({ where: { id: { in: [agencyId, otherAgencyId] } } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function makeAssignedLead(assignedToId) {
  const assignedAt = new Date('2026-01-01T12:00:00Z');
  const firstAttemptAt = new Date('2026-01-01T12:05:00Z');
  const lead = await prisma.lead.create({
    data: { agencyId, source: 'manual', status: 'CONTACTED', assignedToId, assignedAt, firstAttemptAt, createdById: ownerId },
  });
  leadIds.push(lead.id);
  return lead;
}

test('an Owner can reassign an already-assigned lead; assignedAt/firstAttemptAt are never touched', async () => {
  const lead = await makeAssignedLead(producer1Id);

  const res = await fetch(`${baseUrl}/api/leads/${lead.id}/reassign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ assignedToId: producer2Id }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.lead.assignedToId, producer2Id);
  assert.equal(new Date(body.lead.assignedAt).getTime(), lead.assignedAt.getTime(), 'assignedAt must never change on reassignment');
  assert.equal(new Date(body.lead.firstAttemptAt).getTime(), lead.firstAttemptAt.getTime(), 'firstAttemptAt must never change on reassignment — reassignment cannot restart the SLA clock');

  const event = await prisma.leadEvent.findFirst({ where: { leadId: lead.id, type: 'lead.reassigned' } });
  assert.ok(event, 'a lead.reassigned LeadEvent must be recorded');
  assert.equal(event.metadata.fromAssigneeId, producer1Id);
  assert.equal(event.metadata.toAssigneeId, producer2Id);
  assert.equal(event.metadata.reassignedById, ownerId);

  const audit = await prisma.auditEvent.findFirst({ where: { entityId: lead.id, action: 'lead.reassigned' } });
  assert.ok(audit, 'a real audit entry must be recorded with old/new assignee and actor/timestamp');
  assert.equal(audit.actorId, ownerId);
});

test('an AGENCY_MANAGER (selling, e.g. Julie-style) is a valid reassignment target', async () => {
  const lead = await makeAssignedLead(producer1Id);
  const res = await fetch(`${baseUrl}/api/leads/${lead.id}/reassign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ assignedToId: managerId }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.lead.assignedToId, managerId);
});

test('a PRODUCER can reassign a lead actually assigned to them', async () => {
  const lead = await makeAssignedLead(producer1Id);
  const res = await fetch(`${baseUrl}/api/leads/${lead.id}/reassign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: producer1Cookie },
    body: JSON.stringify({ assignedToId: producer2Id }),
  });
  assert.equal(res.status, 200);
});

test('a PRODUCER cannot reassign a lead not assigned to them', async () => {
  const lead = await makeAssignedLead(producer2Id);
  const res = await fetch(`${baseUrl}/api/leads/${lead.id}/reassign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: producer1Cookie },
    body: JSON.stringify({ assignedToId: producer1Id }),
  });
  assert.equal(res.status, 403);
});

test('rejects reassigning to an inactive user, a different-agency user, or the same assignee', async () => {
  const lead = await makeAssignedLead(producer1Id);

  const inactiveRes = await fetch(`${baseUrl}/api/leads/${lead.id}/reassign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ assignedToId: inactiveProducerId }),
  });
  assert.equal(inactiveRes.status, 400);
  assert.equal((await inactiveRes.json()).error, 'INVALID_ASSIGNEE');

  const crossAgencyRes = await fetch(`${baseUrl}/api/leads/${lead.id}/reassign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ assignedToId: otherAgencyProducerId }),
  });
  assert.equal(crossAgencyRes.status, 400);
  assert.equal((await crossAgencyRes.json()).error, 'INVALID_ASSIGNEE');

  const sameAssigneeRes = await fetch(`${baseUrl}/api/leads/${lead.id}/reassign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ assignedToId: producer1Id }),
  });
  assert.equal(sameAssigneeRes.status, 400);
});

test('rejects reassigning an unassigned lead — claim is the right action there', async () => {
  const lead = await prisma.lead.create({ data: { agencyId, source: 'manual', status: 'NEW', createdById: ownerId } });
  leadIds.push(lead.id);
  const res = await fetch(`${baseUrl}/api/leads/${lead.id}/reassign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ assignedToId: producer1Id }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'NOT_ASSIGNED');
});

test('the atomic updateMany guard rejects a stale previousAssigneeId at the database level (the real concurrency protection the route relies on)', async () => {
  const lead = await makeAssignedLead(producer1Id);

  // Simulate a second request having already won the race and reassigned
  // the lead out from under a first request that read producer1Id as
  // "current" a moment earlier.
  await prisma.lead.update({ where: { id: lead.id }, data: { assignedToId: producer2Id } });

  const staleAttempt = await prisma.lead.updateMany({
    where: { id: lead.id, assignedToId: producer1Id },
    data: { assignedToId: managerId },
  });
  assert.equal(staleAttempt.count, 0, 'the same where-clause guard the route uses must affect zero rows once the assignee has already changed — this is what produces the route\'s 409 ALREADY_REASSIGNED');

  const fresh = await prisma.lead.findUnique({ where: { id: lead.id } });
  assert.equal(fresh.assignedToId, producer2Id, 'the lead must still show the real winner\'s assignee, untouched by the stale attempt');
});

