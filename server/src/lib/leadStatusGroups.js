// Shared LeadStatus groupings — the one place that decides "which
// statuses count as X," so adding a new status to the LeadStatus enum
// (QUOTED_HOT, LEFT_VM, etc. were all added after the enum's original
// set) never again means hunting down every hand-rolled ['QUOTED', ...]
// array across funnelMetrics.js/performanceBreakdown.js/zipBreakdown.js/
// financials.js/leads.js/workqueue.js that forgot to include it.

// A lead reaching any of these has been actively worked past first
// contact — used for "quoted or beyond" rate numerators. SOLD is
// included (a sold lead obviously reached at least the quoted stage).
const QUOTED_OR_BEYOND_STATUSES = ['QUOTED', 'QUOTED_HOT', 'APPOINTMENT', 'FOLLOW_UP', 'SOLD'];

// Reached some kind of final disposition — the lead is done being worked,
// one way or another. SOLD is handled separately everywhere credit/
// revenue is concerned (see financialEvents.js/sales.js), but it is still
// a terminal status for queue-membership purposes: "Lead SOLD only
// removes the lead from the queue," same as every other terminal status.
const TERMINAL_LEAD_STATUSES = ['SOLD', 'LOST', 'NOT_INTERESTED', 'BAD_CONTACT', 'DUPLICATE', 'DO_NOT_CONTACT', 'INELIGIBLE', 'ARCHIVED'];

// Everything else — a lead still open for a producer to act on, and
// therefore still belonging in an active work queue.
const ACTIVE_LEAD_STATUSES = ['NEW', 'CONTACTED', 'LEFT_VM', 'APPOINTMENT', 'QUOTED', 'QUOTED_HOT', 'FOLLOW_UP'];

module.exports = { QUOTED_OR_BEYOND_STATUSES, TERMINAL_LEAD_STATUSES, ACTIVE_LEAD_STATUSES };
