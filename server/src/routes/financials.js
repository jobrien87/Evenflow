const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { computeProfitability, computeROI } = require('../lib/financialCalc');
const { computeBillboard, computeBillboardPeriod, GRANULARITIES } = require('../lib/billboard');
const { PERIODS: BILLBOARD_PERIODS } = require('../lib/billboardPeriods');
const { sumHistoricalPremium, countHistoricalSold, historicalByVendor, historicalByAgent } = require('../lib/historicalAggregates');
const { countSales, salesByAgent } = require('../lib/manualSaleAggregates');
const { eligibleProducersWhere } = require('../lib/eligibleProducersQuery');

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

    // Lead reaching SOLD (whole-lead or per-product) is a queue/pipeline
    // disposition only and is never counted here — the real production
    // entry is Add Closed Sale (Sale), same production-counting rule as
    // Billboard.
    const [revenueAgg, costAgg, historicalPremiumCents, historicalSoldCount, manualSalesCount] = await Promise.all([
      prisma.revenueEvent.aggregate({ where: whereBase, _sum: { amountCents: true } }),
      prisma.costEvent.aggregate({ where: whereBase, _sum: { amountCents: true } }),
      // Historical Data (Back Catalog) rows aren't Leads and have no
      // RevenueEvent of their own — this is the actual integration point
      // that makes their premium count toward the SAME revenue total
      // shown here, per the agency owner's own requirement.
      sumHistoricalPremium({ agencyId, from, to }),
      countHistoricalSold({ agencyId, from, to }),
      // Add Closed Sale (standalone) rows DO post a real RevenueEvent on
      // creation (see financialEvents.js's recordManualSaleRevenue), so
      // their premium is already inside revenueAgg above — only the COUNT
      // needs adding here, not the premium a second time.
      countSales({ agencyId, from, to }),
    ]);

    const revenueCents = (revenueAgg._sum.amountCents || 0) + historicalPremiumCents;
    const costCents = costAgg._sum.amountCents || 0;
    const totalSalesCount = historicalSoldCount + manualSalesCount;

    const profitability = computeProfitability({
      revenueCents, costCents, denominatorCount: totalSalesCount, denominatorLabel: 'sale',
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
      salesRecorded: totalSalesCount,
      historicalRecordsIncluded: historicalSoldCount,
      revenueByCategory: revenueByCategory.map((r) => ({ category: r.category, amount: (r._sum.amountCents || 0) / 100 })),
      costByCategory: costByCategory.map((c) => ({ category: c.category, amount: (c._sum.amountCents || 0) / 100 })),
    });
  } catch (err) {
    next(err);
  }
});

// Same "quoted or beyond" definition funnelMetrics.js's computeFunnel()
// uses for quoteRate — one canonical definition of what counts as a
// quote, not a second one invented here.
const QUOTED_OR_BEYOND_STATUSES = ['QUOTED', 'APPOINTMENT', 'FOLLOW_UP', 'SOLD'];

function costPer(costCents, count) {
  return count > 0 ? Math.round(costCents / count) / 100 : null;
}

