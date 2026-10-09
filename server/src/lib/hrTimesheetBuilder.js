// HR Time & Attendance — the ONE place in Backstage HR allowed to read
// TimeClockEntry. Strictly read-only: never calls prisma.timeClockEntry
// .update()/.delete()/.create() — it only ever derives HrTimesheet/
// HrTimesheetSegment rows FROM existing clock events. Nothing here
// changes timeClockState.js's logic or Break Room eligibility.
//
// A TimeClockEntry row holds at most one lunch period and one break
// period (confirmed from schema.prisma) — never an arbitrary sequence —
// so each entry maps to a short, boundary-ordered walk, not a general
// event-log parser.
const { prisma } = require('./db');

const MINUTE_MS = 60 * 1000;

// A shift still open (no clockOutAt) longer than this is treated as
// stale and flagged for human review — never silently closed, never
// fabricated an end time.
const STALE_OPEN_SHIFT_HOURS = 16;

// Placeholder until Part C's real per-agency HrSettings field exists —
// a plain scheduling heads-up, never a jurisdiction-aware payroll
// overtime calculation.
const DEFAULT_WEEKLY_OVERTIME_THRESHOLD_MINUTES = 40 * 60;

function minutesBetween(start, end) {
  return Math.round((end.getTime() - start.getTime()) / MINUTE_MS);
}

function sameCalendarDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Pure function: derive an array of segment objects from one
// TimeClockEntry row. Never touches the database.
function segmentsForEntry(entry, now) {
  const { id, clockInAt, clockOutAt, lunchStartAt, lunchEndAt, breakStartAt, breakEndAt } = entry;

  // Ordering validation — if anything is inconsistent (a start after its
  // own end, a period that falls outside the shift, a period opened but
  // never closed while the shift itself did close), never try to guess
  // at segments: emit one WORK segment spanning the whole entry, flagged
  // for a human to look at.
  const orderingOk = (
    (!lunchStartAt || !lunchEndAt || lunchStartAt < lunchEndAt)
    && (!breakStartAt || !breakEndAt || breakStartAt < breakEndAt)
    && (!lunchStartAt || lunchStartAt >= clockInAt)
    && (!breakStartAt || breakStartAt >= clockInAt)
    && (!clockOutAt || !lunchEndAt || lunchEndAt <= clockOutAt)
    && (!clockOutAt || !breakEndAt || breakEndAt <= clockOutAt)
    // A period that was opened but never closed is only a real anomaly
    // once the shift itself has already closed — a currently-open lunch
    // on a currently-open shift is just "on lunch right now."
    && (!(lunchStartAt && !lunchEndAt && clockOutAt))
    && (!(breakStartAt && !breakEndAt && clockOutAt))
  );

  if (!orderingOk) {
    const endedAt = clockOutAt || null;
    return [{
      sourceTimeClockEntryId: id,
      segmentType: 'WORK',
      startedAt: clockInAt,
      endedAt,
      minutes: endedAt ? minutesBetween(clockInAt, endedAt) : null,
      isException: true,
      exceptionReason: 'ORDERING_ANOMALY',
    }];
  }

  // Build the ordered list of "what state did we enter, and when."
  const points = [{ t: clockInAt, enter: 'WORK' }];
  if (lunchStartAt) points.push({ t: lunchStartAt, enter: 'LUNCH' });
  if (lunchEndAt) points.push({ t: lunchEndAt, enter: 'WORK' });
  if (breakStartAt) points.push({ t: breakStartAt, enter: 'BREAK' });
  if (breakEndAt) points.push({ t: breakEndAt, enter: 'WORK' });
  points.sort((a, b) => a.t.getTime() - b.t.getTime());

  const segments = [];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const next = points[i + 1];
    const startedAt = point.t;
    let endedAt = next ? next.t : clockOutAt || null;
    let isException = false;
    let exceptionReason = null;

    if (!endedAt) {
      // The shift is still genuinely open. Only flag it if it's been
      // open implausibly long — an in-progress "today" shift isn't a
      // problem, it's just not finished yet.
      const hoursOpen = (now.getTime() - startedAt.getTime()) / (60 * MINUTE_MS);
      if (hoursOpen > STALE_OPEN_SHIFT_HOURS) {
        isException = true;
        exceptionReason = 'STILL_OPEN_PAST_EXPECTED_SHIFT_LENGTH';
      }
    } else if (!sameCalendarDay(startedAt, endedAt)) {
      isException = true;
      exceptionReason = 'OVERNIGHT_SHIFT';
    }

    segments.push({
      sourceTimeClockEntryId: id,
      segmentType: point.enter,
      startedAt,
      endedAt,
      minutes: endedAt ? minutesBetween(startedAt, endedAt) : null,
      isException,
      exceptionReason,
    });
  }

  return segments;
}

