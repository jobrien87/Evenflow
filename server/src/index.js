const app = require('./app');
const { checkStaleLeads } = require('./lib/staleLeadReminders');
const { checkLeadFollowUps } = require('./lib/leadFollowUp');
const { recomputeAllLeadPriorities } = require('./lib/leadPriorityRecompute');
const { checkFirstAttemptSla } = require('./lib/firstAttemptSlaAlerts');
const { checkAgentOfMonth } = require('./lib/agentOfMonth');
const { startHrAttendanceDetectionJob } = require('./jobs/hrAttendanceDetection');
const { startHrLeaveAccrualJob } = require('./lib/hrLeaveAccrual');
const { backfillMissingSales } = require('./lib/missingSaleBackfill');

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`EvenFlow server listening on port ${PORT}`);
});

// Periodic in-process check (no separate job queue) — see
// lib/staleLeadReminders.js for why a lead qualifies and the honest
// scale tradeoff this makes.
setInterval(() => {
  checkStaleLeads().catch((err) => console.error('[staleLeadReminders] check failed', err.message));
}, 30 * 60 * 1000);

// Agency-configurable disposition-based follow-up (Agency.followUpRules)
// — same in-process pattern. See lib/leadFollowUp.js.
setInterval(() => {
  checkLeadFollowUps().catch((err) => console.error('[leadFollowUp] check failed', err.message));
}, 15 * 60 * 1000);

// Same in-process pattern — keeps stored Lead/Opportunity priorityScore
// fresh between creation/disposition events. See lib/leadPriorityRecompute.js.
setInterval(() => {
  recomputeAllLeadPriorities().catch((err) => console.error('[leadPriorityRecompute] recompute failed', err.message));
}, 15 * 60 * 1000);

// A much tighter interval than the two above — speed-to-lead is urgent by
// nature, so a blown SLA needs to reach the producer in a couple of
// minutes, not half an hour. See lib/firstAttemptSlaAlerts.js.
setInterval(() => {
  checkFirstAttemptSla().catch((err) => console.error('[firstAttemptSlaAlerts] check failed', err.message));
}, 2 * 60 * 1000);

// Monthly, but checked on a much tighter interval since there's no real
// scheduler — idempotent (UserBadge's unique constraint), so a redundant
// check every few hours just confirms "already awarded" and no-ops. See
// lib/agentOfMonth.js.
setInterval(() => {
  checkAgentOfMonth().catch((err) => console.error('[agentOfMonth] check failed', err.message));
}, 6 * 60 * 60 * 1000);

// Backstage HR — read-only TimeClockEntry anomaly detection (forgotten
// clock-outs only, in Part B's scope). See jobs/hrAttendanceDetection.js.
startHrAttendanceDetectionJob();

// Backstage HR Phase 1 Part C — idempotent leave-accrual posting. See
// lib/hrLeaveAccrual.js; a deterministic idempotencyKey means a redundant
// hourly check just confirms "already posted" and no-ops, same pattern
// as agentOfMonth.js above.
startHrLeaveAccrualJob();

// Closes the existing backlog of leads marked SOLD with no Closed Sale
// ever logged — platform-wide, once per boot. Idempotent (its own
// selection query only ever finds leads still missing a Sale), same
// "redundant run just confirms already-done and no-ops" convention as
// agentOfMonth above — this is what makes the backfill run automatically
// on every deploy with no manual step. See lib/missingSaleBackfill.js.
backfillMissingSales().catch((err) => console.error('[missingSaleBackfill] run failed', err.message));
