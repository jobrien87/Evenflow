// Disposition-based follow-up rules (Agency.followUpRules) — an agency
// owner configures, per LeadStatus, how many days later a dispositioned
// lead should get a real Follow-Up Task auto-created, exactly the same
// kind of task a producer can already create by hand on a lead
// (type: 'FOLLOW_UP'). This is deliberately a NEW, separate mechanism from
// lib/priority.js's statusRules (which only ever nudges priorityScore for
// sort order) — see that file's own header comment. Runs as a periodic
// in-process check (registered from index.js via setInterval), same
// "no unnecessary paid infrastructure" pattern as staleLeadReminders.js.

const { prisma } = require('./db');
const { notifyUser } = require('./notifications');

// Pure — the one true place that reads Agency.followUpRules and decides
// whether/when a disposition into `status` should schedule a follow-up.
// followUpRules shape: { [LeadStatus]: afterDays }. Returns null when the
// status has no configured rule (today's exact behavior: nothing
// scheduled).
function computeFollowUpAt(status, followUpRules, now = new Date()) {
  if (!followUpRules || typeof followUpRules !== 'object') return null;
  const afterDays = followUpRules[status];
  if (!Number.isFinite(afterDays) || afterDays <= 0) return null;
  return new Date(now.getTime() + afterDays * 24 * 60 * 60 * 1000);
}

const STATUS_LABELS = {
  NEW: 'New', CONTACTED: 'Contacted', LEFT_VM: 'Left VM', APPOINTMENT: 'Appointment',
  QUOTED: 'Quoted', QUOTED_HOT: 'Quoted (Hot)', FOLLOW_UP: 'Follow Up', SOLD: 'Sold',
  LOST: 'Lost', NOT_INTERESTED: 'Not Interested', BAD_CONTACT: 'Bad Contact',
  DUPLICATE: 'Duplicate', DO_NOT_CONTACT: 'Do Not Contact', INELIGIBLE: 'Ineligible',
  ARCHIVED: 'Archived',
};

// Finds every lead whose scheduled follow-up has arrived, creates the
// real Follow-Up Task, notifies the current assignee, and clears
// followUpAt — idempotent by construction (followUpAt only transitions
// forward: set at disposition, cleared here; a lead only ever has at most
// one pending follow-up at a time).
async function checkLeadFollowUps(now = new Date()) {
  const dueLeads = await prisma.lead.findMany({
    where: { followUpAt: { lte: now } },
    select: {
      id: true, agencyId: true, status: true, assignedToId: true, customerId: true,
      customer: { select: { firstName: true, lastName: true } },
    },
  });

  let createdCount = 0;
  for (const lead of dueLeads) {
    // Re-check assignment fresh (not whatever it was at disposition time)
    // — a lead reassigned since then should get its new assignee's task.
    // An unassigned lead has nobody to put a task in front of; clear the
    // pending follow-up rather than retry it forever or create an orphan.
    if (!lead.assignedToId) {
      await prisma.lead.update({ where: { id: lead.id }, data: { followUpAt: null } });
      continue;
    }

    const customerName = lead.customer ? `${lead.customer.firstName} ${lead.customer.lastName}`.trim() : null;
    const statusLabel = STATUS_LABELS[lead.status] || lead.status;

    await prisma.$transaction([
      prisma.task.create({
        data: {
          agencyId: lead.agencyId,
          leadId: lead.id,
          type: 'FOLLOW_UP',
          title: `Follow up: ${customerName || 'this lead'} (${statusLabel})`,
          assignedToId: lead.assignedToId,
          dueAt: now,
        },
      }),
      prisma.lead.update({ where: { id: lead.id }, data: { followUpAt: null } }),
    ]);

    await notifyUser({
      userId: lead.assignedToId,
      agencyId: lead.agencyId,
      type: 'lead.follow_up_due',
      severity: 'INFO',
      title: 'Follow-up due',
      body: `${customerName || 'A lead'} is due for a follow-up (was ${statusLabel}).`,
      relatedEntityType: 'Lead',
      relatedEntityId: lead.id,
    });

    createdCount += 1;
  }

  return { checked: dueLeads.length, created: createdCount };
}

module.exports = { computeFollowUpAt, checkLeadFollowUps, STATUS_LABELS };
