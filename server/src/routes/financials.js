const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { computeProfitability, computeROI } = require('../lib/financialCalc');

const router = express.Router();
router.use(requireAuth);

function parseDateRange(req) {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(to.getFullYear(), to.getMonth(), 1);
  return { from, to };
}

function scopedAgencyId(req) {
  if (req.user.role === 'PLATFORM_OWNER') return req.query.agencyId || undefined;
  return req.user.agencyId;
}

router.get('/summary', requireRole('AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencyId = scopedAgencyId(req);
    const { from, to } = parseDateRange(req);
    if (req.user.role !== 'PLATFORM_OWNER' && !agencyId) {
      return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    }

    const whereBase = { occurredAt: { gte: from, lte: to }, ...(agencyId ? { agencyId } : {}) };

    // Sales are now recorded via Lead disposition (Yield Transfers rebuild
    // retired the Transfer pipeline) — updatedAt is the real timestamp of
    // that disposition, since a Lead has no separate "soldAt" field and a
    // SOLD lead is not normally touched again afterward.
    const [revenueAgg, costAgg, salesCount] = await Promise.all([
      prisma.revenueEvent.aggregate({ where: whereBase, _sum: { amountCents: true } }),
      prisma.costEvent.aggregate({ where: whereBase, _sum: { amountCents: true } }),
      prisma.lead.count({ where: { status: 'SOLD', updatedAt: { gte: from, lte: to }, ...(agencyId ? { agencyId } : {}) } }),
    ]);

    const revenueCents = revenueAgg._sum.amountCents || 0;
    const costCents = costAgg._sum.amountCents || 0;

    const profitability = computeProfitability({
      revenueCents, costCents, denominatorCount: salesCount, denominatorLabel: 'sale',
    });
    const roi = computeROI({ revenueCents, costCents });

    const [revenueByCategory, costByCategory] = await Promise.all([
      prisma.revenueEvent.groupBy({ by: ['category'], where: whereBase, _sum: { amountCents: true } }),
      prisma.costEvent.groupBy({ by: ['category'], where: whereBase, _sum: { amountCents: true } }),
    ]);

    return res.json({
      success: true,
      period: { from: from.toISOString(), to: to.toISOString() },
      ...profitability,
      roiPercent: roi.roiPercent,
      roiReason: roi.reason,
      salesRecorded: salesCount,
      revenueByCategory: revenueByCategory.map((r) => ({ category: r.category, amount: (r._sum.amountCents || 0) / 100 })),
      costByCategory: costByCategory.map((c) => ({ category: c.category, amount: (c._sum.amountCents || 0) / 100 })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/by-vendor', requireRole('AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencyId = scopedAgencyId(req);
    const { from, to } = parseDateRange(req);
    const vendors = await prisma.vendor.findMany({ where: agencyId ? { agencyId } : {} });

    const rows = await Promise.all(
      vendors.map(async (v) => {
        const [costAgg, leadCount] = await Promise.all([
          prisma.costEvent.aggregate({ where: { vendorId: v.id, occurredAt: { gte: from, lte: to } }, _sum: { amountCents: true } }),
          prisma.lead.count({ where: { vendorId: v.id, createdAt: { gte: from, lte: to } } }),
        ]);
        const costCents = costAgg._sum.amountCents || 0;
        return {
          vendorId: v.id,
          vendorName: v.name,
          product: v.product,
          status: v.status,
          leadsReceived: leadCount,
          totalCost: costCents / 100,
          costPerLead: leadCount > 0 ? Math.round(costCents / leadCount) / 100 : null,
        };
      })
    );

    return res.json({ success: true, period: { from: from.toISOString(), to: to.toISOString() }, vendors: rows });
  } catch (err) {
    next(err);
  }
});

// The raw ledger — every RevenueEvent/CostEvent row individually, merged
// and paginated. Until now these were create-only (POST below); this is
// the one export case that can't just reuse already-loaded client state,
// since there was no list endpoint at all.
router.get('/events', requireRole('AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencyId = scopedAgencyId(req);
    if (req.user.role !== 'PLATFORM_OWNER' && !agencyId) {
      return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    }
    const { from, to } = parseDateRange(req);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 50, 1), 200);

    const whereBase = { occurredAt: { gte: from, lte: to }, ...(agencyId ? { agencyId } : {}) };

    const [revenueEvents, costEvents] = await Promise.all([
      prisma.revenueEvent.findMany({ where: whereBase, orderBy: { occurredAt: 'desc' } }),
      prisma.costEvent.findMany({ where: whereBase, orderBy: { occurredAt: 'desc' } }),
    ]);

    const merged = [
      ...revenueEvents.map((e) => ({ ...e, type: 'REVENUE' })),
      ...costEvents.map((e) => ({ ...e, type: 'COST' })),
    ].sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));

    const total = merged.length;
    const events = merged.slice((page - 1) * pageSize, page * pageSize);

    return res.json({ success: true, period: { from: from.toISOString(), to: to.toISOString() }, page, pageSize, total, events });
  } catch (err) {
    next(err);
  }
});

const revenueEventSchema = z.object({
  agencyId: z.string().uuid().optional(),
  category: z.enum(['SUBSCRIPTION', 'TRANSFER_REVENUE', 'LEAD_REVENUE', 'OTHER']),
  amountCents: z.number().int(),
  occurredAt: z.string().datetime().optional(),
  notes: z.string().optional(),
});

router.post('/revenue-events', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = revenueEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const event = await prisma.revenueEvent.create({
      data: { ...parsed.data, occurredAt: parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : new Date(), createdById: req.user.id },
    });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: parsed.data.agencyId,
      action: 'financial.revenue_recorded', entityType: 'RevenueEvent', entityId: event.id,
      after: { category: parsed.data.category, amountCents: parsed.data.amountCents }, correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, event });
  } catch (err) {
    next(err);
  }
});

const costEventSchema = z.object({
  agencyId: z.string().uuid().optional(),
  vendorId: z.string().uuid().optional(),
  category: z.enum(['VENDOR_LEAD_COST', 'TELEMARKETER_COST', 'TRANSFER_COST', 'API_COST', 'CREDIT', 'REFUND', 'OTHER']),
  amountCents: z.number().int(),
  occurredAt: z.string().datetime().optional(),
  notes: z.string().optional(),
});

router.post('/cost-events', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = costEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const event = await prisma.costEvent.create({
      data: { ...parsed.data, occurredAt: parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : new Date(), createdById: req.user.id },
    });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: parsed.data.agencyId,
      action: 'financial.cost_recorded', entityType: 'CostEvent', entityId: event.id,
      after: { category: parsed.data.category, amountCents: parsed.data.amountCents }, correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, event });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
