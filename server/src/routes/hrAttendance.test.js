// Real-DB, real-HTTP tests for Backstage HR Phase 1 Part B (Time &
// Attendance): the timesheet compute/submit/approve/reject route flow,
// live-status, the attendance-exception detection job + its
// human-review-only resolution, and cross-agency denial.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');
const { detectMissedPunches } = require('../jobs/hrAttendanceDetection');

const suffix = Date.now();
let agencyId, otherAgencyId, ownerId, ownerCookie, producerId, producerCookie, employeeProfileId, otherAgencyEmployeeProfileId;
let server, baseUrl;

before(async () => {
  const hash = await bcrypt.hash('TestPass123!', 12);
  const agency = await prisma.agency.create({ data: { name: `HR Attendance Test Agency ${suffix}`, hrEnabled: true } });
  agencyId = agency.id;
  const owner = await prisma.user.create({
    data: { email: `hra-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Owner', lastName: 'HRA', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  ownerCookie = `evenflow_session=${(await createSession(owner.id)).rawToken}`;
  const producer = await prisma.user.create({
    data: { email: `hra-prod-${suffix}@test.local`, passwordHash: hash, firstName: 'Prod', lastName: 'HRA', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerId = producer.id;
  producerCookie = `evenflow_session=${(await createSession(producerId)).rawToken}`;
  const profile = await prisma.hrEmployeeProfile.create({ data: { userId: producerId, agencyId } });
  employeeProfileId = profile.id;

  const otherAgency = await prisma.agency.create({ data: { name: `HR Attendance Other Agency ${suffix}`, hrEnabled: true } });
  otherAgencyId = otherAgency.id;
  const otherUser = await prisma.user.create({
    data: { email: `hra-other-${suffix}@test.local`, passwordHash: hash, firstName: 'Other', lastName: 'Agency', role: 'PRODUCER', agencyId: otherAgencyId, status: 'ACTIVE' },
  });
  const otherProfile = await prisma.hrEmployeeProfile.create({ data: { userId: otherUser.id, agencyId: otherAgencyId } });
  otherAgencyEmployeeProfileId = otherProfile.id;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.hrAttendanceException.deleteMany({ where: { agencyId: { in: [agencyId, otherAgencyId] } } });
  await prisma.hrTimesheetSegment.deleteMany({ where: { timesheet: { agencyId: { in: [agencyId, otherAgencyId] } } } });
  await prisma.hrTimesheet.deleteMany({ where: { agencyId: { in: [agencyId, otherAgencyId] } } });
  await prisma.timeClockEntry.deleteMany({ where: { agencyId: { in: [agencyId, otherAgencyId] } } });
  await prisma.hrEmployeeProfile.deleteMany({ where: { agencyId: { in: [agencyId, otherAgencyId] } } });
  await prisma.session.deleteMany({ where: { user: { agencyId: { in: [agencyId, otherAgencyId] } } } });
  await prisma.user.deleteMany({ where: { agencyId: { in: [agencyId, otherAgencyId] } } });
  await prisma.agency.deleteMany({ where: { id: { in: [agencyId, otherAgencyId] } } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

function dayRange(offsetStart, offsetEnd) {
  const start = new Date();
  start.setDate(start.getDate() + offsetStart);
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setDate(end.getDate() + offsetEnd);
  end.setHours(0, 0, 0, 0);
  return { start, end };
}

test('POST /hr/timesheets/compute computes a real timesheet matching hand-calc, and a cross-agency employeeProfileId 404s', async () => {
  const now = new Date();
  const clockIn = new Date(now); clockIn.setHours(9, 0, 0, 0);
  const clockOut = new Date(now); clockOut.setHours(17, 0, 0, 0);
  await prisma.timeClockEntry.create({ data: { userId: producerId, agencyId, clockInAt: clockIn, clockOutAt: clockOut } });

  const { start, end } = dayRange(-1, 1);
  const res = await fetch(`${baseUrl}/api/hr/timesheets/compute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ employeeProfileId, periodStart: start.toISOString(), periodEnd: end.toISOString() }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.timesheet.regularMinutes, 480);
  assert.equal(body.timesheet.status, 'OPEN');
  assert.equal(body.timesheet.segments.length, 1);

  const crossAgency = await fetch(`${baseUrl}/api/hr/timesheets/compute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ employeeProfileId: otherAgencyEmployeeProfileId, periodStart: start.toISOString(), periodEnd: end.toISOString() }),
  });
  assert.equal(crossAgency.status, 404);
});

test('timesheet submit/approve flow: only the owning employee can submit, only HR_ADMIN can approve a SUBMITTED timesheet, and state transitions are enforced', async () => {
  const { start, end } = dayRange(-3, -2); // a fresh, unused period
  const computeRes = await fetch(`${baseUrl}/api/hr/timesheets/compute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ employeeProfileId, periodStart: start.toISOString(), periodEnd: end.toISOString() }),
  });
  const timesheetId = (await computeRes.json()).timesheet.id;

  // The owner (not the employee) cannot submit someone else's timesheet.
  const wrongSubmitter = await fetch(`${baseUrl}/api/hr/timesheets/${timesheetId}/submit`, { method: 'POST', headers: { Cookie: ownerCookie } });
  assert.equal(wrongSubmitter.status, 403);

  // Approving before it's SUBMITTED must be rejected.
  const tooEarly = await fetch(`${baseUrl}/api/hr/timesheets/${timesheetId}/approve`, { method: 'POST', headers: { Cookie: ownerCookie } });
  assert.equal(tooEarly.status, 409);

  const submitRes = await fetch(`${baseUrl}/api/hr/timesheets/${timesheetId}/submit`, { method: 'POST', headers: { Cookie: producerCookie } });
  assert.equal(submitRes.status, 200);
  assert.equal((await submitRes.json()).timesheet.status, 'SUBMITTED');

  // A plain producer (no HR grant) cannot approve.
  const producerApprove = await fetch(`${baseUrl}/api/hr/timesheets/${timesheetId}/approve`, { method: 'POST', headers: { Cookie: producerCookie } });
  assert.equal(producerApprove.status, 403);

  const approveRes = await fetch(`${baseUrl}/api/hr/timesheets/${timesheetId}/approve`, { method: 'POST', headers: { Cookie: ownerCookie } });
  assert.equal(approveRes.status, 200);
  const approved = (await approveRes.json()).timesheet;
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.approvedById, ownerId);
  assert.ok(approved.approvedAt);

  // Approving a second time (no longer SUBMITTED) must be rejected.
  const reapprove = await fetch(`${baseUrl}/api/hr/timesheets/${timesheetId}/approve`, { method: 'POST', headers: { Cookie: ownerCookie } });
  assert.equal(reapprove.status, 409);
});

