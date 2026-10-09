// Backstage HR — Phase 1 Part C leave accrual job. Idempotent by
// construction: every ACCRUAL (and carryover EXPIRATION) ledger entry
// this posts carries a deterministic idempotencyKey, backed by
// HrLeaveLedgerEntry.idempotencyKey's real DB-level @unique constraint —
// a retried or duplicate job run can never double-post, even under true
// concurrency (the second insert hits the unique constraint and is
// treated as "already posted," not an error). HrLeaveLedgerEntry stays
// the one and only source of truth for a balance; this job only ever
// INSERTs ledger rows, never writes a stored balance field anywhere.
// Registered via the same in-process setInterval convention as Part B's
// jobs/hrAttendanceDetection.js — no new queue/cron infrastructure.
//
// Benefit-year anchor (documented default — see docs/hr-suite/
// IMPLEMENTATION_STATUS.md's "Decisions made"): calendar year (Jan 1),
// not a per-employee hire-date anniversary. Simple and correct for the
// common case; a true anniversary-based benefit year is a later
// refinement, not a Phase-1 blocker.
//
// Pay-period anchor (documented default, same reason — no real payroll
// "pay period" model exists anywhere in this codebase yet, that's the
// future Payroll phase): semi-monthly, 1st-15th and 16th-end-of-month.
//
// PER_HOUR_WORKED accrual reads HrTimesheet.regularMinutes (Part B's
// already-derived, already-tested, HR_ADMIN-approved data) for the
// calendar month, never TimeClockEntry directly — hrTimesheetBuilder.js
// stays the one place in this suite that reads the raw clock table.
const { prisma } = require('./db');
const { getBalanceMinutes } = require('./hrLeaveLedger');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function periodKeyForMethod(accrualMethod, now) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  if (accrualMethod === 'FRONT_LOADED') return `${year}`;
  if (accrualMethod === 'PER_PAY_PERIOD') return `${year}-${pad2(month)}-H${day <= 15 ? 1 : 2}`;
  if (accrualMethod === 'PER_HOUR_WORKED') return `${year}-${pad2(month)}`;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

async function regularMinutesWorkedInMonth(tx, { employeeProfileId, year, month }) {
  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1));
  const timesheets = await tx.hrTimesheet.findMany({
    where: { employeeProfileId, periodStart: { gte: periodStart }, periodEnd: { lte: periodEnd } },
    select: { regularMinutes: true },
  });
  return timesheets.reduce((sum, t) => sum + t.regularMinutes, 0);
}

async function accruedSoFarThisYear(tx, { employeeProfileId, leaveTypeId, year }) {
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));
  const agg = await tx.hrLeaveLedgerEntry.aggregate({
    where: { employeeProfileId, leaveTypeId, transactionType: 'ACCRUAL', createdAt: { gte: start, lt: end } },
    _sum: { minutes: true },
  });
  return agg._sum.minutes || 0;
}

// Trims any balance above the policy's carryoverCapMinutes once per
// (assignment, calendar year) — the only place a balance is ever reduced
// by something other than the employee's own approved USE. Posts an
// EXPIRATION entry for exactly the excess, idempotently. Only a genuine
// year-boundary rollover does this: if nothing was ever posted before
// the current calendar year (a brand new assignment's first year), there
// is no prior-year balance to carry over FROM, so this is a deliberate
// no-op — otherwise a policy's very first FRONT_LOADED grant would be
// immediately trimmed down to the carryover cap on day one.
async function postCarryoverExpirationIfNeeded(tx, { assignment, policy, now }) {
  if (policy.carryoverCapMinutes == null) return;
  const year = now.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const idempotencyKey = `${assignment.id}:carryover-expiration:${year}`;
  const already = await tx.hrLeaveLedgerEntry.findUnique({ where: { idempotencyKey } });
  if (already) return;

  const priorYearEntry = await tx.hrLeaveLedgerEntry.findFirst({
    where: { employeeProfileId: assignment.employeeProfileId, leaveTypeId: policy.leaveTypeId, createdAt: { lt: yearStart } },
    select: { id: true },
  });
  if (!priorYearEntry) return;

  const balance = await getBalanceMinutes(tx, { employeeProfileId: assignment.employeeProfileId, leaveTypeId: policy.leaveTypeId });
  const excess = balance - policy.carryoverCapMinutes;
  if (excess <= 0) return;

  await tx.hrLeaveLedgerEntry.create({
    data: {
      employeeProfileId: assignment.employeeProfileId,
      leaveTypeId: policy.leaveTypeId,
      agencyId: assignment.employeeProfile.agencyId,
      transactionType: 'EXPIRATION',
      minutes: -excess,
      reason: `Carryover cap (${policy.carryoverCapMinutes}m) applied at the ${year} rollover`,
      idempotencyKey,
      // Explicit, not the column default — this must be the job's own
      // logical `now`, never the real wall-clock instant, so a reprocess
      // or backfill run with a historical `now` stays internally
      // consistent with its own year-boundary/annual-cap math instead of
      // silently drifting to whenever the job actually executed.
      createdAt: now,
    },
  });
}

