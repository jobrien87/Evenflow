const express = require('express');
const { prisma } = require('../lib/db');
const { requireAuth, scopeAgencyId } = require('../middleware/auth');
const { computeGoalActual } = require('../lib/runningReport');

const router = express.Router();
router.use(requireAuth);

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

router.get('/', async (req, res, next) => {
  try {
    const agencyId = scopeAgencyId(req);
    const userId = req.user.id;
    const now = new Date();
    const today = startOfDay(now);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const monthStart = startOfMonth(now);
    const monthEnd = endOfMonth(now);

    const [yesterdayDispositions, monthlySales, goal, todayLeads, todayTasks] = await Promise.all([
      prisma.leadEvent.findMany({
        where: {
          type: 'lead.disposition',
          createdAt: { gte: yesterday, lt: today },
          lead: { assignedToId: userId, agencyId },
        },
      }),
      // Same real "sales this month" math runningReport.js's goal-progress
      // computation uses — one source of truth, not a second reimplementation.
      computeGoalActual({ metric: 'sales', userId, agencyId, periodStart: monthStart, periodEnd: monthEnd }),
      prisma.goal.findFirst({
        where: {
          userId,
          metric: 'sales',
          periodStart: { lte: now },
          periodEnd: { gte: now },
        },
      }),
      prisma.lead.count({
        where: { assignedToId: userId, receivedAt: { gte: today }, agencyId },
      }),
      prisma.task.count({
        where: { assignedToId: userId, status: { in: ['OPEN', 'IN_PROGRESS'] }, agencyId },
      }),
    ]);

    const yesterdaySales = yesterdayDispositions.filter((e) => e.toStatus === 'SOLD').length;
    const yesterdayContacts = yesterdayDispositions.filter((e) => e.toStatus === 'CONTACTED').length;
    const yesterdayQuotes = yesterdayDispositions.filter((e) => e.toStatus === 'QUOTED' || e.toStatus === 'QUOTE_STARTED').length;

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
        pacePercent: expectedByNow > 0 ? Math.round((monthlySales / expectedByNow) * 100) : null,
      };
    }

    return res.json({
      success: true,
      yesterday: { sales: yesterdaySales, contacts: yesterdayContacts, quotes: yesterdayQuotes },
      month: pace,
      today: { newLeads: todayLeads, openTasks: todayTasks },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
