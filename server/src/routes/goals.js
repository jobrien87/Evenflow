const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { computeGoalActual } = require('../lib/runningReport');
const { parseGoalText } = require('../lib/goalParser');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const where = {};
    if (req.user.role === 'PLATFORM_OWNER') {
      if (req.query.agencyId) where.agencyId = req.query.agencyId;
    } else {
      where.agencyId = req.user.agencyId;
    }
    if (req.query.userId) where.userId = req.query.userId;
    if (req.user.role === 'PRODUCER') where.userId = req.user.id;

    const goals = await prisma.goal.findMany({
      where,
      orderBy: { periodStart: 'desc' },
      take: 100,
    });

    // Real live progress for every goal returned (not just currently-active
    // ones) — same computeGoalActual runningReport.js's own report uses, so
    // this is never a second, divergent calculation. A goal that just
    // crossed 100% for the first time gets completedAt set here, once.
    const withProgress = await Promise.all(
      goals.map(async (g) => {
        const actual = await computeGoalActual(g);
        const progressPercent = actual !== null && g.targetValue > 0 ? Math.round((actual / g.targetValue) * 1000) / 10 : null;

        let completedAt = g.completedAt;
        let justCompleted = false;
        if (progressPercent !== null && progressPercent >= 100 && !completedAt) {
          const updated = await prisma.goal.update({ where: { id: g.id }, data: { completedAt: new Date() } });
          completedAt = updated.completedAt;
          justCompleted = true;
        }

        return { ...g, actual, progressPercent, completedAt, justCompleted };
      })
    );

    return res.json({ success: true, goals: withProgress });
  } catch (err) {
    next(err);
  }
});

router.post('/parse', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = z.object({ text: z.string().min(1).max(500) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION' });

    const agencyId = req.user.role === 'PLATFORM_OWNER' ? req.body.agencyId || null : req.user.agencyId;
    const roster = agencyId
      ? await prisma.user.findMany({ where: { agencyId, role: 'PRODUCER', status: 'ACTIVE' }, select: { id: true, firstName: true, lastName: true } })
      : [];

    let result;
    try {
      result = await parseGoalText(parsed.data.text, { roster, now: new Date() });
    } catch (err) {
      return res.status(502).json({ success: false, error: 'PARSE_FAILED', message: 'Could not understand that goal — try rephrasing, or use the manual form below.' });
    }

    if (!result.available) {
      return res.json({ success: true, available: false, message: 'AI parsing is not configured right now. Use the manual form below.' });
    }

    return res.json({ success: true, available: true, draft: result.draft });
  } catch (err) {
    next(err);
  }
});

const createGoalSchema = z.object({
  userId: z.string().uuid().optional(),
  metric: z.enum(['sales', 'quotes', 'calls', 'contacts', 'premium_cents', 'cross_sells', 'winbacks', 'transfers']),
  targetValue: z.number().int().positive(),
  periodType: z.enum(['daily', 'weekly', 'monthly', 'quarterly', 'custom']),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
});

router.post('/', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = createGoalSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const agencyId = req.user.role === 'PLATFORM_OWNER' ? req.body.agencyId : req.user.agencyId;
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    if (parsed.data.userId) {
      const targetUser = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
      if (!targetUser) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
      if (req.user.role !== 'PLATFORM_OWNER' && targetUser.agencyId !== req.user.agencyId) {
        return res.status(403).json({ success: false, error: 'FORBIDDEN' });
      }
    }

    if (new Date(parsed.data.periodEnd) <= new Date(parsed.data.periodStart)) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'periodEnd must be after periodStart.' });
    }

    const goal = await prisma.goal.create({
      data: {
        agencyId,
        userId: parsed.data.userId || null,
        metric: parsed.data.metric,
        targetValue: parsed.data.targetValue,
        periodType: parsed.data.periodType,
        periodStart: new Date(parsed.data.periodStart),
        periodEnd: new Date(parsed.data.periodEnd),
      },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId,
      action: 'goal.created', entityType: 'Goal', entityId: goal.id,
      after: { userId: parsed.data.userId, metric: parsed.data.metric, targetValue: parsed.data.targetValue },
      correlationId: req.correlationId,
    });

    return res.status(201).json({ success: true, goal });
  } catch (err) {
    next(err);
  }
});

const updateGoalSchema = z.object({
  targetValue: z.number().int().positive().optional(),
  periodStart: z.string().datetime().optional(),
  periodEnd: z.string().datetime().optional(),
});

router.patch('/:id', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = updateGoalSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const goal = await prisma.goal.findUnique({ where: { id: req.params.id } });
    if (!goal) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && goal.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    const data = {};
    if (parsed.data.targetValue !== undefined) data.targetValue = parsed.data.targetValue;
    if (parsed.data.periodStart !== undefined) data.periodStart = new Date(parsed.data.periodStart);
    if (parsed.data.periodEnd !== undefined) data.periodEnd = new Date(parsed.data.periodEnd);

    const newStart = data.periodStart || goal.periodStart;
    const newEnd = data.periodEnd || goal.periodEnd;
    if (newEnd <= newStart) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'periodEnd must be after periodStart.' });
    }

    // Changing the target/period re-opens the goal for a fresh completion
    // check rather than leaving a stale celebration state around.
    data.completedAt = null;

    const updated = await prisma.goal.update({ where: { id: goal.id }, data });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: goal.agencyId,
      action: 'goal.updated', entityType: 'Goal', entityId: goal.id,
      before: { targetValue: goal.targetValue, periodStart: goal.periodStart, periodEnd: goal.periodEnd },
      after: data, correlationId: req.correlationId,
    });

    return res.json({ success: true, goal: updated });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const goal = await prisma.goal.findUnique({ where: { id: req.params.id } });
    if (!goal) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && goal.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    await prisma.goal.delete({ where: { id: goal.id } });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: goal.agencyId,
      action: 'goal.deleted', entityType: 'Goal', entityId: goal.id, correlationId: req.correlationId,
    });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
