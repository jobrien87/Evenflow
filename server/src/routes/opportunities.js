const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole, scopeAgencyId } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { canTransition } = require('../lib/opportunityStateMachine');
const { recordLeadSaleRevenue } = require('../lib/financialEvents');

const router = express.Router();
router.use(requireAuth);

// Opportunities/winbacks are an agency- and producer-side concept — a
// Telemarketer has no legitimate reason to list them, and (since TMs have
// no agencyId of their own) scopeAgencyId(req) returns null for a TM,
// which would otherwise omit the agencyId filter entirely rather than
// scope it. Excluding TELEMARKETER here is the real fix, not new scoping
// logic.
router.get('/', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PRODUCER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencyId = scopeAgencyId(req);
    const where = {
      ...(agencyId ? { agencyId } : {}),
      ...(req.query.type ? { type: req.query.type } : {}),
      ...(req.user.role === 'PRODUCER' ? { assignedToId: req.user.id } : {}),
      status: { notIn: ['WON', 'DECLINED', 'INELIGIBLE'] },
    };
    const opportunities = await prisma.opportunity.findMany({
      where,
      include: { customer: true, events: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
    return res.json({ success: true, opportunities });
  } catch (err) {
    next(err);
  }
});

const createWinbackSchema = z.object({
  customerId: z.string().uuid(),
  product: z.string().min(1),
  previousProduct: z.string().optional(),
  previousPremiumCents: z.number().int().positive().optional(),
  lostAt: z.string().datetime().optional(),
  lostReason: z.string().optional(),
  assignedToId: z.string().uuid().optional(),
});

router.post('/winback', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = createWinbackSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const agencyId = req.user.role === 'PLATFORM_OWNER' ? req.body.agencyId : req.user.agencyId;
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const customer = await prisma.customer.findUnique({ where: { id: parsed.data.customerId } });
    if (!customer) return res.status(404).json({ success: false, error: 'CUSTOMER_NOT_FOUND' });

    const opportunity = await prisma.opportunity.create({
      data: {
        agencyId,
        customerId: parsed.data.customerId,
        type: 'WINBACK',
        product: parsed.data.product,
        previousProduct: parsed.data.previousProduct,
        previousPremiumCents: parsed.data.previousPremiumCents,
        lostAt: parsed.data.lostAt ? new Date(parsed.data.lostAt) : null,
        lostReason: parsed.data.lostReason,
        reason: parsed.data.lostReason || 'Manually recorded lapsed customer',
        assignedToId: parsed.data.assignedToId,
        status: parsed.data.assignedToId ? 'ASSIGNED' : 'OPEN',
        priorityScore: 50,
        createdById: req.user.id,
      },
    });

    await prisma.opportunityEvent.create({
      data: { opportunityId: opportunity.id, toStatus: opportunity.status, actorId: req.user.id, reason: 'Created' },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId,
      action: 'opportunity.winback_created', entityType: 'Opportunity', entityId: opportunity.id,
      after: { customerId: parsed.data.customerId, product: parsed.data.product }, correlationId: req.correlationId,
    });

    return res.status(201).json({ success: true, opportunity });
  } catch (err) {
    next(err);
  }
});

const dispositionSchema = z.object({
  status: z.enum(['ASSIGNED', 'ATTEMPTED', 'CONTACTED', 'QUOTED', 'WON', 'DECLINED', 'SNOOZED', 'INELIGIBLE']),
  reason: z.string().optional(),
  wonPremiumCents: z.number().int().positive().optional(),
  snoozeUntil: z.string().datetime().optional(),
  assignedToId: z.string().uuid().optional(),
});

router.post('/:id/disposition', async (req, res, next) => {
  try {
    const parsed = dispositionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const opportunity = await prisma.opportunity.findUnique({ where: { id: req.params.id }, include: { customer: true } });
    if (!opportunity) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && opportunity.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (!canTransition(opportunity.status, parsed.data.status)) {
      return res.status(409).json({ success: false, error: 'INVALID_TRANSITION', from: opportunity.status, to: parsed.data.status });
    }

    const patch = { status: parsed.data.status };
    if (parsed.data.assignedToId) patch.assignedToId = parsed.data.assignedToId;
    if (parsed.data.status === 'SNOOZED' && parsed.data.snoozeUntil) patch.snoozeUntil = new Date(parsed.data.snoozeUntil);
    if (parsed.data.status === 'WON') patch.wonPremiumCents = parsed.data.wonPremiumCents || null;

    const updated = await prisma.opportunity.update({ where: { id: opportunity.id }, data: patch });

    await prisma.opportunityEvent.create({
      data: {
        opportunityId: opportunity.id,
        fromStatus: opportunity.status,
        toStatus: parsed.data.status,
        actorId: req.user.id,
        reason: parsed.data.reason,
      },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: opportunity.agencyId,
      action: 'opportunity.dispositioned', entityType: 'Opportunity', entityId: opportunity.id,
      before: { status: opportunity.status }, after: { status: parsed.data.status }, correlationId: req.correlationId,
    });

    if (parsed.data.status === 'WON' && parsed.data.wonPremiumCents) {
      await recordLeadSaleRevenue({
        id: updated.id,
        agencyId: updated.agencyId,
        salePremiumCents: parsed.data.wonPremiumCents,
        saleProduct: updated.product,
      });
    }

    return res.json({ success: true, opportunity: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
