const app = require('./app');
const { checkStaleLeads } = require('./lib/staleLeadReminders');
const { recomputeAllLeadPriorities } = require('./lib/leadPriorityRecompute');
const { checkFirstAttemptSla } = require('./lib/firstAttemptSlaAlerts');

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
