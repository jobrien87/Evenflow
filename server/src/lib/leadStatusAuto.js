const { prisma } = require('./db');
const { scoreLead } = require('./priority');
const { computeProducerScore, computeAgencyScore, computeTelemarketerScore } = require('./flowScore');

// Ranks a lead's real pipeline progress so an automatic status change (from
// a real logged action — a call, a quote, a sale) only ever moves a lead
// forward, and never overrides a status that's already further along,
// including any terminal/negative disposition a human already chose
// (LOST, NOT_INTERESTED, ...). Auto-advance is a convenience on top of the
// manual disposition flow, never a replacement for it — it can only save
// an agent a step, never take one away.
const STATUS_RANK = {
  NEW: 0,
  LEFT_VM: 1,
  CONTACTED: 2,
  APPOINTMENT: 3,
  QUOTED: 4, QUOTED_HOT: 4, FOLLOW_UP: 4,
  SOLD: 5,
  LOST: 99, NOT_INTERESTED: 99, BAD_CONTACT: 99, DUPLICATE: 99,
  DO_NOT_CONTACT: 99, INELIGIBLE: 99, ARCHIVED: 99,
};

// Called after a real action that implies pipeline progress — an outbound
// or inbound activity logged, a product marked QUOTED or SOLD — so a lead
// never sits stuck on NEW ("untouched") despite real work already being
// done on it. Fetches its own fresh copy of the lead rather than
// trusting a caller's possibly-stale copy, since this runs after other
// writes in the same request. Returns the updated lead, or null if no
// advance happened (already at or past targetStatus).
async function autoAdvanceLeadStatus({ leadId, targetStatus, reason }) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { createdBy: { select: { role: true } } } });
  if (!lead) return null;

  const currentRank = STATUS_RANK[lead.status] ?? 0;
  const targetRank = STATUS_RANK[targetStatus] ?? 0;
  if (currentRank >= targetRank) return null;

  const now = new Date();
  const patch = { status: targetStatus };
  if (lead.status === 'NEW' && !lead.firstAttemptAt && targetStatus === 'CONTACTED') {
    patch.firstAttemptAt = now;
  }
  if (targetStatus === 'CONTACTED' && !lead.firstContactAt) {
    patch.firstContactAt = now;
  }

  const [updated] = await prisma.$transaction([
    prisma.lead.update({ where: { id: leadId }, data: patch }),
    prisma.leadEvent.create({
      data: {
        leadId,
        type: 'lead.status_auto_advanced',
        fromStatus: lead.status,
        toStatus: targetStatus,
        metadata: { reason, auto: true },
      },
    }),
  ]);

  const agencyRow = await prisma.agency.findUnique({ where: { id: lead.agencyId }, select: { priorityRules: true } });
  const { priorityScore, priorityReason } = scoreLead(updated, agencyRow?.priorityRules);
  await prisma.lead.update({ where: { id: leadId }, data: { priorityScore, priorityReason } });

  // Mirrors the manual disposition route's own recompute — an auto-advance
  // reflects the same real conversion/responsiveness signal a manual one
  // does, so it must count the same way for scoring.
  Promise.all([
    updated.assignedToId ? computeProducerScore(updated.assignedToId) : Promise.resolve(),
    computeAgencyScore(lead.agencyId),
    lead.createdById && lead.createdBy?.role === 'TELEMARKETER' ? computeTelemarketerScore(lead.createdById) : Promise.resolve(),
  ]).catch((err) => console.error('[flowScore] recompute after auto status advance failed', err.message));

  return updated;
}

module.exports = { autoAdvanceLeadStatus, STATUS_RANK };
