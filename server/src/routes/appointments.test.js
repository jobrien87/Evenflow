// Real-DB, real-HTTP tests for the appointment-to-producer workflow:
// POST /:appointmentId/reassign (atomic Appointment+Task+Lead sync, a
// narrower role check than leads.js's /reassign, never touching
// assignedAt/firstAttemptAt, never calling out to HighLevel) and
// GET /api/appointments (the owner-visible failure/unassigned surface).
// Also covers the HAS_OPEN_APPOINTMENT guard added to leads.js's own
// /:leadId/reassign.
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
let ownerId, producer1Id, producer2Id, inactiveProducerId, otherAgencyProducerId;
let ownerCookie, producer1Cookie;
let vendorId;
let leadIds = [];
let appointmentIds = [];
let taskIds = [];

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Appointment Reassign Test Agency ${suffix}` } });
  agencyId = agency.id;
  const otherAgency = await prisma.agency.create({ data: { name: `Appointment Reassign Other Agency ${suffix}` } });
  otherAgencyId = otherAgency.id;

  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({ data: { email: `ar-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'AR', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' } });
  ownerId = owner.id;
  const producer1 = await prisma.user.create({ data: { email: `ar-p1-${suffix}@test.local`, passwordHash: hash, firstName: 'Prod', lastName: 'One', role: 'PRODUCER', agencyId, status: 'ACTIVE' } });
  producer1Id = producer1.id;
  const producer2 = await prisma.user.create({ data: { email: `ar-p2-${suffix}@test.local`, passwordHash: hash, firstName: 'Prod', lastName: 'Two', role: 'PRODUCER', agencyId, status: 'ACTIVE' } });
  producer2Id = producer2.id;
  const inactive = await prisma.user.create({ data: { email: `ar-inactive-${suffix}@test.local`, passwordHash: hash, firstName: 'In', lastName: 'Active', role: 'PRODUCER', agencyId, status: 'DEACTIVATED' } });
  inactiveProducerId = inactive.id;
  const otherAgencyProducer = await prisma.user.create({ data: { email: `ar-otheragency-${suffix}@test.local`, passwordHash: hash, firstName: 'Other', lastName: 'Agency', role: 'PRODUCER', agencyId: otherAgencyId, status: 'ACTIVE' } });
  otherAgencyProducerId = otherAgencyProducer.id;

  const vendor = await prisma.vendor.create({
    data: { name: 'After Hours Appts', email: 'josh@yield-marketing.com', product: 'General', agencyId, integrationType: 'APPOINTMENT_WEBHOOK', distributionMode: 'SELECTED_AGENTS', selectedAgentIds: [producer1Id] },
  });
  vendorId = vendor.id;

  ownerCookie = `evenflow_session=${(await createSession(ownerId)).rawToken}`;
  producer1Cookie = `evenflow_session=${(await createSession(producer1Id)).rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.leadEvent.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.auditEvent.deleteMany({ where: { entityId: { in: appointmentIds } } });
  await prisma.appointment.deleteMany({ where: { id: { in: appointmentIds } } });
  await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.vendor.delete({ where: { id: vendorId } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, producer1Id] } } });
  await prisma.user.deleteMany({ where: { agencyId: { in: [agencyId, otherAgencyId] } } });
  await prisma.agency.deleteMany({ where: { id: { in: [agencyId, otherAgencyId] } } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function makeAppointment({ assignedToId, status = 'SCHEDULED' } = {}) {
  const assignedAt = new Date('2026-01-01T12:00:00Z');
  const firstAttemptAt = new Date('2026-01-01T12:05:00Z');
  const lead = await prisma.lead.create({
    data: { agencyId, source: 'vendor:After Hours Appts', vendorId, status: 'APPOINTMENT', assignedToId, assignedAt, firstAttemptAt, createdById: ownerId, leadType: 'AI_APPOINTMENT' },
  });
  leadIds.push(lead.id);
  const task = await prisma.task.create({
    data: { agencyId, leadId: lead.id, type: 'APPOINTMENT', title: 'Test appointment', assignedToId, status: 'OPEN' },
  });
  taskIds.push(task.id);
  const appointment = await prisma.appointment.create({
    data: {
      agencyId, leadId: lead.id, vendorId, taskId: task.id,
      providerLocationId: 'loc', providerCalendarId: 'cal', providerBookingId: `appt-${Date.now()}-${Math.random()}`,
      startAt: new Date('2026-03-01T14:00:00Z'), endAt: new Date('2026-03-01T14:30:00Z'),
      status, assignedToId,
    },
  });
  appointmentIds.push(appointment.id);
  return { lead, task, appointment };
}

test('an Owner can reassign an appointment; Task and Lead assignment flip atomically; assignedAt/firstAttemptAt untouched', async () => {
  const { lead, task, appointment } = await makeAppointment({ assignedToId: producer1Id });

  const res = await fetch(`${baseUrl}/api/appointments/${appointment.id}/reassign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ assignedToId: producer2Id }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.appointment.assignedToId, producer2Id);
  assert.deepEqual(body.warnings.length, 2, 'the response must carry both the host-unchanged and availability-not-verified caveats');
  assert.match(body.warnings.join(' '), /HighLevel calendar host is unchanged/i);
  assert.match(body.warnings.join(' '), /[Aa]vailability has not been verified/);

  const updatedTask = await prisma.task.findUnique({ where: { id: task.id } });
  assert.equal(updatedTask.assignedToId, producer2Id, 'Task.assignedToId must move in lockstep');

  const updatedLead = await prisma.lead.findUnique({ where: { id: lead.id } });
  assert.equal(updatedLead.assignedToId, producer2Id, 'Lead.assignedToId must move in lockstep');
  assert.equal(updatedLead.assignedAt.getTime(), lead.assignedAt.getTime(), 'assignedAt must never change on reassignment');
  assert.equal(updatedLead.firstAttemptAt.getTime(), lead.firstAttemptAt.getTime(), 'firstAttemptAt must never change on reassignment');

  const updatedAppointment = await prisma.appointment.findUnique({ where: { id: appointment.id } });
  assert.equal(updatedAppointment.hostUserId, null, 'reassignment must never write hostUserId — the HighLevel host is never touched by this route');

  const auditRow = await prisma.auditEvent.findFirst({ where: { entityId: appointment.id, action: 'appointment.reassigned' } });
  assert.ok(auditRow, 'a real audit entry must record previous/new assignee and actor');
  assert.equal(auditRow.before.assignedToId, producer1Id);
  assert.equal(auditRow.after.assignedToId, producer2Id);
  assert.equal(auditRow.actorId, ownerId);

  const leadEvent = await prisma.leadEvent.findFirst({ where: { leadId: lead.id, type: 'lead.appointment_reassigned' } });
  assert.ok(leadEvent);
  assert.equal(leadEvent.metadata.fromAssigneeId, producer1Id);
  assert.equal(leadEvent.metadata.toAssigneeId, producer2Id);
});

