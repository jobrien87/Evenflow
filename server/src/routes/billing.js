const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');

const router = express.Router();
router.use(requireAuth);

function isPaymentProcessorConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

router.get('/status', (req, res) => {
  res.json({
    success: true,
    paymentProcessorConfigured: isPaymentProcessorConfigured(),
    mode: isPaymentProcessorConfigured() ? 'AUTOMATED' : 'MANUAL',
    note: isPaymentProcessorConfigured()
      ? undefined
      : 'No payment processor is configured. Billing operates in manual/admin mode, Platform Owner assigns plans directly; no payment is ever actually charged or simulated.',
  });
});

router.get('/plans', async (req, res, next) => {
  try {
    const plans = await prisma.plan.findMany({ where: { isActive: true }, orderBy: { priceCents: 'asc' } });
    return res.json({ success: true, plans });
  } catch (err) {
    next(err);
  }
});

const createPlanSchema = z.object({
  name: z.string().min(1),
  priceCents: z.number().int().min(0),
  interval: z.enum(['MONTHLY', 'ANNUAL']).default('MONTHLY'),
  crmEnabled: z.boolean().default(true),
  transfersEnabled: z.boolean().default(false),
  coachingEnabled: z.boolean().default(false),
});

router.post('/plans', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = createPlanSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const plan = await prisma.plan.create({ data: parsed.data });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role,
      action: 'plan.created', entityType: 'Plan', entityId: plan.id,
      after: parsed.data, correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, plan });
  } catch (err) {
    next(err);
  }
});

const updatePlanSchema = createPlanSchema.partial().extend({ isActive: z.boolean().optional() });

router.patch('/plans/:id', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = updatePlanSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    const before = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const plan = await prisma.plan.update({ where: { id: req.params.id }, data: parsed.data });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role,
      action: 'plan.updated', entityType: 'Plan', entityId: plan.id,
      before, after: parsed.data, correlationId: req.correlationId,
    });
    return res.json({ success: true, plan });
  } catch (err) {
    next(err);
  }
});

router.get('/agencies/:agencyId/subscription', async (req, res, next) => {
  try {
    if (req.user.role !== 'PLATFORM_OWNER' && req.user.agencyId !== req.params.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const subscription = await prisma.agencySubscription.findFirst({
      where: { agencyId: req.params.agencyId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, subscription: subscription || null });
  } catch (err) {
    next(err);
  }
});

const assignSchema = z.object({
  planId: z.string().uuid(),
  status: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE']).default('ACTIVE'),
  trialEndsAt: z.string().datetime().optional(),
});

router.post('/agencies/:agencyId/subscription', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const [agency, plan] = await Promise.all([
      prisma.agency.findUnique({ where: { id: req.params.agencyId } }),
      prisma.plan.findUnique({ where: { id: parsed.data.planId } }),
    ]);
    if (!agency) return res.status(404).json({ success: false, error: 'AGENCY_NOT_FOUND' });
    if (!plan) return res.status(404).json({ success: false, error: 'PLAN_NOT_FOUND' });

    const result = await prisma.$transaction(async (tx) => {
      await tx.agencySubscription.updateMany({
        where: { agencyId: agency.id, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
        data: { status: 'CANCELED', canceledAt: new Date() },
      });

      const subscription = await tx.agencySubscription.create({
        data: {
          agencyId: agency.id,
          planId: plan.id,
          status: parsed.data.status,
          trialEndsAt: parsed.data.trialEndsAt ? new Date(parsed.data.trialEndsAt) : null,
          assignedById: req.user.id,
        },
      });

      const updatedAgency = await tx.agency.update({
        where: { id: agency.id },
        data: {
          crmEnabled: plan.crmEnabled,
          transfersEnabled: plan.transfersEnabled,
          coachingEnabled: plan.coachingEnabled,
        },
      });

      return { subscription, updatedAgency };
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: agency.id,
      action: 'subscription.assigned', entityType: 'AgencySubscription', entityId: result.subscription.id,
      after: { planId: plan.id, planName: plan.name, status: parsed.data.status }, correlationId: req.correlationId,
    });

    return res.status(201).json({ success: true, subscription: result.subscription, agency: result.updatedAgency });
  } catch (err) {
    next(err);
  }
});

router.post('/agencies/:agencyId/subscription/cancel', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const active = await prisma.agencySubscription.findFirst({
      where: { agencyId: req.params.agencyId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
    });
    if (!active) return res.status(404).json({ success: false, error: 'NO_ACTIVE_SUBSCRIPTION' });

    await prisma.$transaction([
      prisma.agencySubscription.update({ where: { id: active.id }, data: { status: 'CANCELED', canceledAt: new Date() } }),
      prisma.agency.update({ where: { id: req.params.agencyId }, data: { transfersEnabled: false, coachingEnabled: false } }),
    ]);

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.params.agencyId,
      action: 'subscription.canceled', entityType: 'AgencySubscription', entityId: active.id, correlationId: req.correlationId,
    });

    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
