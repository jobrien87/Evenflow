// Nudges an owning producer when a lead has sat without any real
// engagement (a note, a logged call/email/text activity, or a
// disposition change) for too long. Runs as a periodic in-process check
// (registered from index.js via setInterval) rather than a real job
// queue — same honest "no unnecessary paid infrastructure" tradeoff
// callProcessing.js already makes for this app's scale.

const { prisma } = require('./db');
const { notifyUser } = require('./notifications');

const STALE_HOURS = Number(process.env.STALE_LEAD_HOURS) || 4;

// Terminal statuses mean the lead is closed out one way or another —
// nothing to remind anyone about.
const TERMINAL_STATUSES = ['SOLD', 'LOST', 'BAD_CONTACT', 'DUPLICATE', 'DO_NOT_CONTACT', 'ARCHIVED'];

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
  const cutoff = hoursAgo(STALE_HOURS);

  const candidates = await prisma.lead.findMany({
    where: {
      assignedToId: { not: null },
      status: { notIn: TERMINAL_STATUSES },
      assignedAt: { lt: cutoff },
      OR: [{ lastReminderSentAt: null }, { lastReminderSentAt: { lt: cutoff } }],
    },
    include: {
      customer: { select: { firstName: true, lastName: true } },
      notes: { select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      activities: { select: { occurredAt: true }, orderBy: { occurredAt: 'desc' }, take: 1 },
      events: { where: { type: 'lead.disposition' }, select: { createdAt: true, type: true }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  let remindedCount = 0;
  for (const lead of candidates) {
    const engagedAt = lastEngagementAt(lead);
    if (engagedAt && engagedAt >= cutoff) continue;

    await notifyUser({
      userId: lead.assignedToId,
      agencyId: lead.agencyId,
      type: 'lead.stale',
      severity: 'WARNING',
      title: 'Lead needs a note or update',
      body: `${lead.customer ? `${lead.customer.firstName} ${lead.customer.lastName}` : 'This lead'} hasn't had a note, activity, or disposition in over ${STALE_HOURS} hours.`,
      relatedEntityType: 'Lead',
      relatedEntityId: lead.id,
    });

    await prisma.lead.update({ where: { id: lead.id }, data: { lastReminderSentAt: new Date() } });
    remindedCount += 1;
  }

  return { checked: candidates.length, reminded: remindedCount };
}

module.exports = { checkStaleLeads, STALE_HOURS };
