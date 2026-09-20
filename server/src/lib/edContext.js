const { prisma } = require('./db');
const { computeProfitability, computeROI } = require('./financialCalc');
const { computeGoalActual, assembleAgencyReport } = require('./runningReport');

// Everything in here is plain arithmetic against real rows — per spec,
// "ED should use deterministic database calculations for goals, pace,
// counts, KPIs, priority" and the LLM should never be asked to compute
// what SQL can compute exactly.

async function buildProducerContext(user) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  const [openLeads, openTasks, monthlySales, goal] = await Promise.all([
    prisma.lead.count({ where: { assignedToId: user.id, status: { in: ['NEW', 'ASSIGNED', 'ATTEMPTED', 'CONTACTED', 'FOLLOW_UP'] } } }),
    prisma.task.count({ where: { assignedToId: user.id, status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
    // Same real "sales this month" count runningReport.js's goal-progress
    // math uses — one source of truth for what "actual" means, whether or
    // not a Goal row happens to exist.
    computeGoalActual({ metric: 'sales', userId: user.id, agencyId: user.agencyId, periodStart: monthStart, periodEnd: monthEnd }),
    prisma.goal.findFirst({ where: { userId: user.id, metric: 'sales', periodStart: { lte: now }, periodEnd: { gte: now } } }),
  ]);

  let pace = null;
  if (goal) {
    const totalDays = Math.max(1, Math.round((monthEnd - monthStart) / 86400000) + 1);
    const elapsedDays = Math.min(totalDays, Math.round((now - monthStart) / 86400000) + 1);
    const expectedByNow = (goal.targetValue * elapsedDays) / totalDays;
    pace = {
      goal: goal.targetValue,
      actual: monthlySales,
      expectedByNow: Math.round(expectedByNow * 10) / 10,
      aheadBehind: Math.round((monthlySales - expectedByNow) * 10) / 10,
    };
  }

  return {
    role: 'PRODUCER',
    firstName: user.firstName,
    openLeads,
    openTasks,
    monthlySales,
    pace,
  };
}

async function buildAgencyOwnerContext(agencyId) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [openLeads, overdueLeads, offeredTransfers, acceptedTransfers, rejectedTransfers, revenueAgg, costAgg, producerCount, agencyReport] = await Promise.all([
    prisma.lead.count({ where: { agencyId, status: { in: ['NEW', 'ASSIGNED', 'ATTEMPTED', 'CONTACTED', 'FOLLOW_UP'] } } }),
    prisma.lead.count({ where: { agencyId, status: { in: ['NEW', 'ASSIGNED'] }, receivedAt: { lt: new Date(now.getTime() - 60 * 60 * 1000) } } }),
    prisma.transfer.count({ where: { agencyId, createdAt: { gte: monthStart } } }),
    prisma.transfer.count({ where: { agencyId, status: { in: ['ACCEPTED', 'CONNECTED', 'COMPLETED', 'DISPOSITIONED'] }, createdAt: { gte: monthStart } } }),
    prisma.transfer.count({ where: { agencyId, status: 'REJECTED', createdAt: { gte: monthStart } } }),
    prisma.revenueEvent.aggregate({ where: { agencyId, occurredAt: { gte: monthStart } }, _sum: { amountCents: true } }),
    prisma.costEvent.aggregate({ where: { agencyId, occurredAt: { gte: monthStart } }, _sum: { amountCents: true } }),
    prisma.user.count({ where: { agencyId, role: 'PRODUCER', status: 'ACTIVE' } }),
    // Real per-producer Flow Score + trend, reusing the exact same roster
    // assembleAgencyReport already builds for Running Reports — never a
    // second scoring pass — so Ed can answer "who needs attention" grounded
    // in real numbers instead of only aggregate agency totals.
    assembleAgencyReport(agencyId),
  ]);

  const revenueCents = revenueAgg._sum.amountCents || 0;
  const costCents = costAgg._sum.amountCents || 0;
  const profitability = computeProfitability({ revenueCents, costCents });

  return {
    role: 'AGENCY_OWNER',
    openLeads,
    overdueLeads,
    producerCount,
    transfersThisMonth: offeredTransfers,
    transfersAccepted: acceptedTransfers,
    transfersRejected: rejectedTransfers,
    transferAcceptanceRate: offeredTransfers > 0 ? Math.round((acceptedTransfers / offeredTransfers) * 1000) / 10 : null,
    monthRevenue: profitability.revenue,
    monthCost: profitability.cost,
    monthGrossProfit: profitability.grossProfit,
    marginPercent: profitability.marginPercent,
    producerRoster: agencyReport.roster,
  };
}

async function buildPlatformOwnerContext() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [totalAgencies, activeAgencies, totalTMs, activeTMs, offeredTransfers, missedTransfers, revenueAgg, costAgg, openTickets] = await Promise.all([
    prisma.agency.count(),
    prisma.agency.count({ where: { status: 'ACTIVE' } }),
    prisma.user.count({ where: { role: 'TELEMARKETER' } }),
    prisma.user.count({ where: { role: 'TELEMARKETER', status: 'ACTIVE' } }),
    prisma.transfer.count({ where: { createdAt: { gte: monthStart } } }),
    prisma.transfer.count({ where: { status: 'MISSED', createdAt: { gte: monthStart } } }),
    prisma.revenueEvent.aggregate({ where: { occurredAt: { gte: monthStart } }, _sum: { amountCents: true } }),
    prisma.costEvent.aggregate({ where: { occurredAt: { gte: monthStart } }, _sum: { amountCents: true } }),
    prisma.supportTicket.count({ where: { status: 'OPEN' } }),
  ]);

  const revenueCents = revenueAgg._sum.amountCents || 0;
  const costCents = costAgg._sum.amountCents || 0;
  const profitability = computeProfitability({ revenueCents, costCents });
  const roi = computeROI({ revenueCents, costCents });

  return {
    role: 'PLATFORM_OWNER',
    totalAgencies,
    activeAgencies,
    totalTMs,
    activeTMs,
    transfersThisMonth: offeredTransfers,
    missedTransfers,
    monthRevenue: profitability.revenue,
    monthCost: profitability.cost,
    monthGrossProfit: profitability.grossProfit,
    roiPercent: roi.roiPercent,
    openSupportTickets: openTickets,
  };
}

