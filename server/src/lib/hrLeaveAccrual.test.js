// Real-DB tests for Backstage HR Phase 1 Part C's leave accrual job:
// accrual math per method, annual cap, carryover (only at a genuine
// year-boundary rollover, never on a brand-new assignment's first
// grant), and idempotency (running the job twice in the same period
// posts exactly one ledger entry, not two — even under true concurrency,
// backed by HrLeaveLedgerEntry.idempotencyKey's real DB unique
// constraint). Kept flat at server/src/lib/hrLeaveAccrual.test.js per
// this suite's own documented npm-test glob gotcha (see
// docs/hr-suite/IMPLEMENTATION_STATUS.md) — never nested under
// src/lib/hr/ or similar.
//
// postAccrualsForOpenPolicies() scans EVERY active policy assignment
// across the whole platform (same shape as Part B's own
// detectMissedPunches()), so its returned `posted`/`checked` counts can
// be nudged by whatever else is concurrently running in the real shared
// test DB. Exactly like hrAttendance.test.js's own `created >= 1`
// convention, this file never asserts an exact value on those global
// counts — every precise assertion is scoped to this file's own
// employeeProfileId/leaveTypeId via a direct ledger query.
process.env.NODE_ENV = 'development';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { postAccrualsForOpenPolicies } = require('./hrLeaveAccrual');