test('GET /hr/attendance/live reflects the real open TimeClockEntry state', async () => {
  await prisma.timeClockEntry.deleteMany({ where: { agencyId, userId: producerId } });
  const breakStart = new Date();
  await prisma.timeClockEntry.create({ data: { userId: producerId, agencyId, clockInAt: new Date(Date.now() - 60 * 60 * 1000), breakStartAt: breakStart } });

  const res = await fetch(`${baseUrl}/api/hr/attendance/live`, { headers: { Cookie: ownerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  const row = body.live.find((r) => r.userId === producerId);
  assert.ok(row, 'the producer must appear in the live roster');
  assert.equal(row.state, 'ON_BREAK');

  await prisma.timeClockEntry.deleteMany({ where: { agencyId, userId: producerId } });
});

test('attendance-exception detection: a stale open shift creates exactly one MISSED_PUNCH candidate, never auto-resolved, and re-running the job does not duplicate it', async () => {
  const staleClockIn = new Date(Date.now() - 20 * 60 * 60 * 1000);
  await prisma.timeClockEntry.create({ data: { userId: producerId, agencyId, clockInAt: staleClockIn } });

  const first = await detectMissedPunches();
  assert.ok(first.created >= 1);

  const exceptions = await prisma.hrAttendanceException.findMany({ where: { employeeProfileId, exceptionType: 'MISSED_PUNCH' } });
  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0].status, 'OPEN', 'a detected candidate must never start anywhere but OPEN — a human resolves it, never the job itself');

  const second = await detectMissedPunches();
  const afterRerun = await prisma.hrAttendanceException.count({ where: { employeeProfileId, exceptionType: 'MISSED_PUNCH' } });
  assert.equal(afterRerun, 1, 're-running the job while the candidate is still OPEN must never create a duplicate');

  // Human review via the route — the only way this ever leaves OPEN.
  const listRes = await fetch(`${baseUrl}/api/hr/attendance/exceptions?status=OPEN`, { headers: { Cookie: ownerCookie } });
  const listBody = await listRes.json();
  const candidate = listBody.exceptions.find((e) => e.id === exceptions[0].id);
  assert.ok(candidate);

  const producerReviewAttempt = await fetch(`${baseUrl}/api/hr/attendance/exceptions/${candidate.id}/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: producerCookie }, body: JSON.stringify({ status: 'RESOLVED_EXCUSED' }),
  });
  assert.equal(producerReviewAttempt.status, 403, 'only HR_ADMIN may resolve an exception, never a plain producer');

  const reviewRes = await fetch(`${baseUrl}/api/hr/attendance/exceptions/${candidate.id}/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ status: 'RESOLVED_EXCUSED', reviewNote: 'Confirmed forgot to clock out, excused.' }),
  });
  assert.equal(reviewRes.status, 200);
  const reviewed = (await reviewRes.json()).exception;
  assert.equal(reviewed.status, 'RESOLVED_EXCUSED');
  assert.ok(reviewed.reviewedById);
  assert.ok(reviewed.reviewedAt);

  await prisma.timeClockEntry.deleteMany({ where: { agencyId, userId: producerId } });
});
