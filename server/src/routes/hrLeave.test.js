// Real-DB, real-HTTP tests for Backstage HR Phase 1 Part C: Leave.
// Covers insufficient-balance rejection, concurrency-safe approve/deny
// (exactly one USE ledger entry; deny posts none), protected-leave
// exemption from the balance-denial check, GET /hr/leave/calendar
// redaction for anyone without real HR_ADMIN authority, and cross-agency
// denial (matching the Foundation tests' own convention). Kept flat at
// server/src/routes/hrLeave.test.js per this suite's documented npm-test
// glob gotcha — never nested under src/routes/hr/.
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
let ownerId, ownerCookie, managerCookie, producerId, producerCookie;
let otherOwnerCookie;
let employeeProfileId, otherAgencyEmployeeProfileId;
let server, baseUrl;

before(async () => {
  const hash = await bcrypt.hash('TestPass123!', 12);
  const agency = await prisma.agency.create({ data: { name: `HR Leave Test Agency ${suffix}`, hrEnabled: true } });
  agencyId = agency.id;

  const owner = await prisma.user.create({ data: { email: `hrl-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Owner', lastName: 'Leave', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' } });
  ownerId = owner.id;
  ownerCookie = `evenflow_session=${(await createSession(owner.id)).rawToken}`;

  const manager = await prisma.user.create({ data: { email: `hrl-mgr-${suffix}@test.local`, passwordHash: hash, firstName: 'Mgr', lastName: 'Leave', role: 'AGENCY_MANAGER', agencyId, status: 'ACTIVE' } });
  managerCookie = `evenflow_session=${(await createSession(manager.id)).rawToken}`;

  const producer = await prisma.user.create({ data: { email: `hrl-prod-${suffix}@test.local`, passwordHash: hash, firstName: 'Prod', lastName: 'Leave', role: 'PRODUCER', agencyId, status: 'ACTIVE' } });
  producerId = producer.id;
  producerCookie = `evenflow_session=${(await createSession(producerId)).rawToken}`;
  const profile = await prisma.hrEmployeeProfile.create({ data: { userId: producerId, agencyId } });
  employeeProfileId = profile.id;

  const otherAgency = await prisma.agency.create({ data: { name: `HR Leave Other Agency ${suffix}`, hrEnabled: true } });
  otherAgencyId = otherAgency.id;
  const otherOwner = await prisma.user.create({ data: { email: `hrl-other-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Other', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId: otherAgencyId, status: 'ACTIVE' } });
  otherOwnerCookie = `evenflow_session=${(await createSession(otherOwner.id)).rawToken}`;
  const otherUser = await prisma.user.create({ data: { email: `hrl-other-prod-${suffix}@test.local`, passwordHash: hash, firstName: 'Other', lastName: 'Prod', role: 'PRODUCER', agencyId: otherAgencyId, status: 'ACTIVE' } });
  const otherProfile = await prisma.hrEmployeeProfile.create({ data: { userId: otherUser.id, agencyId: otherAgencyId } });
  otherAgencyEmployeeProfileId = otherProfile.id;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.hrLeaveLedgerEntry.deleteMany({ where: { agencyId: { in: [agencyId, otherAgencyId] } } });
  await prisma.hrLeaveRequest.deleteMany({ where: { agencyId: { in: [agencyId, otherAgencyId] } } });
  await prisma.hrLeavePolicyAssignment.deleteMany({ where: { employeeProfileId: { in: [employeeProfileId, otherAgencyEmployeeProfileId] } } });
  await prisma.hrLeavePolicy.deleteMany({ where: { agencyId: { in: [agencyId, otherAgencyId] } } });
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

async function grantBalance(leaveTypeId, minutes) {
  await prisma.hrLeaveLedgerEntry.create({
    data: { employeeProfileId, leaveTypeId, agencyId, transactionType: 'GRANT', minutes, reason: 'test grant' },
  });
}

test('insufficient balance is rejected at creation (never becomes a pending request)', async () => {
  const typeRes = await call('/hr/leave/types', { method: 'POST', cookie: ownerCookie, body: { name: `Vacation ${suffix}`, isPaid: true } });
  assert.equal(typeRes.status, 201);
  const leaveTypeId = typeRes.body.leaveType.id;
  await grantBalance(leaveTypeId, 60); // only 1 hour available

  const res = await call('/hr/leave/requests', {
    method: 'POST', cookie: producerCookie,
    body: { leaveTypeId, startDate: '2027-01-04', endDate: '2027-01-04', requestedMinutes: 480 },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'INSUFFICIENT_BALANCE');

  const count = await prisma.hrLeaveRequest.count({ where: { employeeProfileId, leaveTypeId } });
  assert.equal(count, 0, 'a rejected request is never created at all');
});

test('approve posts exactly one USE ledger entry and reduces the computed balance; deny posts none', async () => {
  const typeRes = await call('/hr/leave/types', { method: 'POST', cookie: ownerCookie, body: { name: `Sick ${suffix}`, isPaid: true } });
  const leaveTypeId = typeRes.body.leaveType.id;
  await grantBalance(leaveTypeId, 960); // 16 hours available

  const createRes = await call('/hr/leave/requests', {
    method: 'POST', cookie: producerCookie,
    body: { leaveTypeId, startDate: '2027-02-10', endDate: '2027-02-10', requestedMinutes: 480 },
  });
  assert.equal(createRes.status, 201);
  const approveId = createRes.body.leaveRequest.id;

  const approveRes = await call(`/hr/leave/requests/${approveId}/approve`, { method: 'POST', cookie: ownerCookie });
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.body.leaveRequest.status, 'APPROVED');

  const useEntries = await prisma.hrLeaveLedgerEntry.findMany({ where: { sourceRequestId: approveId, transactionType: 'USE' } });
  assert.equal(useEntries.length, 1);
  assert.equal(useEntries[0].minutes, -480);

  const balanceRes = await call('/hr/leave/balance', { cookie: producerCookie });
  const bal = balanceRes.body.balances.find((b) => b.leaveTypeId === leaveTypeId);
  assert.equal(bal.balanceMinutes, 480, '960 granted - 480 used = 480');

  // Re-approving an already-APPROVED request must be rejected.
  const reapprove = await call(`/hr/leave/requests/${approveId}/approve`, { method: 'POST', cookie: ownerCookie });
  assert.equal(reapprove.status, 409);

  // --- deny posts nothing ---
  const createRes2 = await call('/hr/leave/requests', {
    method: 'POST', cookie: producerCookie,
    body: { leaveTypeId, startDate: '2027-02-11', endDate: '2027-02-11', requestedMinutes: 60 },
  });
  const denyId = createRes2.body.leaveRequest.id;
  const denyRes = await call(`/hr/leave/requests/${denyId}/deny`, { method: 'POST', cookie: ownerCookie, body: { decisionNote: 'not now' } });
  assert.equal(denyRes.status, 200);
  assert.equal(denyRes.body.leaveRequest.status, 'DENIED');
  const ledgerForDenied = await prisma.hrLeaveLedgerEntry.count({ where: { sourceRequestId: denyId } });
  assert.equal(ledgerForDenied, 0, 'a denied request posts zero ledger entries');
});

test('concurrency: two simultaneous approval attempts on the same request — exactly one succeeds, and exactly one USE entry is posted', async () => {
  const typeRes = await call('/hr/leave/types', { method: 'POST', cookie: ownerCookie, body: { name: `Personal ${suffix}`, isPaid: true } });
  const leaveTypeId = typeRes.body.leaveType.id;
  await grantBalance(leaveTypeId, 480);

  const createRes = await call('/hr/leave/requests', {
    method: 'POST', cookie: producerCookie,
    body: { leaveTypeId, startDate: '2027-03-01', endDate: '2027-03-01', requestedMinutes: 120 },
  });
  const reqId = createRes.body.leaveRequest.id;

  const [a, b] = await Promise.all([
    call(`/hr/leave/requests/${reqId}/approve`, { method: 'POST', cookie: ownerCookie }),
    call(`/hr/leave/requests/${reqId}/approve`, { method: 'POST', cookie: ownerCookie }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], 'exactly one request succeeds, the other hits a 409 conflict');

  const useEntries = await prisma.hrLeaveLedgerEntry.findMany({ where: { sourceRequestId: reqId, transactionType: 'USE' } });
  assert.equal(useEntries.length, 1, 'exactly one USE entry, never two, under a real race');
});

test('a protected leave type is never auto-denied by the balance check — it can be requested and approved with zero balance', async () => {
  const typeRes = await call('/hr/leave/types', { method: 'POST', cookie: ownerCookie, body: { name: `FMLA ${suffix}`, isPaid: false, isProtected: true } });
  assert.equal(typeRes.status, 201);
  const protectedTypeId = typeRes.body.leaveType.id;
  // Deliberately no balance granted for this leave type.

  const res = await call('/hr/leave/requests', {
    method: 'POST', cookie: producerCookie,
    body: { leaveTypeId: protectedTypeId, startDate: '2027-04-01', endDate: '2027-04-10', requestedMinutes: 4800 },
  });
  assert.equal(res.status, 201, 'a protected leave type skips the balance-denial check entirely');
  assert.equal(res.body.flaggedForProtectedReview, true);

  const approveRes = await call(`/hr/leave/requests/${res.body.leaveRequest.id}/approve`, { method: 'POST', cookie: ownerCookie });
  assert.equal(approveRes.status, 200, 'HR can still approve it manually — never auto-approved, never auto-denied, just not balance-blocked');
});

test('GET /hr/leave/calendar redacts a protected leave type to "Approved time off" for an ordinary manager, but shows the real name to HR_ADMIN authority', async () => {
  const typeRes = await call('/hr/leave/types', { method: 'POST', cookie: ownerCookie, body: { name: `Confidential Leave ${suffix}`, isPaid: false, isProtected: true } });
  const protectedTypeId = typeRes.body.leaveType.id;

  const createRes = await call('/hr/leave/requests', {
    method: 'POST', cookie: producerCookie,
    body: { leaveTypeId: protectedTypeId, startDate: '2027-05-01', endDate: '2027-05-03', requestedMinutes: 1440 },
  });
  const reqId = createRes.body.leaveRequest.id;
  await call(`/hr/leave/requests/${reqId}/approve`, { method: 'POST', cookie: ownerCookie });

  // AGENCY_MANAGER has no HR_ADMIN grant — must see the redacted label.
  const managerView = await call(`/hr/leave/calendar?start=2027-04-25&end=2027-05-10`, { cookie: managerCookie });
  assert.equal(managerView.status, 200);
  const managerEntry = managerView.body.entries.find((e) => e.id === reqId);
  assert.ok(managerEntry, 'the manager can see the calendar at all (broad team visibility)');
  assert.equal(managerEntry.leaveTypeName, 'Approved time off');
  assert.equal(managerEntry.isProtected, false, 'isProtected itself is also hidden from a non-HR_ADMIN viewer');

  // AGENCY_OWNER has implicit HR_ADMIN authority — sees the real name.
  const ownerView = await call(`/hr/leave/calendar?start=2027-04-25&end=2027-05-10`, { cookie: ownerCookie });
  const ownerEntry = ownerView.body.entries.find((e) => e.id === reqId);
  assert.equal(ownerEntry.leaveTypeName, `Confidential Leave ${suffix}`);
  assert.equal(ownerEntry.isProtected, true);
});

test('cross-agency denial: an owner cannot approve or view a leave request belonging to a different agency', async () => {
  const typeRes = await call('/hr/leave/types', { method: 'POST', cookie: ownerCookie, body: { name: `CrossAgency ${suffix}`, isPaid: true } });
  const leaveTypeId = typeRes.body.leaveType.id;
  await grantBalance(leaveTypeId, 480);
  const createRes = await call('/hr/leave/requests', {
    method: 'POST', cookie: producerCookie,
    body: { leaveTypeId, startDate: '2027-06-01', endDate: '2027-06-01', requestedMinutes: 60 },
  });
  const reqId = createRes.body.leaveRequest.id;

  const crossApprove = await call(`/hr/leave/requests/${reqId}/approve`, { method: 'POST', cookie: otherOwnerCookie });
  assert.equal(crossApprove.status, 404, 'a different agency\'s owner cannot even see this request exists');

  const crossTypeCreate = await call('/hr/leave/policies', {
    method: 'POST', cookie: otherOwnerCookie,
    body: { leaveTypeId, name: 'Should fail', accrualMethod: 'FRONT_LOADED', accrualAmountMinutes: 100 },
  });
  assert.equal(crossTypeCreate.status, 400, 'a leaveTypeId from a different agency is rejected');
});