test('a PRODUCER cannot reassign an appointment at all, even one assigned to themselves — narrower than leads.js authorizeLeadAccess', async () => {
  const { appointment } = await makeAppointment({ assignedToId: producer1Id });
  const res = await fetch(`${baseUrl}/api/appointments/${appointment.id}/reassign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: producer1Cookie },
    body: JSON.stringify({ assignedToId: producer2Id }),
  });
  assert.equal(res.status, 403);
});

test('rejects reassigning to an inactive user, a different-agency user, or the same assignee', async () => {
  const { appointment } = await makeAppointment({ assignedToId: producer1Id });

  const inactiveRes = await fetch(`${baseUrl}/api/appointments/${appointment.id}/reassign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ assignedToId: inactiveProducerId }),
  });
  assert.equal(inactiveRes.status, 400);
  assert.equal((await inactiveRes.json()).error, 'INVALID_ASSIGNEE');

  const crossAgencyRes = await fetch(`${baseUrl}/api/appointments/${appointment.id}/reassign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ assignedToId: otherAgencyProducerId }),
  });
  assert.equal(crossAgencyRes.status, 400);
  assert.equal((await crossAgencyRes.json()).error, 'INVALID_ASSIGNEE');

  const sameRes = await fetch(`${baseUrl}/api/appointments/${appointment.id}/reassign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ assignedToId: producer1Id }),
  });
  assert.equal(sameRes.status, 400);
});

test('the atomic updateMany guard rejects a stale previousAssigneeId at the database level (the real concurrency protection)', async () => {
  const { appointment } = await makeAppointment({ assignedToId: producer1Id });
  // Simulate a second request winning the race first.
  await prisma.appointment.update({ where: { id: appointment.id }, data: { assignedToId: producer2Id } });

  const staleAttempt = await prisma.appointment.updateMany({
    where: { id: appointment.id, assignedToId: producer1Id },
    data: { assignedToId: inactiveProducerId },
  });
  assert.equal(staleAttempt.count, 0, 'the same where-clause guard the route uses must affect zero rows once the assignee has already changed');
});

test('GET /api/appointments surfaces unassigned and NEEDS_ATTENTION appointments to the owner', async () => {
  const { appointment } = await makeAppointment({ assignedToId: null });
  await prisma.appointment.update({ where: { id: appointment.id }, data: { syncStatus: 'NEEDS_ATTENTION', syncIssue: 'NO_ELIGIBLE_ASSIGNEE' } });

  const res = await fetch(`${baseUrl}/api/appointments?unassigned=true`, { headers: { Cookie: ownerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.appointments.some((a) => a.id === appointment.id), 'the unassigned appointment must appear in the filtered list');

  const syncRes = await fetch(`${baseUrl}/api/appointments?syncStatus=NEEDS_ATTENTION`, { headers: { Cookie: ownerCookie } });
  const syncBody = await syncRes.json();
  assert.ok(syncBody.appointments.some((a) => a.id === appointment.id));
});

test('leads.js /:leadId/reassign refuses a lead with an open appointment, pointing at the appointment-specific route', async () => {
  const { lead } = await makeAppointment({ assignedToId: producer1Id });
  const res = await fetch(`${baseUrl}/api/leads/${lead.id}/reassign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ assignedToId: producer2Id }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'HAS_OPEN_APPOINTMENT');
  assert.ok(body.appointmentId);
});

test('leads.js /:leadId/reassign works normally once the appointment is CANCELLED/COMPLETED', async () => {
  const { lead, appointment } = await makeAppointment({ assignedToId: producer1Id, status: 'CANCELLED' });
  const res = await fetch(`${baseUrl}/api/leads/${lead.id}/reassign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ assignedToId: producer2Id }),
  });
  assert.equal(res.status, 200, `expected the generic reassign to succeed once the appointment (${appointment.id}) is terminal`);
});
