// Nudges an owning producer when a lead has sat without any real
// engagement (a note, a logged call/email/text activity, or a
// disposition change) for too long. Runs as a periodic in-process check
// (registered from index.js via setInterval) rather than a real job
// queue — same honest "no unnecessary paid infrastructure" tradeoff
// callProcessing.js already makes for this app's scale.

const { prisma } = require('./db');
const { notifyUser } = require('./notifications');
const { TERMINAL_LEAD_STATUSES } = require('./leadStatusGroups');

// DEFAULT_STALE_HOURS is the env-var/global fallback used when an agency
// has never set its own Agency.staleLeadHours — every agency's real,
// configured value (set via Agency Settings) takes precedence.
const DEFAULT_STALE_HOURS = Number(process.env.STALE_LEAD_HOURS) || 4;

// Closed-out statuses mean the lead is done one way or another — nothing
// to remind anyone about. DEFAULT_CLOSED_STATUSES is the fallback used
// when an agency has never set its own Agency.closedLeadStatuses.
const DEFAULT_CLOSED_STATUSES = TERMINAL_LEAD_STATUSES;

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

// The most recent moment real engagement happened on this lead — a note,
// a logged activity, or a disposition change (LeadEvent's system-written
// 'lead.created'/'lead.claimed' rows don't count as engagement; only an
// actual disposition move does).
function lastEngagementAt(lead) {
  const timestamps = [
    ...lead.notes.map((n) => n.createdAt),
    ...lead.activities.map((a) => a.occurredAt),
    ...lead.events.filter((e) => e.type === 'lead.disposition').map((e) => e.createdAt),
  ];
  if (timestamps.length === 0) return null;
  return timestamps.reduce((max, t) => (t > max ? t : max), timestamps[0]);
}

async function checkStaleLeads() {
  // Each lead's own agency may configure a different staleLeadHours, so
  // the staleness cutoff can't be a single DB-level filter — it's applied
  // in JS per lead below. The candidate set is still narrowed server-side
  // by every other, agency-independent condition.
  const candidates = await prisma.lead.findMany({
    where: {
      assignedToId: { not: null },
      assignedAt: { not: null },
    },
    include: {
      customer: { select: { firstName: true, lastName: true } },
      agency: { select: { staleLeadHours: true, closedLeadStatuses: true } },
      notes: { select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      activities: { select: { occurredAt: true }, orderBy: { occurredAt: 'desc' }, take: 1 },
      events: { where: { type: 'lead.disposition' }, select: { createdAt: true, type: true }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  let checkedCount = 0;
  let remindedCount = 0;
  for (const lead of candidates) {
    if ((lead.agency?.closedLeadStatuses || DEFAULT_CLOSED_STATUSES).includes(lead.status)) continue;
    const staleHours = lead.agency?.staleLeadHours || DEFAULT_STALE_HOURS;
    const cutoff = hoursAgo(staleHours);
    if (lead.assignedAt >= cutoff) continue;
    if (lead.lastReminderSentAt && lead.lastReminderSentAt >= cutoff) continue;
    checkedCount += 1;

    const engagedAt = lastEngagementAt(lead);
    if (engagedAt && engagedAt >= cutoff) continue;

    await notifyUser({
      userId: lead.assignedToId,
      agencyId: lead.agencyId,
      type: 'lead.stale',
      severity: 'WARNING',
      title: 'Lead needs a note or update',
      body: `${lead.customer ? `${lead.customer.firstName} ${lead.customer.lastName}` : 'This lead'} hasn't had a note, activity, or disposition in over ${staleHours} hours.`,
      relatedEntityType: 'Lead',
      relatedEntityId: lead.id,
    });

    await prisma.lead.update({ where: { id: lead.id }, data: { lastReminderSentAt: new Date() } });
    remindedCount += 1;
  }

  return { checked: checkedCount, reminded: remindedCount };
}

module.exports = { checkStaleLeads, DEFAULT_STALE_HOURS, DEFAULT_CLOSED_STATUSES };
