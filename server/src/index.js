const app = require('./app');
const { checkStaleLeads } = require('./lib/staleLeadReminders');
const { recomputeAllLeadPriorities } = require('./lib/leadPriorityRecompute');

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
