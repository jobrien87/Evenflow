const app = require('./app');
const { checkStaleLeads } = require('./lib/staleLeadReminders');

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
