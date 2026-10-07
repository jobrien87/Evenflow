// Running Reports — a real-time assembly view over data that already
// persists (Flow Score snapshots, funnel metrics, call analysis, goals).
// Nothing here is a second, divergent calculation: every number is either
// read directly from an existing snapshot/row or computed by the same
// functions the standalone Flow Score / funnel endpoints already use.

const { prisma } = require('./db');
const { explainScore } = require('./flowScore');
const { computeFunnel } = require('./funnelMetrics');
const { sumHistoricalPremium, countHistoricalSold } = require('./historicalAggregates');
const { sumSalePremium, countSales } = require('./manualSaleAggregates');

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

async function latestSnapshot(subjectType, subjectId) {
  return prisma.flowScoreSnapshot.findFirst({ where: { subjectType, subjectId }, orderBy: { computedAt: 'desc' } });
}

async function snapshotHistory(subjectType, subjectId, take) {
  return prisma.flowScoreSnapshot.findMany({
    where: { subjectType, subjectId },
    orderBy: { computedAt: 'desc' },
    take,
    select: { id: true, score: true, computedAt: true },
  });
}

// history is newest-first (as snapshotHistory returns it).
function trendDirection(history) {
  if (history.length < 2) return null;
  const diff = history[0].score - history[history.length - 1].score;
  if (diff > 2) return 'UP';
  if (diff < -2) return 'DOWN';
  return 'FLAT';
}

async function flowScoreBlock(subjectType, subjectId, trendSize = 5) {
  const [snapshot, history] = await Promise.all([
    latestSnapshot(subjectType, subjectId),
    snapshotHistory(subjectType, subjectId, trendSize),
  ]);
  return {
    current: snapshot ? { score: snapshot.score, computedAt: snapshot.computedAt, explanation: explainScore(snapshot) } : null,
    trend: [...history].reverse(), // oldest -> newest, ready for a line chart
  };
}

// Real counts for whatever a Goal's metric is, over its own period — the
// same "no fabrication" rule as everywhere else: an unrecognized metric
// returns null rather than a guessed number.
async function computeGoalActual(goal) {
  const { metric, userId, agencyId, periodStart, periodEnd } = goal;
  const leadScope = { agencyId, ...(userId ? { assignedToId: userId } : {}) };

  switch (metric) {
    case 'sales': {
      const live = await prisma.leadEvent.count({
        where: { type: 'lead.disposition', toStatus: 'SOLD', createdAt: { gte: periodStart, lte: periodEnd }, lead: leadScope },
      });
      // Historical Data (Back Catalog) and Add Closed Sale (standalone)
      // rows count toward sold-count goals too — never toward response-
      // speed/pipeline-stage metrics (quotes, contacts), since those rows
      // never had those real touchpoints tracked.
      const historical = await countHistoricalSold({ agencyId, from: periodStart, to: periodEnd, assignedToId: userId || undefined });
      const manual = await countSales({ agencyId, from: periodStart, to: periodEnd, assignedToId: userId || undefined });
      return live + historical + manual;
    }
    case 'quotes':
      return prisma.leadEvent.count({
        where: { type: 'lead.disposition', toStatus: 'QUOTED', createdAt: { gte: periodStart, lte: periodEnd }, lead: leadScope },
      });
    case 'contacts':
      return prisma.leadEvent.count({
        where: { type: 'lead.disposition', toStatus: 'CONTACTED', createdAt: { gte: periodStart, lte: periodEnd }, lead: leadScope },
      });
    case 'calls':
      return prisma.call.count({
        where: { agencyId, ...(userId ? { uploadedById: userId } : {}), createdAt: { gte: periodStart, lte: periodEnd } },
      });
    case 'premium_cents': {
      const soldEvents = await prisma.leadEvent.findMany({
        where: { type: 'lead.disposition', toStatus: 'SOLD', createdAt: { gte: periodStart, lte: periodEnd }, lead: leadScope },
        select: { leadId: true },
      });
      const leads = soldEvents.length
        ? await prisma.lead.findMany({ where: { id: { in: soldEvents.map((e) => e.leadId) } }, select: { salePremiumCents: true } })
        : [];
      const livePremium = leads.reduce((sum, l) => sum + (l.salePremiumCents || 0), 0);
      const historicalPremium = await sumHistoricalPremium({ agencyId, from: periodStart, to: periodEnd, assignedToId: userId || undefined });
      const manualPremium = await sumSalePremium({ agencyId, from: periodStart, to: periodEnd, assignedToId: userId || undefined });
      return livePremium + historicalPremium + manualPremium;
    }
    case 'cross_sells':
    case 'winbacks':
      return prisma.opportunityEvent.count({
        where: {
          toStatus: 'WON',
          createdAt: { gte: periodStart, lte: periodEnd },
          opportunity: { agencyId, type: metric === 'cross_sells' ? 'CROSS_SELL' : 'WINBACK', ...(userId ? { assignedToId: userId } : {}) },
        },
      });
    case 'transfers':
      return prisma.transfer.count({
        where: {
          agencyId,
          status: { not: 'REJECTED' },
          respondedAt: { gte: periodStart, lte: periodEnd },
          ...(userId ? { acceptedById: userId } : {}),
        },
      });
    default:
      return null;
  }
}