router.get('/by-vendor', requireRole('AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencyId = scopedAgencyId(req);
    // Always required, even for PLATFORM_OWNER — an unscoped call here
    // would fan out a query pair per vendor across every agency on the
    // platform (no groupBy/batching), which isn't a real product surface
    // anyway. Scoping to one agency removes the unbounded-N risk outright.
    if (!agencyId) {
      return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    }
    const { from, to } = parseDateRange(req);
    const [vendors, historicalRows] = await Promise.all([
      prisma.vendor.findMany({ where: { agencyId } }),
      historicalByVendor({ agencyId, from, to }),
    ]);
    const historicalById = new Map(historicalRows.filter((h) => h.vendorId).map((h) => [h.vendorId, h]));

    const rows = await Promise.all(
      vendors.map(async (v) => {
        const [costAgg, leads] = await Promise.all([
          prisma.costEvent.aggregate({ where: { vendorId: v.id, occurredAt: { gte: from, lte: to } }, _sum: { amountCents: true } }),
          prisma.lead.findMany({ where: { vendorId: v.id, createdAt: { gte: from, lte: to } }, select: { status: true } }),
        ]);
        const costCents = costAgg._sum.amountCents || 0;
        const leadCount = leads.length;
        const quotedCount = leads.filter((l) => QUOTED_OR_BEYOND_STATUSES.includes(l.status)).length;
        // A Lead reaching SOLD is a pipeline disposition only, never a
        // production/revenue count here — the real sale unit is a Sale row
        // (Add Closed Sale), same as Billboard. Historical Data rows for
        // this vendor count toward sold/revenue — never toward
        // leadsReceived/quotesReceived, since historical backfill never had
        // a real intake/quote pipeline to measure rates against (that would
        // artificially distort cost-per-lead/-quote).
        const historical = historicalById.get(v.id);
        const soldCount = historical?.count || 0;
        const revenueCents = historical?.premiumCents || 0;

        return {
          vendorId: v.id,
          vendorName: v.name,
          product: v.product,
          status: v.status,
          leadsReceived: leadCount,
          totalCost: costCents / 100,
          costPerLead: costPer(costCents, leadCount),
          quotesReceived: quotedCount,
          costPerQuote: costPer(costCents, quotedCount),
          salesCount: soldCount,
          costPerSale: costPer(costCents, soldCount),
          conversionRate: leadCount > 0 ? Math.round((soldCount / leadCount) * 1000) / 10 : null,
          revenue: revenueCents / 100,
        };
      })
    );

    // Historical rows whose vendor name never matched a real Vendor — kept
    // visible rather than silently dropped, so the agency-wide total still
    // reconciles even when old data can't be attributed to a specific vendor.
    const unmatched = historicalRows.find((h) => !h.vendorId);
    if (unmatched && unmatched.count > 0) {
      rows.push({
        vendorId: null, vendorName: 'Historical (unmatched vendor)', product: null, status: null,
        leadsReceived: null, totalCost: 0, costPerLead: null, quotesReceived: null, costPerQuote: null,
        salesCount: unmatched.count, costPerSale: null, conversionRate: null, revenue: unmatched.premiumCents / 100,
      });
    }

    return res.json({ success: true, period: { from: from.toISOString(), to: to.toISOString() }, vendors: rows });
  } catch (err) {
    next(err);
  }
});

