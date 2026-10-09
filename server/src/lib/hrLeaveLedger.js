// Backstage HR — Phase 1 Part C. HrLeaveLedgerEntry is the one and only
// source of truth for a leave balance (see docs/hr-suite/
// IMPLEMENTATION_STATUS.md's "non-negotiable" list) — no bare "current
// balance" integer is stored anywhere. A balance is always SUM(minutes)
// over the ledger for (employeeProfileId, leaveTypeId), computed fresh
// every time. This tiny helper is the one place that SUM lives, shared
// by leave.js (balance-denial check, GET /hr/leave/balance) and
// hrLeaveAccrual.js (annual-cap/carryover math) so the two never drift.
//
// `client` is whatever Prisma client/transaction handle the caller is
// already inside — a bare `prisma` for a simple read, or a `tx` inside
// `prisma.$transaction(...)` when the balance must be read-then-acted-on
// consistently (e.g. the leave-request approval flow).
async function getBalanceMinutes(client, { employeeProfileId, leaveTypeId }) {
  const agg = await client.hrLeaveLedgerEntry.aggregate({
    where: { employeeProfileId, leaveTypeId },
    _sum: { minutes: true },
  });
  return agg._sum.minutes || 0;
}

module.exports = { getBalanceMinutes };