// Derive the regular/overtime/paidLeave minute totals for one employee's
// timesheet from real TimeClockEntry rows in [periodStart, periodEnd).
// Read-only: the only prisma call here is a findMany.
async function buildTimesheetForEmployee({ employeeProfileId, userId, agencyId, periodStart, periodEnd, now = new Date() }) {
  const entries = await prisma.timeClockEntry.findMany({
    where: { userId, agencyId, clockInAt: { gte: periodStart, lt: periodEnd } },
    orderBy: { clockInAt: 'asc' },
  });

  const segments = entries.flatMap((entry) => segmentsForEntry(entry, now));
  const regularMinutes = segments
    .filter((s) => s.segmentType === 'WORK' && typeof s.minutes === 'number')
    .reduce((sum, s) => sum + s.minutes, 0);
  const overtimeMinutes = Math.max(0, regularMinutes - DEFAULT_WEEKLY_OVERTIME_THRESHOLD_MINUTES);

  return {
    employeeProfileId,
    agencyId,
    periodStart,
    periodEnd,
    regularMinutes,
    overtimeMinutes,
    paidLeaveMinutes: 0,
    segments,
  };
}

// Computes + upserts the derived HrTimesheet/HrTimesheetSegment rows for
// one employee's period. An APPROVED timesheet is locked — recomputing
// never touches it, since its numbers are now the agreed-upon record.
async function computeAndStoreTimesheet({ employeeProfileId, userId, agencyId, periodStart, periodEnd, now = new Date() }) {
  const existing = await prisma.hrTimesheet.findUnique({
    where: { employeeProfileId_periodStart_periodEnd: { employeeProfileId, periodStart, periodEnd } },
  });
  if (existing && existing.status === 'APPROVED') {
    return existing;
  }

  const built = await buildTimesheetForEmployee({ employeeProfileId, userId, agencyId, periodStart, periodEnd, now });

  const timesheet = await prisma.$transaction(async (tx) => {
    const row = await tx.hrTimesheet.upsert({
      where: { employeeProfileId_periodStart_periodEnd: { employeeProfileId, periodStart, periodEnd } },
      create: {
        employeeProfileId, agencyId, periodStart, periodEnd,
        regularMinutes: built.regularMinutes, overtimeMinutes: built.overtimeMinutes, paidLeaveMinutes: built.paidLeaveMinutes,
      },
      update: {
        regularMinutes: built.regularMinutes, overtimeMinutes: built.overtimeMinutes, paidLeaveMinutes: built.paidLeaveMinutes,
        computedAt: now,
      },
    });
    await tx.hrTimesheetSegment.deleteMany({ where: { timesheetId: row.id } });
    if (built.segments.length) {
      await tx.hrTimesheetSegment.createMany({
        data: built.segments.map((s) => ({ ...s, timesheetId: row.id })),
      });
    }
    return row;
  });

  return timesheet;
}

module.exports = {
  segmentsForEntry,
  buildTimesheetForEmployee,
  computeAndStoreTimesheet,
  STALE_OPEN_SHIFT_HOURS,
  DEFAULT_WEEKLY_OVERTIME_THRESHOLD_MINUTES,
};
