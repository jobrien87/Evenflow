// Vendor performance + disposition report — "all the stats for that
// vendor" plus a full per-lead disposition breakdown, in the same
// "group real Lead rows, compute real rates" style as zipBreakdown.js's
// computeZipBreakdown (reuses the identical cost/sale formulas so the
// numbers here are never a second, different model of the same thing).

const { prisma } = require('./db');
const { pct } = require('./funnelMetrics');
const { QUOTED_OR_BEYOND_STATUSES } = require('./leadStatusGroups');
const { saleLeadLikeRows } = require('./manualSaleAggregates');

function costPer(costCents, count) {
  return count > 0 ? Math.round(costCents / count) / 100 : null;
}

// { agencyId, vendorId, from, to } -> { vendor, stats, leads }
async function computeVendorReport({ agencyId, vendorId, from, to }) {
  const [vendor, leads, saleRows] = await Promise.all([
    prisma.vendor.findUnique({ where: { id: vendorId } }),
    prisma.lead.findMany({
      where: { agencyId, vendorId, receivedAt: { gte: from, lte: to }, archivedAt: null },
      select: {
        id: true, status: true, receivedAt: true, zip: true, state: true, product: true,
        customer: { select: { firstName: true, lastName: true } },
        assignedTo: { select: { firstName: true, lastName: true } },
      },
      orderBy: { receivedAt: 'desc' },
    }),
    // Real sold count/revenue comes from actual Add Closed Sale records —
    // never a live Lead's own salePremiumCents snapshot (same reasoning
    // as zipBreakdown.js's identical comment).
    saleLeadLikeRows({ agencyId, from, to }),
  ]);
  if (!vendor || vendor.agencyId !== agencyId) return null;

  const vendorSales = saleRows.filter((r) => r.vendorId === vendorId);
  const revenueCents = vendorSales.reduce((sum, r) => sum + (r.salePremiumCents || 0), 0);
  const soldCount = vendorSales.length;

  const totalLeads = leads.length;
  const quotedCount = leads.filter((l) => QUOTED_OR_BEYOND_STATUSES.includes(l.status)).length;

  // Same cost formula financials.js's /by-vendor and zipBreakdown.js both
  // use: this vendor's real CostEvent total for the period, divided by
  // this vendor's real lead count for the period.
  const [costAgg] = await Promise.all([
    prisma.costEvent.aggregate({ where: { vendorId, occurredAt: { gte: from, lte: to } }, _sum: { amountCents: true } }),
  ]);
  const totalCostCents = costAgg._sum.amountCents || 0;
  const hasCostData = vendor.costPerLeadCents != null || totalCostCents > 0;

  const stats = {
    totalLeads,
    quotedCount,
    quoteRate: pct(quotedCount, totalLeads),
    soldCount,
    closeRate: pct(soldCount, totalLeads),
    revenue: revenueCents / 100,
    totalCost: hasCostData ? totalCostCents / 100 : null,
    costPerLead: hasCostData ? costPer(totalCostCents, totalLeads) : null,
    cpa: hasCostData ? costPer(totalCostCents, soldCount) : null,
  };

  const dispositions = leads.map((l) => ({
    leadId: l.id,
    customerName: l.customer ? `${l.customer.firstName} ${l.customer.lastName}`.trim() : '—',
    status: l.status,
    receivedAt: l.receivedAt,
    product: l.product || '—',
    zip: l.zip || '—',
    state: l.state || '—',
    assignedTo: l.assignedTo ? `${l.assignedTo.firstName} ${l.assignedTo.lastName}`.trim() : 'Unassigned',
  }));

  return {
    vendor: { id: vendor.id, name: vendor.name, vendorBrand: vendor.vendorBrand, email: vendor.email, product: vendor.product },
    stats,
    dispositions,
  };
}

module.exports = { computeVendorReport };
