// Pure-logic tests for hrTimesheetBuilder.segmentsForEntry (no DB), plus
// a few real-DB tests of buildTimesheetForEmployee/computeAndStoreTimesheet
// against real TimeClockEntry rows — matching this file's "derive from
// real clock data, never fabricate" contract.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { prisma } = require('./db');
const {
  segmentsForEntry, buildTimesheetForEmployee, computeAndStoreTimesheet,
} = require('./hrTimesheetBuilder');

function at(hour, minute = 0, dayOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

test('a plain shift with no lunch/break produces one WORK segment, no exception', () => {
  const entry = { id: 'e1', clockInAt: at(9), clockOutAt: at(17), lunchStartAt: null, lunchEndAt: null, breakStartAt: null, breakEndAt: null };
  const segs = segmentsForEntry(entry, new Date());
  assert.equal(segs.length, 1);
  assert.equal(segs[0].segmentType, 'WORK');
  assert.equal(segs[0].minutes, 480);
  assert.equal(segs[0].isException, false);
});

test('a shift with one lunch period splits into WORK/LUNCH/WORK, in chronological order', () => {
  const entry = { id: 'e2', clockInAt: at(9), clockOutAt: at(17), lunchStartAt: at(12), lunchEndAt: at(12, 30), breakStartAt: null, breakEndAt: null };
  const segs = segmentsForEntry(entry, new Date());
  assert.deepEqual(segs.map((s) => s.segmentType), ['WORK', 'LUNCH', 'WORK']);
  assert.equal(segs[0].minutes, 180);
  assert.equal(segs[1].minutes, 30);
  assert.equal(segs[2].minutes, 270);
  assert.ok(segs.every((s) => !s.isException));
});

test('a shift with both a break and a lunch produces 5 segments in real chronological order', () => {
  // break (10:15-10:30) happens before lunch (12:00-12:30) — the builder
  // must sort by actual time, not by field-declaration order.
  const entry = {
    id: 'e3', clockInAt: at(9), clockOutAt: at(17),
    lunchStartAt: at(12), lunchEndAt: at(12, 30),
    breakStartAt: at(10, 15), breakEndAt: at(10, 30),
  };
  const segs = segmentsForEntry(entry, new Date());
  assert.deepEqual(segs.map((s) => s.segmentType), ['WORK', 'BREAK', 'WORK', 'LUNCH', 'WORK']);
  const totalMinutes = segs.reduce((sum, s) => sum + s.minutes, 0);
  assert.equal(totalMinutes, 480);
});

test('a still-open shift within a normal window is not flagged an exception', () => {
  const entry = { id: 'e4', clockInAt: at(9), clockOutAt: null, lunchStartAt: null, lunchEndAt: null, breakStartAt: null, breakEndAt: null };
  const now = at(13); // 4 hours into an in-progress shift
  const segs = segmentsForEntry(entry, now);
  assert.equal(segs[segs.length - 1].isException, false);
  assert.equal(segs[segs.length - 1].endedAt, null, 'never fabricate an end time for an open shift');
});

test('a shift left open past the stale-shift threshold is flagged, never fabricated an end time', () => {
  const clockInAt = new Date(Date.now() - 20 * 60 * 60 * 1000); // 20 hours ago
  const entry = { id: 'e5', clockInAt, clockOutAt: null, lunchStartAt: null, lunchEndAt: null, breakStartAt: null, breakEndAt: null };
  const segs = segmentsForEntry(entry, new Date());
  const last = segs[segs.length - 1];
  assert.equal(last.isException, true);
  assert.equal(last.exceptionReason, 'STILL_OPEN_PAST_EXPECTED_SHIFT_LENGTH');
  assert.equal(last.endedAt, null);
  assert.equal(last.minutes, null);
});

test('a reversed lunch period (start after end) is a flagged ordering anomaly, not a negative-duration segment', () => {
  const entry = {
    id: 'e6', clockInAt: at(9), clockOutAt: at(17),
    lunchStartAt: at(12, 30), lunchEndAt: at(12), // reversed
    breakStartAt: null, breakEndAt: null,
  };
  const segs = segmentsForEntry(entry, new Date());
  assert.equal(segs.length, 1);
  assert.equal(segs[0].isException, true);
  assert.equal(segs[0].exceptionReason, 'ORDERING_ANOMALY');
});

test('a lunch started but never ended, with the shift itself already clocked out, is an ordering anomaly', () => {
  const entry = {
    id: 'e7', clockInAt: at(9), clockOutAt: at(17),
    lunchStartAt: at(12), lunchEndAt: null,
    breakStartAt: null, breakEndAt: null,
  };
  const segs = segmentsForEntry(entry, new Date());
  assert.equal(segs.length, 1);
  assert.equal(segs[0].exceptionReason, 'ORDERING_ANOMALY');
});

test('a shift crossing midnight is flagged OVERNIGHT_SHIFT on the spanning segment', () => {
  const entry = { id: 'e8', clockInAt: at(23), clockOutAt: at(7, 0, 1), lunchStartAt: null, lunchEndAt: null, breakStartAt: null, breakEndAt: null };
  const segs = segmentsForEntry(entry, new Date());
  assert.equal(segs.length, 1);
  assert.equal(segs[0].isException, true);
  assert.equal(segs[0].exceptionReason, 'OVERNIGHT_SHIFT');
});

test('regression guard: hrTimesheetBuilder.js and hrAttendanceDetection.js never write to TimeClockEntry', () => {
  const builderSrc = fs.readFileSync(path.join(__dirname, 'hrTimesheetBuilder.js'), 'utf8');
  const jobSrc = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'hrAttendanceDetection.js'), 'utf8');
  for (const src of [builderSrc, jobSrc]) {
    assert.doesNotMatch(src, /timeClockEntry\.(update|delete|create|upsert|updateMany|deleteMany)\(/, 'this module must only ever read TimeClockEntry, never write to it');
  }
});