const suffix = Date.now();
const FAR_PAST = new Date('2020-01-01T00:00:00Z');
let agencyId, employeeProfileId, userId;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `HR Accrual Test Agency ${suffix}`, hrEnabled: true } });
  agencyId = agency.id;
  const user = await prisma.user.create({
    data: { email: `hra-accrual-${suffix}@test.local`, firstName: 'Accrual', lastName: 'Test', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  userId = user.id;
  const profile = await prisma.hrEmployeeProfile.create({ data: { userId, agencyId } });
  employeeProfileId = profile.id;
});

after(async () => {
  await prisma.hrLeaveLedgerEntry.deleteMany({ where: { agencyId } });
  await prisma.hrLeavePolicyAssignment.deleteMany({ where: { employeeProfileId } });
  await prisma.hrLeavePolicy.deleteMany({ where: { agencyId } });
  await prisma.hrLeaveType.deleteMany({ where: { agencyId } });
  await prisma.hrTimesheet.deleteMany({ where: { agencyId } });
  await prisma.hrEmployeeProfile.deleteMany({ where: { agencyId } });
  await prisma.user.deleteMany({ where: { agencyId } });
  await prisma.agency.deleteMany({ where: { id: agencyId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.hrLeaveLedgerEntry.deleteMany({ where: { agencyId } });
  await prisma.hrLeavePolicyAssignment.deleteMany({ where: { employeeProfileId } });
  await prisma.hrLeavePolicy.deleteMany({ where: { agencyId } });
  await prisma.hrLeaveType.deleteMany({ where: { agencyId } });
  await prisma.hrTimesheet.deleteMany({ where: { agencyId } });
});

async function makeLeaveType(overrides = {}) {
  return prisma.hrLeaveType.create({ data: { agencyId, name: `Type ${Date.now()}-${Math.random()}`, ...overrides } });
}

async function ledgerEntries(leaveTypeId, transactionType) {
  return prisma.hrLeaveLedgerEntry.findMany({
    where: { employeeProfileId, leaveTypeId, ...(transactionType ? { transactionType } : {}) },
    orderBy: { createdAt: 'asc' },
  });
}

test('FRONT_LOADED: posts the full accrualAmountMinutes once, and a second run in the same year is idempotent (no double-post)', async () => {
  const leaveType = await makeLeaveType();
  const policy = await prisma.hrLeavePolicy.create({
    data: { agencyId, leaveTypeId: leaveType.id, name: 'Front Loaded', accrualMethod: 'FRONT_LOADED', accrualAmountMinutes: 4800, effectiveFrom: FAR_PAST },
  });
  await prisma.hrLeavePolicyAssignment.create({ data: { employeeProfileId, leavePolicyId: policy.id, effectiveFrom: FAR_PAST } });

  const now = new Date('2026-03-01T12:00:00Z');
  await postAccrualsForOpenPolicies({ now });
  await postAccrualsForOpenPolicies({ now }); // same-period rerun

  const entries = await ledgerEntries(leaveType.id);
  assert.equal(entries.length, 1, 'exactly one ledger entry across both runs, never two');
  assert.equal(entries[0].minutes, 4800);
  assert.equal(entries[0].transactionType, 'ACCRUAL');
});

test('PER_PAY_PERIOD: posts once per semi-monthly half, a second half posts a second, distinct entry', async () => {
  const leaveType = await makeLeaveType();
  const policy = await prisma.hrLeavePolicy.create({
    data: { agencyId, leaveTypeId: leaveType.id, name: 'Per Pay Period', accrualMethod: 'PER_PAY_PERIOD', accrualAmountMinutes: 240, effectiveFrom: FAR_PAST },
  });
  await prisma.hrLeavePolicyAssignment.create({ data: { employeeProfileId, leavePolicyId: policy.id, effectiveFrom: FAR_PAST } });

  await postAccrualsForOpenPolicies({ now: new Date('2026-03-10T12:00:00Z') }); // H1
  await postAccrualsForOpenPolicies({ now: new Date('2026-03-12T12:00:00Z') }); // still H1 — must not double-post
  let entries = await ledgerEntries(leaveType.id);
  assert.equal(entries.length, 1, 'still inside the same pay-period half: no double-post');

  await postAccrualsForOpenPolicies({ now: new Date('2026-03-20T12:00:00Z') }); // H2 — a new, distinct period
  entries = await ledgerEntries(leaveType.id);
  assert.equal(entries.length, 2, 'a new pay-period half posts a second, distinct entry');
  assert.equal(entries[0].minutes, 240);
  assert.equal(entries[1].minutes, 240);
  assert.notEqual(entries[0].idempotencyKey, entries[1].idempotencyKey);
});

test('PER_HOUR_WORKED: accrual is proportional to that month\'s real HrTimesheet.regularMinutes, not TimeClockEntry directly', async () => {
  const leaveType = await makeLeaveType();
  // 1 minute of leave per 60 minutes worked.
  const policy = await prisma.hrLeavePolicy.create({
    data: { agencyId, leaveTypeId: leaveType.id, name: 'Per Hour Worked', accrualMethod: 'PER_HOUR_WORKED', accrualAmountMinutes: 1, effectiveFrom: FAR_PAST },
  });
  await prisma.hrLeavePolicyAssignment.create({ data: { employeeProfileId, leavePolicyId: policy.id, effectiveFrom: FAR_PAST } });

  // 600 regular minutes worked in March 2026 (across two timesheet rows).
  await prisma.hrTimesheet.create({ data: { employeeProfileId, agencyId, periodStart: new Date('2026-03-01T00:00:00Z'), periodEnd: new Date('2026-03-08T00:00:00Z'), regularMinutes: 400 } });
  await prisma.hrTimesheet.create({ data: { employeeProfileId, agencyId, periodStart: new Date('2026-03-08T00:00:00Z'), periodEnd: new Date('2026-03-15T00:00:00Z'), regularMinutes: 200 } });
  // A February timesheet must NOT count toward March's accrual.
  await prisma.hrTimesheet.create({ data: { employeeProfileId, agencyId, periodStart: new Date('2026-02-01T00:00:00Z'), periodEnd: new Date('2026-02-08T00:00:00Z'), regularMinutes: 9999 } });

  await postAccrualsForOpenPolicies({ now: new Date('2026-03-25T12:00:00Z') });
  const entries = await ledgerEntries(leaveType.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].minutes, 10, '600 minutes worked * (1 minute leave / 60 minutes worked) = 10');
});

test('annual cap: a FRONT_LOADED grant that would exceed annualCapMinutes is trimmed to exactly fill the remaining room, and nothing posts once fully used', async () => {
  const leaveType = await makeLeaveType();
  const policy = await prisma.hrLeavePolicy.create({
    data: { agencyId, leaveTypeId: leaveType.id, name: 'Capped', accrualMethod: 'PER_PAY_PERIOD', accrualAmountMinutes: 3000, annualCapMinutes: 4000, effectiveFrom: FAR_PAST },
  });
  await prisma.hrLeavePolicyAssignment.create({ data: { employeeProfileId, leavePolicyId: policy.id, effectiveFrom: FAR_PAST } });

  await postAccrualsForOpenPolicies({ now: new Date('2026-03-05T12:00:00Z') }); // H1: full 3000
  await postAccrualsForOpenPolicies({ now: new Date('2026-03-20T12:00:00Z') }); // H2: would be 3000, capped to 1000

  let entries = await ledgerEntries(leaveType.id);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].minutes, 3000);
  assert.equal(entries[1].minutes, 1000, 'capped to the remaining room under the 4000 annual cap');

  await postAccrualsForOpenPolicies({ now: new Date('2026-04-05T12:00:00Z') }); // H1 of April: already at cap
  entries = await ledgerEntries(leaveType.id);
  assert.equal(entries.length, 2, 'once the annual cap is fully used, no further entry is posted (not even a zero-minute one)');
});

test('carryover: trims any balance above carryoverCapMinutes only at a genuine year-boundary rollover, never on a brand-new assignment\'s first grant', async () => {
  const leaveType = await makeLeaveType();
  const policy = await prisma.hrLeavePolicy.create({
    data: { agencyId, leaveTypeId: leaveType.id, name: 'Carryover Capped', accrualMethod: 'FRONT_LOADED', accrualAmountMinutes: 4800, carryoverCapMinutes: 1200, effectiveFrom: FAR_PAST },
  });
  await prisma.hrLeavePolicyAssignment.create({ data: { employeeProfileId, leavePolicyId: policy.id, effectiveFrom: FAR_PAST } });

  // First-ever grant, in year 2026 — nothing to carry over FROM, so the
  // full 4800 must survive untouched even though it's well above the
  // 1200 carryover cap.
  await postAccrualsForOpenPolicies({ now: new Date('2026-01-15T12:00:00Z') });
  let balance = await prisma.hrLeaveLedgerEntry.aggregate({ where: { employeeProfileId, leaveTypeId: leaveType.id }, _sum: { minutes: true } });
  assert.equal(balance._sum.minutes, 4800, 'a first-year grant is never pre-trimmed by the carryover cap');
  let expirations = await ledgerEntries(leaveType.id, 'EXPIRATION');
  assert.equal(expirations.length, 0, 'no carryover expiration on a first-year grant');

  // Crossing into 2027: now there IS a prior-year balance (4800), so the
  // rollover trims it down to the 1200 cap via an EXPIRATION entry,
  // before posting 2027's own new FRONT_LOADED grant.
  await postAccrualsForOpenPolicies({ now: new Date('2027-01-10T12:00:00Z') });

  expirations = await ledgerEntries(leaveType.id, 'EXPIRATION');
  assert.equal(expirations.length, 1, 'exactly one carryover EXPIRATION entry was posted at the rollover');
  assert.equal(expirations[0].minutes, -3600, '4800 balance - 1200 cap = 3600 expired');

  const accruals = await ledgerEntries(leaveType.id, 'ACCRUAL');
  assert.equal(accruals.length, 2, 'the 2026 grant plus the 2027 grant');

  balance = await prisma.hrLeaveLedgerEntry.aggregate({ where: { employeeProfileId, leaveTypeId: leaveType.id }, _sum: { minutes: true } });
  assert.equal(balance._sum.minutes, 1200 + 4800, 'capped carryover (1200) + the new year\'s fresh grant (4800)');

  // Re-running the same moment again must not double-post the carryover
  // expiration (it's keyed per assignment+year, same idempotency guard).
  await postAccrualsForOpenPolicies({ now: new Date('2027-01-11T12:00:00Z') });
  expirations = await ledgerEntries(leaveType.id, 'EXPIRATION');
  assert.equal(expirations.length, 1, 'the carryover expiration itself is also idempotent');
});

test('idempotency under true concurrency: two simultaneous job runs for the same period post exactly one entry, never two', async () => {
  const leaveType = await makeLeaveType();
  const policy = await prisma.hrLeavePolicy.create({
    data: { agencyId, leaveTypeId: leaveType.id, name: 'Concurrent', accrualMethod: 'FRONT_LOADED', accrualAmountMinutes: 600, effectiveFrom: FAR_PAST },
  });
  await prisma.hrLeavePolicyAssignment.create({ data: { employeeProfileId, leavePolicyId: policy.id, effectiveFrom: FAR_PAST } });

  const now = new Date('2026-06-01T12:00:00Z');
  await Promise.all([postAccrualsForOpenPolicies({ now }), postAccrualsForOpenPolicies({ now })]);

  const entries = await ledgerEntries(leaveType.id);
  assert.equal(entries.length, 1, 'across two concurrent runs racing on the same idempotencyKey, exactly one entry survives');
});
