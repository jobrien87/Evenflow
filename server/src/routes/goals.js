const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');

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
    return res.json({ success: true, goals });
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
