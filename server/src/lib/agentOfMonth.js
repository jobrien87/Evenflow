// Auto-computes and awards the AGENT_OF_THE_MONTH badge for a real,
// already-completed calendar month — never the current, still-in-
// progress one, so the winner is never decided on a partial count.
// Idempotent via UserBadge's @@unique([userId, type, periodLabel]): the
// same month is never awarded twice, even if this runs more than once.

const { prisma } = require('./db');

function monthLabel(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

// { start, end } for the calendar month immediately before `now`.
function previousMonthRange(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start, end, label: monthLabel(start) };
}

// Pure — picks the winner from an already-fetched list of SOLD leads for
// one agency/month: highest sold count, ties broken by higher total
// premium. Returns null if nobody sold anything that month (never
// fabricates a winner).
function pickWinner(soldLeads) {
  const byProducer = new Map();
  for (const lead of soldLeads) {
    if (!lead.assignedToId) continue;
    const row = byProducer.get(lead.assignedToId) || { userId: lead.assignedToId, soldCount: 0, premiumCents: 0 };
    row.soldCount += 1;
    row.premiumCents += lead.salePremiumCents || 0;
    byProducer.set(lead.assignedToId, row);
  }
  const rows = Array.from(byProducer.values());
  if (rows.length === 0) return null;
  rows.sort((a, b) => b.soldCount - a.soldCount || b.premiumCents - a.premiumCents);
  return rows[0];
}

// Awards last month's AGENT_OF_THE_MONTH badge for every agency that
// doesn't already have one for that period — safe to call repeatedly
// (e.g. from a periodic in-process check), only ever does real work once
// per agency per month.
async function checkAgentOfMonth(now = new Date()) {
  const { start, end, label } = previousMonthRange(now);
  const agencies = await prisma.agency.findMany({ select: { id: true } });
  let awarded = 0;

  for (const agency of agencies) {
    const existing = await prisma.userBadge.findFirst({
      where: { agencyId: agency.id, type: 'AGENT_OF_THE_MONTH', periodLabel: label },
    });
    if (existing) continue;

    const soldLeads = await prisma.lead.findMany({
      where: { agencyId: agency.id, status: 'SOLD', updatedAt: { gte: start, lt: end } },
      select: { assignedToId: true, salePremiumCents: true },
    });
    const winner = pickWinner(soldLeads);
    if (!winner) continue;

    await prisma.userBadge.create({
      data: { userId: winner.userId, agencyId: agency.id, type: 'AGENT_OF_THE_MONTH', periodLabel: label },
    });
    awarded += 1;
  }

  return { period: label, awarded };
}

module.exports = { checkAgentOfMonth, pickWinner, previousMonthRange, monthLabel };
