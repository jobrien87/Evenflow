// Real-DB, real-HTTP tests for Backstage HR Phase 1 Part C: Scheduling.
// Covers agency-scoped shift CRUD (cross-agency denial, matching the
// Foundation tests' own convention), a shift swap requiring explicit
// manager approval before HrShiftAssignment actually changes, and a
// shift that overlaps an approved leave request producing a warning in
// the response — never a silent block, never a silent double-booking.
// Kept flat at server/src/routes/hrScheduling.test.js per this suite's
// documented npm-test glob gotcha — never nested under src/routes/hr/.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, otherAgencyId;
let ownerId, ownerCookie, managerCookie;
let producerId, producerCookie, producerProfileId;
let coveringUserId, coveringProfileId;
let otherOwnerCookie, otherProfileId;
let server, baseUrl;

before(async () => {
  const hash = await bcrypt.hash('TestPass123!', 12);
  const agency = await prisma.agency.create({ data: { name: `HR Scheduling Test Agency ${suffix}`, hrEnabled: true } });
  agencyId = agency.id;

  const owner = await prisma.user.create({ data: { email: `hrs-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Owner', lastName: 'Sched', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' } });
  ownerId = owner.id;
  ownerCookie = `evenflow_session=${(await createSession(owner.id)).rawToken}`;

  const manager = await prisma.user.create({ data: { email: `hrs-mgr-${suffix}@test.local`, passwordHash: hash, firstName: 'Mgr', lastName: 'Sched', role: 'AGENCY_MANAGER', agencyId, status: 'ACTIVE' } });
  managerCookie = `evenflow_session=${(await createSession(manager.id)).rawToken}`;

  const producer = await prisma.user.create({ data: { email: `hrs-prod-${suffix}@test.local`, passwordHash: hash, firstName: 'Prod', lastName: 'Sched', role: 'PRODUCER', agencyId, status: 'ACTIVE' } });
  producerId = producer.id;
  producerCookie = `evenflow_session=${(await createSession(producerId)).rawToken}`;
  const producerProfile = await prisma.hrEmployeeProfile.create({ data: { userId: producerId, agencyId, workTimeZone: 'America/New_York' } });
  producerProfileId = producerProfile.id;

  const covering = await prisma.user.create({ data: { email: `hrs-cover-${suffix}@test.local`, passwordHash: hash, firstName: 'Cover', lastName: 'Sched', role: 'PRODUCER', agencyId, status: 'ACTIVE' } });
  coveringUserId = covering.id;
  const coveringProfile = await prisma.hrEmployeeProfile.create({ data: { userId: covering.id, agencyId, workTimeZone: 'America/New_York' } });
  coveringProfileId = coveringProfile.id;

  const otherAgency = await prisma.agency.create({ data: { name: `HR Scheduling Other Agency ${suffix}`, hrEnabled: true } });
  otherAgencyId = otherAgency.id;
  const otherOwner = await prisma.user.create({ data: { email: `hrs-other-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Other', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId: otherAgencyId, status: 'ACTIVE' } });
  otherOwnerCookie = `evenflow_session=${(await createSession(otherOwner.id)).rawToken}`;
  const otherUser = await prisma.user.create({ data: { email: `hrs-other-prod-${suffix}@test.local`, passwordHash: hash, firstName: 'Other', lastName: 'Prod', role: 'PRODUCER', agencyId: otherAgencyId, status: 'ACTIVE' } });
  const otherProfile = await prisma.hrEmployeeProfile.create({ data: { userId: otherUser.id, agencyId: otherAgencyId } });
  otherProfileId = otherProfile.id;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.hrShiftSwapRequest.deleteMany({ where: { shiftAssignment: { agencyId: { in: [agencyId, otherAgencyId] } } } });
  await prisma.hrShiftAssignment.deleteMany({ where: { agencyId: { in: [agencyId, otherAgencyId] } } });
  await prisma.hrShiftTemplate.deleteMany({ where: { agencyId: { in: [agencyId, otherAgencyId] } } });
  await prisma.hrLeaveLedgerEntry.deleteMany({ where: { agencyId: { in: [agencyId, otherAgencyId] } } });
  await prisma.hrLeaveRequest.deleteMany({ where: { agencyId: { in: [agencyId, otherAgencyId] } } });
  await prisma.hrLeaveType.deleteMany({ where: { agencyId: { in: [agencyId, otherAgencyId] } } });
  await prisma.hrEmployeeProfile.deleteMany({ where: { agencyId: { in: [agencyId, otherAgencyId] } } });
  await prisma.session.deleteMany({ where: { user: { agencyId: { in: [agencyId, otherAgencyId] } } } });
  await prisma.user.deleteMany({ where: { agencyId: { in: [agencyId, otherAgencyId] } } });
  await prisma.agency.deleteMany({ where: { id: { in: [agencyId, otherAgencyId] } } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function call(path, { method = 'GET', cookie, body } = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

test('shift CRUD is agency-scoped: a manager (no HR grant) can create/update/cancel a shift in their own agency, and a cross-agency owner cannot see or touch it', async () => {
  const createRes = await call('/hr/schedule/shifts', {
    method: 'POST', cookie: managerCookie,
    body: { employeeProfileId: producerProfileId, workDate: '2027-07-05', startTime: '09:00', endTime: '17:00' },
  });
  assert.equal(createRes.status, 201, `manager (no HR grant) can create a shift: ${JSON.stringify(createRes.body)}`);
  const shiftId = createRes.body.shift.id;

  const patchRes = await call(`/hr/schedule/shifts/${shiftId}`, { method: 'PATCH', cookie: managerCookie, body: { notes: 'updated' } });
  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.body.shift.notes, 'updated');

  // Cross-agency denial.
  const crossGet = await call(`/hr/schedule?start=2027-07-01&end=2027-07-10`, { cookie: otherOwnerCookie });
  assert.equal(crossGet.status, 200);
  assert.ok(!crossGet.body.shifts.some((s) => s.id === shiftId), 'a different agency never sees this shift');

  const crossPatch = await call(`/hr/schedule/shifts/${shiftId}`, { method: 'PATCH', cookie: otherOwnerCookie, body: { notes: 'hacked' } });
  assert.equal(crossPatch.status, 404, 'a different agency\'s owner cannot patch this shift');

  const crossCreate = await call('/hr/schedule/shifts', {
    method: 'POST', cookie: otherOwnerCookie,
    body: { employeeProfileId: producerProfileId, workDate: '2027-07-06', startTime: '09:00', endTime: '17:00' },
  });
  assert.equal(crossCreate.status, 404, 'cannot create a shift for an employeeProfileId in a different agency');

  const cancelRes = await call(`/hr/schedule/shifts/${shiftId}`, { method: 'DELETE', cookie: managerCookie });
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.body.shift.status, 'CANCELLED', 'cancel is a soft-cancel (status change), matching this app\'s never-destroy-history convention — not a hard delete');

  const stillThere = await prisma.hrShiftAssignment.findUnique({ where: { id: shiftId } });
  assert.ok(stillThere, 'the row itself still exists after "delete"');
});

test('a plain producer (not a manager, no HR grant) cannot create a shift', async () => {
  const res = await call('/hr/schedule/shifts', {
    method: 'POST', cookie: producerCookie,
    body: { employeeProfileId: producerProfileId, workDate: '2027-07-07', startTime: '09:00', endTime: '17:00' },
  });
  assert.equal(res.status, 403);
});

test('scheduling a shift that overlaps an approved leave request produces a warning, never a silent block or a silent double-booking', async () => {
  const typeRes = await call('/hr/leave/types', { method: 'POST', cookie: ownerCookie, body: { name: `Vacation ${suffix}`, isPaid: true } });
  const leaveTypeId = typeRes.body.leaveType.id;
  await prisma.hrLeaveLedgerEntry.create({ data: { employeeProfileId: producerProfileId, leaveTypeId, agencyId, transactionType: 'GRANT', minutes: 4800, reason: 'test' } });
  const leaveReq = await call('/hr/leave/requests', {
    method: 'POST', cookie: producerCookie,
    body: { leaveTypeId, startDate: '2027-08-10', endDate: '2027-08-10', requestedMinutes: 480 },
  });
  await call(`/hr/leave/requests/${leaveReq.body.leaveRequest.id}/approve`, { method: 'POST', cookie: ownerCookie });

  const shiftRes = await call('/hr/schedule/shifts', {
    method: 'POST', cookie: managerCookie,
    body: { employeeProfileId: producerProfileId, workDate: '2027-08-10', startTime: '09:00', endTime: '17:00' },
  });
  assert.equal(shiftRes.status, 201, 'the shift is still created — never a silent block');
  assert.ok(shiftRes.body.warnings.includes('SHIFT_OVERLAPS_APPROVED_LEAVE'), `warning present: ${JSON.stringify(shiftRes.body.warnings)}`);

  const stored = await prisma.hrShiftAssignment.findUnique({ where: { id: shiftRes.body.shift.id } });
  assert.equal(stored.status, 'SCHEDULED', 'never silently double-booked into some other hidden state — it\'s a normal SCHEDULED shift with a surfaced warning');
});

test('a shift with no leave conflict carries no overlap warning', async () => {
  const res = await call('/hr/schedule/shifts', {
    method: 'POST', cookie: managerCookie,
    body: { employeeProfileId: producerProfileId, workDate: '2027-09-01', startTime: '09:00', endTime: '17:00' },
  });
  assert.equal(res.status, 201);
  assert.ok(!res.body.warnings.includes('SHIFT_OVERLAPS_APPROVED_LEAVE'));
});

test('shift swap: requires explicit manager approval before HrShiftAssignment actually changes — never auto-applied', async () => {
  const shiftRes = await call('/hr/schedule/shifts', {
    method: 'POST', cookie: managerCookie,
    body: { employeeProfileId: producerProfileId, workDate: '2027-10-01', startTime: '09:00', endTime: '17:00' },
  });
  const shiftId = shiftRes.body.shift.id;

  // Only the assigned employee can request a swap on their own shift.
  const wrongRequester = await call(`/hr/schedule/shifts/${shiftId}/swap-request`, { method: 'POST', cookie: managerCookie, body: { proposedCoveringUserId: coveringUserId } });
  assert.equal(wrongRequester.status, 403);

  const swapRes = await call(`/hr/schedule/shifts/${shiftId}/swap-request`, { method: 'POST', cookie: producerCookie, body: { proposedCoveringUserId: coveringUserId, reason: 'sick' } });
  assert.equal(swapRes.status, 201);
  const swapId = swapRes.body.swapRequest.id;
  assert.equal(swapRes.body.swapRequest.status, 'PENDING');

  // Nothing has changed yet — the assignment is still the original employee, still SCHEDULED.
  const beforeApprove = await prisma.hrShiftAssignment.findUnique({ where: { id: shiftId } });
  assert.equal(beforeApprove.employeeProfileId, producerProfileId, 'never auto-applied — the shift is untouched until a manager approves');
  assert.equal(beforeApprove.status, 'SCHEDULED');

  // A plain producer (not a manager/HR_ADMIN) cannot approve.
  const producerApprove = await call(`/hr/schedule/swap-requests/${swapId}/approve`, { method: 'POST', cookie: producerCookie });
  assert.equal(producerApprove.status, 403);

  const approveRes = await call(`/hr/schedule/swap-requests/${swapId}/approve`, { method: 'POST', cookie: managerCookie });
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.body.shift.employeeProfileId, coveringProfileId, 'only now, after explicit approval, does the assignment actually change');
  assert.equal(approveRes.body.shift.status, 'COVERED');

  const afterApprove = await prisma.hrShiftAssignment.findUnique({ where: { id: shiftId } });
  assert.equal(afterApprove.employeeProfileId, coveringProfileId);

  // Re-approving an already-decided swap request must be rejected.
  const reapprove = await call(`/hr/schedule/swap-requests/${swapId}/approve`, { method: 'POST', cookie: managerCookie });
  assert.equal(reapprove.status, 409);
});

test('shift swap deny: leaves the assignment completely untouched', async () => {
  const shiftRes = await call('/hr/schedule/shifts', {
    method: 'POST', cookie: managerCookie,
    body: { employeeProfileId: producerProfileId, workDate: '2027-10-15', startTime: '09:00', endTime: '17:00' },
  });
  const shiftId = shiftRes.body.shift.id;
  const swapRes = await call(`/hr/schedule/shifts/${shiftId}/swap-request`, { method: 'POST', cookie: producerCookie, body: { proposedCoveringUserId: coveringUserId } });
  const swapId = swapRes.body.swapRequest.id;

  const denyRes = await call(`/hr/schedule/swap-requests/${swapId}/deny`, { method: 'POST', cookie: managerCookie });
  assert.equal(denyRes.status, 200);
  assert.equal(denyRes.body.swapRequest.status, 'DENIED');

  const shift = await prisma.hrShiftAssignment.findUnique({ where: { id: shiftId } });
  assert.equal(shift.employeeProfileId, producerProfileId);
  assert.equal(shift.status, 'SCHEDULED');
});

void otherProfileId; // kept for setup symmetry with the other Part C test files