// --- Real-DB tests against actual TimeClockEntry rows ---

const suffix = Date.now();
let agencyId, userId, employeeProfileId;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Timesheet Builder Test Agency ${suffix}`, hrEnabled: true } });
  agencyId = agency.id;
  const hash = await bcrypt.hash('TestPass123!', 12);
  const user = await prisma.user.create({
    data: { email: `tsb-${suffix}@test.local`, passwordHash: hash, firstName: 'Time', lastName: 'Sheet', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  userId = user.id;
  const profile = await prisma.hrEmployeeProfile.create({ data: { userId, agencyId } });
  employeeProfileId = profile.id;
});

after(async () => {
  await prisma.hrTimesheetSegment.deleteMany({ where: { timesheet: { agencyId } } });
  await prisma.hrTimesheet.deleteMany({ where: { agencyId } });
  await prisma.timeClockEntry.deleteMany({ where: { agencyId } });
  await prisma.hrEmployeeProfile.deleteMany({ where: { agencyId } });
  await prisma.user.deleteMany({ where: { agencyId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await prisma.$disconnect();
});

test('buildTimesheetForEmployee sums real TimeClockEntry rows correctly for a period', async () => {
  const periodStart = at(0, 0, -1);
  const periodEnd = at(0, 0, 1);
  await prisma.timeClockEntry.create({
    data: { userId, agencyId, clockInAt: at(9), clockOutAt: at(17), lunchStartAt: at(12), lunchEndAt: at(12, 30) },
  });
  const built = await buildTimesheetForEmployee({ employeeProfileId, userId, agencyId, periodStart, periodEnd });
  assert.equal(built.regularMinutes, 450); // 480 - 30 min lunch
  assert.equal(built.paidLeaveMinutes, 0, 'Part C has not shipped yet — never fabricate a leave figure');
});

test('computeAndStoreTimesheet persists segments and recomputing updates them, but an APPROVED timesheet is locked', async () => {
  const periodStart = at(0, 0, -2);
  const periodEnd = at(0, 0, 2);
  await prisma.timeClockEntry.deleteMany({ where: { agencyId } });
  await prisma.timeClockEntry.create({ data: { userId, agencyId, clockInAt: at(9), clockOutAt: at(17) } });

  const first = await computeAndStoreTimesheet({ employeeProfileId, userId, agencyId, periodStart, periodEnd });
  assert.equal(first.regularMinutes, 480);
  const storedSegments = await prisma.hrTimesheetSegment.findMany({ where: { timesheetId: first.id } });
  assert.equal(storedSegments.length, 1);

  await prisma.hrTimesheet.update({ where: { id: first.id }, data: { status: 'APPROVED' } });

  // Add another clock entry — recomputing an APPROVED timesheet must not change it.
  await prisma.timeClockEntry.create({ data: { userId, agencyId, clockInAt: at(18), clockOutAt: at(19) } });
  const second = await computeAndStoreTimesheet({ employeeProfileId, userId, agencyId, periodStart, periodEnd });
  assert.equal(second.regularMinutes, 480, 'an APPROVED timesheet must stay exactly as approved, never silently recomputed');
});