async function buildContextForUser(user) {
  if (user.role === 'PRODUCER') return buildProducerContext(user);
  if (user.role === 'AGENCY_OWNER' || user.role === 'AGENCY_MANAGER') return buildAgencyOwnerContext(user.agencyId);
  if (user.role === 'PLATFORM_OWNER') return buildPlatformOwnerContext();
  return { role: user.role };
}

// Real deltas since this user's last briefing (or the last 24h, the first
// time) — never a second, editorialized summary, just plain counts/score
// movement the LLM (or the honest deterministic fallback) writes up.
async function buildBriefingContext(user) {
  const since = user.lastBriefingAt || new Date(Date.now() - 24 * 60 * 60 * 1000);
  const now = new Date();
  const sinceHours = Math.max(1, Math.round((now - since) / (60 * 60 * 1000)));

  if (user.role === 'PRODUCER') {
    const [newLeads, newSales, currentSnapshot, priorSnapshot, goal] = await Promise.all([
      prisma.lead.count({ where: { assignedToId: user.id, receivedAt: { gte: since } } }),
      prisma.leadEvent.count({ where: { type: 'lead.disposition', toStatus: 'SOLD', createdAt: { gte: since }, lead: { assignedToId: user.id } } }),
      prisma.flowScoreSnapshot.findFirst({ where: { subjectType: 'USER', subjectId: user.id }, orderBy: { computedAt: 'desc' } }),
      prisma.flowScoreSnapshot.findFirst({ where: { subjectType: 'USER', subjectId: user.id, computedAt: { lte: since } }, orderBy: { computedAt: 'desc' } }),
      prisma.goal.findFirst({ where: { userId: user.id, metric: 'sales', periodStart: { lte: now }, periodEnd: { gte: now } } }),
    ]);

    let goalPace = null;
    if (goal) {
      const actual = await computeGoalActual({ metric: 'sales', userId: user.id, agencyId: user.agencyId, periodStart: goal.periodStart, periodEnd: goal.periodEnd });
      goalPace = { target: goal.targetValue, actual };
    }

    return {
      role: 'PRODUCER',
      sinceHours,
      newLeads,
      newSales,
      flowScoreNow: currentSnapshot ? currentSnapshot.score : null,
      flowScoreDelta: currentSnapshot && priorSnapshot ? currentSnapshot.score - priorSnapshot.score : null,
      goalPace,
    };
  }

  if (user.role === 'AGENCY_OWNER' || user.role === 'AGENCY_MANAGER') {
    const agencyId = user.agencyId;
    const [newLeads, newTransfers, newSales, currentSnapshot, priorSnapshot] = await Promise.all([
      prisma.lead.count({ where: { agencyId, receivedAt: { gte: since } } }),
      prisma.transfer.count({ where: { agencyId, createdAt: { gte: since } } }),
      prisma.leadEvent.count({ where: { type: 'lead.disposition', toStatus: 'SOLD', createdAt: { gte: since }, lead: { agencyId } } }),
      prisma.flowScoreSnapshot.findFirst({ where: { subjectType: 'AGENCY', subjectId: agencyId }, orderBy: { computedAt: 'desc' } }),
      prisma.flowScoreSnapshot.findFirst({ where: { subjectType: 'AGENCY', subjectId: agencyId, computedAt: { lte: since } }, orderBy: { computedAt: 'desc' } }),
    ]);

    return {
      role: 'AGENCY_OWNER',
      sinceHours,
      newLeads,
      newTransfers,
      newSales,
      flowScoreNow: currentSnapshot ? currentSnapshot.score : null,
      flowScoreDelta: currentSnapshot && priorSnapshot ? currentSnapshot.score - priorSnapshot.score : null,
    };
  }

  if (user.role === 'PLATFORM_OWNER') {
    const [newAgencies, newTransfers, missedTransfers] = await Promise.all([
      prisma.agency.count({ where: { createdAt: { gte: since } } }),
      prisma.transfer.count({ where: { createdAt: { gte: since } } }),
      prisma.transfer.count({ where: { status: 'MISSED', createdAt: { gte: since } } }),
    ]);

    return { role: 'PLATFORM_OWNER', sinceHours, newAgencies, newTransfers, missedTransfers };
  }

  return { role: user.role, sinceHours };
}

module.exports = { buildContextForUser, buildProducerContext, buildAgencyOwnerContext, buildPlatformOwnerContext, buildBriefingContext };