// For one active HrLeavePolicyAssignment, posts the current period's
// ACCRUAL entry (capped by annualCapMinutes if set) unless it was
// already posted for this exact period. Returns true if a new entry was
// created.
async function postAccrualForAssignment(assignment, now) {
  const policy = assignment.leavePolicy;
  if (!policy || !policy.leaveType.isActive) return false;
  if (policy.effectiveFrom > now) return false;
  if (policy.effectiveTo && policy.effectiveTo <= now) return false;

  return prisma.$transaction(async (tx) => {
    await postCarryoverExpirationIfNeeded(tx, { assignment, policy, now });

    const periodKey = periodKeyForMethod(policy.accrualMethod, now);
    const idempotencyKey = `${assignment.id}:${periodKey}`;
    const already = await tx.hrLeaveLedgerEntry.findUnique({ where: { idempotencyKey } });
    if (already) return false;

    let rawAmount;
    if (policy.accrualMethod === 'PER_HOUR_WORKED') {
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth() + 1;
      const workedMinutes = await regularMinutesWorkedInMonth(tx, { employeeProfileId: assignment.employeeProfileId, year, month });
      // accrualAmountMinutes means "minutes of leave earned per 60
      // minutes worked" for this method — documented default (see file
      // header), since there's only one Int field to carry the rate.
      rawAmount = Math.round((policy.accrualAmountMinutes || 0) * (workedMinutes / 60));
    } else {
      rawAmount = policy.accrualAmountMinutes || 0;
    }
    if (rawAmount <= 0) return false;

    let amount = rawAmount;
    if (policy.annualCapMinutes != null) {
      const soFar = await accruedSoFarThisYear(tx, { employeeProfileId: assignment.employeeProfileId, leaveTypeId: policy.leaveTypeId, year: now.getUTCFullYear() });
      amount = Math.max(0, Math.min(rawAmount, policy.annualCapMinutes - soFar));
    }
    if (amount <= 0) return false;

    try {
      await tx.hrLeaveLedgerEntry.create({
        data: {
          employeeProfileId: assignment.employeeProfileId,
          leaveTypeId: policy.leaveTypeId,
          agencyId: assignment.employeeProfile.agencyId,
          transactionType: 'ACCRUAL',
          minutes: amount,
          reason: `${policy.accrualMethod} accrual for ${periodKey}`,
          idempotencyKey,
          createdAt: now, // see postCarryoverExpirationIfNeeded's own comment on why this is explicit
        },
      });
    } catch (err) {
      // P2002 = unique constraint violation on idempotencyKey — a
      // concurrent run already posted this exact period. Treat as a
      // successful no-op, never a double-post and never an error.
      if (err.code === 'P2002') return false;
      throw err;
    }
    return true;
  });
}

async function postAccrualsForOpenPolicies({ now = new Date() } = {}) {
  const assignments = await prisma.hrLeavePolicyAssignment.findMany({
    where: {
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    include: {
      leavePolicy: { include: { leaveType: true } },
      employeeProfile: { select: { id: true, agencyId: true } },
    },
  });

  let posted = 0;
  for (const assignment of assignments) {
    // eslint-disable-next-line no-await-in-loop
    const didPost = await postAccrualForAssignment(assignment, now);
    if (didPost) posted += 1;
  }
  return { posted, checked: assignments.length };
}

let intervalHandle = null;
function startHrLeaveAccrualJob(intervalMs = 60 * 60 * 1000) {
  if (intervalHandle) return intervalHandle;
  intervalHandle = setInterval(() => {
    postAccrualsForOpenPolicies().catch((err) => console.error('[hrLeaveAccrual] job failed:', err));
  }, intervalMs);
  if (intervalHandle.unref) intervalHandle.unref();
  return intervalHandle;
}

module.exports = {
  postAccrualsForOpenPolicies,
  periodKeyForMethod,
  startHrLeaveAccrualJob,
};
