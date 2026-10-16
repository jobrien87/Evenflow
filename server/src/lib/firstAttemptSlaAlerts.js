const { prisma } = require('./db');
const { notifyUser } = require('./notifications');
const { TERMINAL_LEAD_STATUSES } = require('./leadStatusGroups');

// Speed-to-lead is the single most important response-time SLA a producer
// has: a lead worked within minutes converts far better than the same lead
// worked even half an hour later. This is a genuinely separate, much
// faster real-time check than staleLeadReminders.js's general "no
// engagement in N hours" sweep — it fires the moment a lead has sat
// assigned with literally zero first attempt for this many minutes, not
// hours, and it's about one specific measurable field (firstAttemptAt),
// not general activity.
//
// DEFAULT_SLA_MINUTES is the env-var/global fallback used when an agency
// has never set its own Agency.firstAttemptSlaMinutes — every agency's
// real, configured value (set via Agency Settings) takes precedence.
const DEFAULT_SLA_MINUTES = Number(process.env.FIRST_ATTEMPT_SLA_MINUTES) || 30;

// A lead already past the point of needing a first-attempt SLA (sold, or
// dispositioned as unworkable) is exempt — this alert is only ever about a
// lead that's genuinely still sitting there unworked. DEFAULT_CLOSED_STATUSES
// is the fallback used when an agency has never set its own
// Agency.closedLeadStatuses — every agency's real, configured value (set
// via Agency Settings' Lead Flow section) takes precedence.
const DEFAULT_CLOSED_STATUSES = TERMINAL_LEAD_STATUSES;

// Checked on a short interval (see index.js) — fires once per lead the
// moment it first breaches the SLA, guarded by its own dedicated
// firstAttemptSlaAlertSentAt column (never reused from
// staleLeadReminders.js's lastReminderSentAt, which has a different
// cadence and meaning).
async function checkFirstAttemptSla() {
  const now = Date.now();
  // The oldest any agency's own configured threshold could reasonably
  // reach a lead's assignedAt is unbounded in principle, so this upper
  // candidate set is bounded only by the already-selective filters below
  // (vendor-sourced, unassigned-no-attempt, not yet alerted) — the real
  // per-agency SLA minutes AND per-agency closed-status list are both
  // applied in JS per lead, since each lead's agency can configure a
  // different value for each.
  const candidates = await prisma.lead.findMany({
    where: {
      // Speed-to-lead is a real-time-vendor-intake SLA, not a general
      // CRM-activity metric — vendorId is only ever set by the
      // authenticated vendor-API intake path (vendorApi.js), never by
      // createLeadRecord (manual/bulk-import/back-catalog/telemarketer),
      // so it's a reliable, non-user-editable gate on which leads this
      // alert applies to.
      vendorId: { not: null },
      assignedToId: { not: null },
      assignedAt: { not: null },
      firstAttemptAt: null,
      firstAttemptSlaAlertSentAt: null,
    },
    include: {
      customer: { select: { firstName: true, lastName: true } },
      agency: { select: { firstAttemptSlaMinutes: true, closedLeadStatuses: true } },
    },
  });

  let alerted = 0;
  for (const lead of candidates) {
    if ((lead.agency?.closedLeadStatuses || DEFAULT_CLOSED_STATUSES).includes(lead.status)) continue;
    const slaMinutes = lead.agency?.firstAttemptSlaMinutes || DEFAULT_SLA_MINUTES;
    const breached = now - lead.assignedAt.getTime() >= slaMinutes * 60 * 1000;
    if (!breached) continue;

    const who = lead.customer ? `${lead.customer.firstName} ${lead.customer.lastName}` : 'This lead';
    await notifyUser({
      userId: lead.assignedToId,
      agencyId: lead.agencyId,
      type: 'lead.first_attempt_overdue',
      severity: 'CRITICAL',
      title: 'Speed to lead is blown — work this now',
      body: `${who} has been sitting for over ${slaMinutes} minutes with no first attempt. This needs to be worked immediately.`,
      relatedEntityType: 'Lead',
      relatedEntityId: lead.id,
    });
    await prisma.lead.update({ where: { id: lead.id }, data: { firstAttemptSlaAlertSentAt: new Date() } });
    alerted += 1;
  }

  return alerted;
}

module.exports = { checkFirstAttemptSla, DEFAULT_SLA_MINUTES, DEFAULT_CLOSED_STATUSES };