// userId omitted (null) = agency-level goals only; passed = that user's own goals.
async function goalsWithProgress({ agencyId, userId = null }) {
  const now = new Date();
  const goals = await prisma.goal.findMany({
    where: { agencyId, userId, periodStart: { lte: now }, periodEnd: { gte: now } },
    orderBy: { periodStart: 'desc' },
  });

  return Promise.all(
    goals.map(async (g) => {
      const actual = await computeGoalActual(g);
      return {
        id: g.id,
        metric: g.metric,
        targetValue: g.targetValue,
        periodType: g.periodType,
        periodStart: g.periodStart,
        periodEnd: g.periodEnd,
        actual,
        progressPercent: actual !== null && g.targetValue > 0 ? Math.round((actual / g.targetValue) * 1000) / 10 : null,
      };
    })
  );
}

// range: optional {from, to} Date pair overriding the default "this month
// to now" window — only the funnel block honors it (recent calls stay
// "most recent 5 regardless of period," goals stay scoped to whichever
// goal is currently active, neither of which is "a report for a range").
async function assembleProducerReport(userId, range) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  const now = new Date();
  const from = range?.from || startOfMonth(now);
  const to = range?.to || now;
  const [flowScore, funnel, calls, goals] = await Promise.all([
    flowScoreBlock('USER', userId),
    computeFunnel({ agencyId: user.agencyId, userId, from, to }),
    prisma.call.findMany({
      where: { uploadedById: userId },
      include: { analysis: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    goalsWithProgress({ agencyId: user.agencyId, userId }),
  ]);

  return {
    user: { id: user.id, firstName: user.firstName, lastName: user.lastName, role: user.role },
    period: { from: from.toISOString(), to: to.toISOString() },
    flowScore,
    funnel,
    recentCalls: calls
      .filter((c) => c.analysis)
      .map((c) => ({
        id: c.id,
        createdAt: c.createdAt,
        overallScore: c.analysis.overallScore,
        strengths: c.analysis.strengths,
        coachingOpportunities: c.analysis.coachingOpportunities,
      })),
    goals,
  };
}

async function assembleAgencyReport(agencyId, range) {
  const now = new Date();
  const from = range?.from || startOfMonth(now);
  const to = range?.to || now;
  const [flowScore, funnel, goals, producers] = await Promise.all([
    flowScoreBlock('AGENCY', agencyId),
    computeFunnel({ agencyId, from, to }),
    goalsWithProgress({ agencyId }),
    prisma.user.findMany({
      where: { agencyId, role: 'PRODUCER', status: 'ACTIVE' },
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);

  // The real, non-toxic version of "who's crushing it / who needs
  // attention": sorted by current score, no editorializing language.
  const roster = await Promise.all(
    producers.map(async (p) => {
      const [snapshot, history] = await Promise.all([
        latestSnapshot('USER', p.id),
        snapshotHistory('USER', p.id, 5),
      ]);
      return {
        id: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        score: snapshot ? snapshot.score : null,
        trend: trendDirection(history),
      };
    })
  );
  roster.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  return { agencyId, period: { from: from.toISOString(), to: to.toISOString() }, flowScore, funnel, goals, roster };
}

module.exports = { assembleProducerReport, assembleAgencyReport, computeGoalActual, goalsWithProgress };
