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

test('HR_ADMIN can mark a date range as used directly on another employee\'s record — autoApprove skips the balance check and posts the USE entry immediately', async () => {
  const typeRes = await call('/hr/leave/types', { method: 'POST', cookie: ownerCookie, body: { name: `Vacation Mark ${suffix}`, isPaid: true } });
  const leaveTypeId = typeRes.body.leaveType.id;
  // Deliberately no balance granted — marking a real fact of usage must
  // never be blocked by balance math, same reasoning as a protected type.

  const res = await call('/hr/leave/requests', {
    method: 'POST', cookie: ownerCookie,
    body: { employeeProfileId, leaveTypeId, startDate: '2027-07-01', endDate: '2027-07-01', requestedMinutes: 480, autoApprove: true },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.leaveRequest.status, 'APPROVED');
  assert.equal(res.body.autoApproved, true);

  const useEntries = await prisma.hrLeaveLedgerEntry.findMany({ where: { sourceRequestId: res.body.leaveRequest.id, transactionType: 'USE' } });
  assert.equal(useEntries.length, 1);
  assert.equal(useEntries[0].minutes, -480);

  const balanceRes = await call('/hr/leave/balance', { cookie: producerCookie });
  const bal = balanceRes.body.balances.find((b) => b.leaveTypeId === leaveTypeId);
  assert.equal(bal.balanceMinutes, -480, 'a direct mark-used entry is allowed to take the balance negative rather than being blocked');
});

test('a non-HR_ADMIN cannot mark leave on someone else\'s record (employeeProfileId is rejected)', async () => {
  const typeRes = await call('/hr/leave/types', { method: 'POST', cookie: ownerCookie, body: { name: `Sick Mark ${suffix}`, isPaid: true } });
  const leaveTypeId = typeRes.body.leaveType.id;
  const res = await call('/hr/leave/requests', {
    method: 'POST', cookie: producerCookie,
    body: { employeeProfileId, leaveTypeId, startDate: '2027-07-05', endDate: '2027-07-05', requestedMinutes: 60, autoApprove: true },
  });
  // The producer IS employeeProfileId's own user, but only because the
  // route treats a supplied employeeProfileId as an admin-entry path
  // requiring real HR_ADMIN authority, regardless of whose id it is.
  assert.equal(res.status, 403);
});

test('editing an APPROVED entry posts exactly one ADJUSTMENT ledger entry for the delta, and the balance reflects it immediately', async () => {
  const typeRes = await call('/hr/leave/types', { method: 'POST', cookie: ownerCookie, body: { name: `EditMe ${suffix}`, isPaid: true } });
  const leaveTypeId = typeRes.body.leaveType.id;
  const markRes = await call('/hr/leave/requests', {
    method: 'POST', cookie: ownerCookie,
    body: { employeeProfileId, leaveTypeId, startDate: '2027-08-01', endDate: '2027-08-01', requestedMinutes: 240, autoApprove: true },
  });
  const entryId = markRes.body.leaveRequest.id;

  const editRes = await call(`/hr/leave/requests/${entryId}`, { method: 'PATCH', cookie: ownerCookie, body: { requestedMinutes: 480 } });
  assert.equal(editRes.status, 200);
  assert.equal(editRes.body.leaveRequest.requestedMinutes, 480);

  const adjustments = await prisma.hrLeaveLedgerEntry.findMany({ where: { sourceRequestId: entryId, transactionType: 'ADJUSTMENT' } });
  assert.equal(adjustments.length, 1);
  assert.equal(adjustments[0].minutes, -240, 'the extra 240m used is posted as a further negative adjustment');

  const balanceRes = await call('/hr/leave/balance', { cookie: producerCookie });
  const bal = balanceRes.body.balances.find((b) => b.leaveTypeId === leaveTypeId);
  assert.equal(bal.balanceMinutes, -480, '0 - 240 (USE) - 240 (ADJUSTMENT) = -480');

  // A no-op edit (same minutes) posts zero additional ledger rows.
  const noopRes = await call(`/hr/leave/requests/${entryId}`, { method: 'PATCH', cookie: ownerCookie, body: { requestedMinutes: 480 } });
  assert.equal(noopRes.status, 200);
  const stillOneAdjustment = await prisma.hrLeaveLedgerEntry.count({ where: { sourceRequestId: entryId, transactionType: 'ADJUSTMENT' } });
  assert.equal(stillOneAdjustment, 1, 'an edit with no actual minute change posts no new ledger entry');
});

test('removing an entry posts a REVERSAL that fully restores the balance, and a PENDING request cannot be edited or removed this way', async () => {
  const typeRes = await call('/hr/leave/types', { method: 'POST', cookie: ownerCookie, body: { name: `RemoveMe ${suffix}`, isPaid: true } });
  const leaveTypeId = typeRes.body.leaveType.id;
  await grantBalance(leaveTypeId, 960);

  const markRes = await call('/hr/leave/requests', {
    method: 'POST', cookie: ownerCookie,
    body: { employeeProfileId, leaveTypeId, startDate: '2027-09-01', endDate: '2027-09-01', requestedMinutes: 480, autoApprove: true },
  });
  const entryId = markRes.body.leaveRequest.id;

  const cancelRes = await call(`/hr/leave/requests/${entryId}/cancel`, { method: 'POST', cookie: ownerCookie });
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.body.leaveRequest.status, 'CANCELLED');

  const reversals = await prisma.hrLeaveLedgerEntry.findMany({ where: { sourceRequestId: entryId, transactionType: 'REVERSAL' } });
  assert.equal(reversals.length, 1);
  assert.equal(reversals[0].minutes, 480);

  const balanceRes = await call('/hr/leave/balance', { cookie: producerCookie });
  const bal = balanceRes.body.balances.find((b) => b.leaveTypeId === leaveTypeId);
  assert.equal(bal.balanceMinutes, 960, '960 granted - 480 used + 480 reversed = 960, fully restored');

  // Cancelling again (already CANCELLED, not APPROVED) is rejected.
  const secondCancel = await call(`/hr/leave/requests/${entryId}/cancel`, { method: 'POST', cookie: ownerCookie });
  assert.equal(secondCancel.status, 409);

  // A still-PENDING request (never approved) cannot be edited or cancelled via these routes.
  const pendingRes = await call('/hr/leave/requests', {
    method: 'POST', cookie: producerCookie,
    body: { leaveTypeId, startDate: '2027-09-05', endDate: '2027-09-05', requestedMinutes: 60 },
  });
  const pendingId = pendingRes.body.leaveRequest.id;
  const editPending = await call(`/hr/leave/requests/${pendingId}`, { method: 'PATCH', cookie: ownerCookie, body: { requestedMinutes: 120 } });
  assert.equal(editPending.status, 409);
  const cancelPending = await call(`/hr/leave/requests/${pendingId}/cancel`, { method: 'POST', cookie: ownerCookie });
  assert.equal(cancelPending.status, 409);
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

test('PATCH /hr/leave/types/:id edits a leave type in place and can deactivate it; cross-agency and non-HR_ADMIN access are denied', async () => {
  const createRes = await call('/hr/leave/types', { method: 'POST', cookie: ownerCookie, body: { name: `Editable Type ${suffix}`, isPaid: true } });
  const typeId = createRes.body.leaveType.id;

  const editRes = await call(`/hr/leave/types/${typeId}`, { method: 'PATCH', cookie: ownerCookie, body: { name: `Renamed Type ${suffix}`, isPaid: false } });
  assert.equal(editRes.status, 200);
  assert.equal(editRes.body.leaveType.name, `Renamed Type ${suffix}`);
  assert.equal(editRes.body.leaveType.isPaid, false);

  const deactivateRes = await call(`/hr/leave/types/${typeId}`, { method: 'PATCH', cookie: ownerCookie, body: { isActive: false } });
  assert.equal(deactivateRes.status, 200);
  assert.equal(deactivateRes.body.leaveType.isActive, false);
  const stillThere = await prisma.hrLeaveType.findUnique({ where: { id: typeId } });
  assert.ok(stillThere, 'deactivating never deletes the row');

  const crossEdit = await call(`/hr/leave/types/${typeId}`, { method: 'PATCH', cookie: otherOwnerCookie, body: { name: 'Hijacked' } });
  assert.equal(crossEdit.status, 404, 'a different agency cannot see or edit this leave type');

  const nonAdminEdit = await call(`/hr/leave/types/${typeId}`, { method: 'PATCH', cookie: producerCookie, body: { name: 'Nope' } });
  assert.equal(nonAdminEdit.status, 403, 'a non-HR_ADMIN producer cannot edit a leave type');
});

test('PATCH /hr/leave/policies/:id edits accrual settings in place and can deactivate via effectiveTo; cross-agency denied', async () => {
  const typeRes = await call('/hr/leave/types', { method: 'POST', cookie: ownerCookie, body: { name: `Policy Type ${suffix}`, isPaid: true } });
  const leaveTypeId = typeRes.body.leaveType.id;
  const createRes = await call('/hr/leave/policies', {
    method: 'POST', cookie: ownerCookie,
    body: { leaveTypeId, name: `Editable Policy ${suffix}`, accrualMethod: 'PER_HOUR_WORKED', accrualAmountMinutes: 1, waitingPeriodDays: 0 },
  });
  assert.equal(createRes.status, 201);
  const policyId = createRes.body.policy.id;
  assert.equal(createRes.body.policy.accrualWorkedMinutesDenominator, 60, 'schema default applies on create');

  const editRes = await call(`/hr/leave/policies/${policyId}`, {
    method: 'PATCH', cookie: ownerCookie,
    body: { accrualAmountMinutes: 30, accrualWorkedMinutesDenominator: 480, waitingPeriodDays: 90 },
  });
  assert.equal(editRes.status, 200);
  assert.equal(editRes.body.policy.accrualAmountMinutes, 30);
  assert.equal(editRes.body.policy.accrualWorkedMinutesDenominator, 480);
  assert.equal(editRes.body.policy.waitingPeriodDays, 90);

  const deactivateAt = new Date().toISOString();
  const deactivateRes = await call(`/hr/leave/policies/${policyId}`, { method: 'PATCH', cookie: ownerCookie, body: { effectiveTo: deactivateAt } });
  assert.equal(deactivateRes.status, 200);
  assert.ok(deactivateRes.body.policy.effectiveTo, 'effectiveTo is set rather than the row being deleted');
  const stillThere = await prisma.hrLeavePolicy.findUnique({ where: { id: policyId } });
  assert.ok(stillThere, 'deactivating a policy never deletes it');

  const crossEdit = await call(`/hr/leave/policies/${policyId}`, { method: 'PATCH', cookie: otherOwnerCookie, body: { name: 'Hijacked' } });
  assert.equal(crossEdit.status, 404, 'a different agency cannot see or edit this leave policy');
});
