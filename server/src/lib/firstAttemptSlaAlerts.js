const { prisma } = require('./db');
const { notifyUser } = require('./notifications');

// Speed-to-lead is the single most important response-time SLA a producer
// has: a lead worked within minutes converts far better than the same lead
// worked even half an hour later. This is a genuinely separate, much
// faster real-time check than staleLeadReminders.js's general "no
// engagement in N hours" sweep — it fires the moment a lead has sat
// assigned with literally zero first attempt for this many minutes, not
// hours, and it's about one specific measurable field (firstAttemptAt),
// not general activity.
const SLA_MINUTES = Number(process.env.FIRST_ATTEMPT_SLA_MINUTES) || 30;

// A lead already past the point of needing a first-attempt SLA (sold, or
// dispositioned as unworkable) is exempt — this alert is only ever about a
// lead that's genuinely still sitting there unworked.
const TERMINAL_STATUSES = [
  'SOLD', 'LOST', 'BAD_CONTACT', 'DUPLICATE', 'DO_NOT_CONTACT', 'ARCHIVED',
  'NOT_INTERESTED', 'INELIGIBLE',
];

// Checked on a short interval (see index.js) — fires once per lead the
// moment it first breaches the SLA, guarded by its own dedicated
// firstAttemptSlaAlertSentAt column (never reused from
// staleLeadReminders.js's lastReminderSentAt, which has a different
// cadence and meaning).
async function checkFirstAttemptSla() {
  const cutoff = new Date(Date.now() - SLA_MINUTES * 60 * 1000);

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
      firstAttemptAt: null,
      status: { notIn: TERMINAL_STATUSES },
      assignedAt: { lt: cutoff },
      firstAttemptSlaAlertSentAt: null,
    },
    include: { customer: { select: { firstName: true, lastName: true } } },
  });

  for (const lead of candidates) {
    const who = lead.customer ? `${lead.customer.firstName} ${lead.customer.lastName}` : 'This lead';
    await notifyUser({
      userId: lead.assignedToId,
      agencyId: lead.agencyId,
      type: 'lead.first_attempt_overdue',
      severity: 'CRITICAL',
      title: 'Speed to lead is blown — work this now',
      body: `${who} has been sitting for over ${SLA_MINUTES} minutes with no first attempt. This needs to be worked immediately.`,
      relatedEntityType: 'Lead',
      relatedEntityId: lead.id,
    });
    await prisma.lead.update({ where: { id: lead.id }, data: { firstAttemptSlaAlertSentAt: new Date() } });
  }

  return candidates.length;
}

module.exports = { checkFirstAttemptSla, SLA_MINUTES };