// Agent (Producer) leaderboard — same real Lead/Flow-Score data the rest
// of the app already computes from, just grouped per producer instead of
// per vendor. revenue is the sum of real, entered salePremiumCents on
// their SOLD leads (never a fabricated commission calculation).
router.get('/by-agent', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PRODUCER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencyId = scopedAgencyId(req);
    // Always required, even for PLATFORM_OWNER — see /by-vendor above for
    // why an unscoped platform-wide fan-out here isn't a real report.
    if (!agencyId) {
      return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    }
    const { from, to } = parseDateRange(req);
    const [producers, historicalRows, manualSaleRows] = await Promise.all([
      // Active PRODUCER or selling AGENCY_MANAGER — an eligible manager
      // (e.g. one who carries her own book of business) must retain her
      // own production credit, not fall into the unattributed bucket.
      prisma.user.findMany({
        where: eligibleProducersWhere(agencyId),
        select: { id: true, firstName: true, lastName: true },
      }),
      historicalByAgent({ agencyId, from, to }),
      salesByAgent({ agencyId, from, to }),
    ]);
    const historicalById = new Map(historicalRows.filter((h) => h.userId).map((h) => [h.userId, h]));
    const salesById = new Map(manualSaleRows.map((s) => [s.userId, s]));
    const matchedIds = new Set(producers.map((p) => p.id));

    const rows = await Promise.all(
      producers.map(async (p) => {
        const [leads, scoreSnapshot] = await Promise.all([
          prisma.lead.findMany({ where: { assignedToId: p.id, receivedAt: { gte: from, lte: to } }, select: { status: true } }),
          prisma.flowScoreSnapshot.findFirst({ where: { subjectType: 'USER', subjectId: p.id }, orderBy: { computedAt: 'desc' }, select: { score: true } }),
        ]);
        const leadCount = leads.length;
        // A Lead reaching SOLD is a pipeline disposition only, never a
        // production/revenue count here — the real sale unit is a Sale row
        // (Add Closed Sale). Historical Data and Add Closed Sale rows
        // attributed to this producer count toward their sold/revenue
        // totals — never leadsAssigned, for the same reason /by-vendor
        // excludes it from leadsReceived (no real intake rate to measure
        // for a bulk-imported or standalone-sale row).
        const historical = historicalById.get(p.id);
        const manual = salesById.get(p.id);
        const soldCount = (historical?.count || 0) + (manual?.count || 0);
        const revenueCents = (historical?.premiumCents || 0) + (manual?.premiumCents || 0);

        return {
          userId: p.id,
          firstName: p.firstName,
          lastName: p.lastName,
          leadsAssigned: leadCount,
          salesCount: soldCount,
          revenue: revenueCents / 100,
          conversionRate: leadCount > 0 ? Math.round((soldCount / leadCount) * 1000) / 10 : null,
          flowScore: scoreSnapshot ? scoreSnapshot.score : null,
        };
      })
    );

    // Historical rows attributed to no one currently ACTIVE (unmatched name,
    // or matched to a producer who's since left) — kept visible so the
    // agency-wide total still reconciles, same treatment as /by-vendor.
    const unattributedPremium = historicalRows
      .filter((h) => !h.userId || !matchedIds.has(h.userId))
      .reduce((sum, h) => sum + h.premiumCents, 0);
    const unattributedCount = historicalRows
      .filter((h) => !h.userId || !matchedIds.has(h.userId))
      .reduce((sum, h) => sum + h.count, 0);
    if (unattributedCount > 0) {
      rows.push({
        userId: null, firstName: 'Historical', lastName: '(unattributed)',
        leadsAssigned: null, salesCount: unattributedCount, revenue: unattributedPremium / 100,
        conversionRate: null, flowScore: null,
      });
    }

    // A Sale assigned to a producer who's since left/been deactivated —
    // kept visible so the agency-wide total still reconciles, same
    // treatment as the historical-unattributed bucket above.
    const unmatchedSales = manualSaleRows.filter((s) => !matchedIds.has(s.userId));
    const unattributedSalesCount = unmatchedSales.reduce((sum, s) => sum + s.count, 0);
    const unattributedSalesPremium = unmatchedSales.reduce((sum, s) => sum + s.premiumCents, 0);
    if (unattributedSalesCount > 0) {
      rows.push({
        userId: null, firstName: 'Manual Sales', lastName: '(unattributed)',
        leadsAssigned: null, salesCount: unattributedSalesCount, revenue: unattributedSalesPremium / 100,
        conversionRate: null, flowScore: null,
      });
    }

    return res.json({ success: true, period: { from: from.toISOString(), to: to.toISOString() }, agents: rows });
  } catch (err) {
    next(err);
  }
});

// The Billboard — real sold-item count + premium total, broken down by
// producer and by product line, plus a real time-series trend line. Same
// visibility as /by-agent (the whole team, not just Owner/Manager).
//
// `?period=week|month|year|all_years` selects the new Eastern-time
// fixed-calendar period system (mostRecentCompletedWorkWeek/monthBounds/
// yearBounds/all years present in the data — see lib/billboardPeriods.js)
// and takes precedence when present. `?month=YYYY-MM`/`?year=YYYY` pick a
// specific Month/Year-view selection; both default to the agency's
// current Eastern calendar month/year when omitted.
//
// Without `?period=`, the route falls back to the original rolling
// `?granularity=`/`?from=`/`?to=` contract (computeBillboard) unchanged —
// defensive backward compatibility for any caller beyond BillboardPanel.jsx.
router.get('/billboard', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PRODUCER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencyId = scopedAgencyId(req);
    // Always required, even for PLATFORM_OWNER — same unbounded-scan
    // reasoning as /by-vendor and /by-agent above.
    if (!agencyId) {
      return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    }

    if (BILLBOARD_PERIODS.includes(req.query.period)) {
      const result = await computeBillboardPeriod({
        agencyId,
        period: req.query.period,
        month: req.query.month || undefined,
        year: req.query.year || undefined,
      });
      return res.json({ success: true, ...result });
    }

    const granularity = GRANULARITIES.includes(req.query.granularity) ? req.query.granularity : 'month';
    const result = await computeBillboard({
      agencyId,
      granularity,
      from: req.query.from || undefined,
      to: req.query.to || undefined,
    });
    return res.json({ success: true, ...result });
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
