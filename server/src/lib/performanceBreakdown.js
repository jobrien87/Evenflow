// Per-vendor and per-product performance breakdowns — the cross-dimension
// views that don't exist in funnelMetrics.js (agency/user only) or
// financials.js's by-vendor/by-agent (vendor-only or agent-only, never
// both together). Shared by "My Leads" (userId = self), the Agency
// Owner's Producer Detail drill-down (userId = target producer), and Ed's
// context (userId omitted = agency-wide).

const { prisma } = require('./db');
const { computeFunnel, pct } = require('./funnelMetrics');
const { historicalByProduct } = require('./historicalAggregates');
const { salesByProduct } = require('./manualSaleAggregates');

const QUOTED_OR_BEYOND = ['QUOTED', 'APPOINTMENT', 'FOLLOW_UP', 'SOLD'];

// { agencyId, userId?, from, to } -> one row per vendor this scope actually
// received leads from in the period (vendors with zero leads in-period are
// omitted — a busy agency can have far more configured vendors than any
// one producer or period actually touched).
async function computeVendorBreakdown({ agencyId, userId, from, to }) {
  const vendors = await prisma.vendor.findMany({
    where: { agencyId },
    select: { id: true, name: true, product: true, status: true },
  });

  const rows = await Promise.all(
    vendors.map(async (vendor) => {
      const funnel = await computeFunnel({ agencyId, userId, vendorId: vendor.id, from, to });
      if (funnel.totalLeads === 0) return null;
      const untouched = await prisma.lead.count({
        where: {
          agencyId,
          vendorId: vendor.id,
          ...(userId ? { assignedToId: userId } : {}),
          receivedAt: { gte: from, lte: to },
          firstAttemptAt: null,
          archivedAt: null,
        },
      });
      return {
        vendorId: vendor.id,
        vendorName: vendor.name,
        product: vendor.product,
        vendorStatus: vendor.status,
        totalLeads: funnel.totalLeads,
        untouched,
        contactRate: funnel.contactRate,
        quoteRate: funnel.quoteRate,
        closeRate: funnel.closeRate,
      };
    })
  );

  return rows.filter(Boolean).sort((a, b) => b.totalLeads - a.totalLeads);
}

// { agencyId, userId?, from, to } -> one row per distinct Lead.product
// this scope received in the period.
async function computeProductBreakdown({ agencyId, userId, from, to }) {
  const [leads, historicalProducts, manualProducts] = await Promise.all([
    prisma.lead.findMany({
      where: {
        agencyId,
        ...(userId ? { assignedToId: userId } : {}),
        receivedAt: { gte: from, lte: to },
        archivedAt: null,
      },
      select: { product: true, status: true, firstContactAt: true },
    }),
    historicalByProduct({ agencyId, from, to, assignedToId: userId || undefined }),
    salesByProduct({ agencyId, from, to, assignedToId: userId || undefined }),
  ]);

  const byProduct = new Map();
  for (const lead of leads) {
    const key = lead.product || 'Unspecified';
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(lead);
  }

  // Historical Data and Add Closed Sale rows add to salesCount only — never
  // totalLeads/contactRate/quoteRate/closeRate, since those are pipeline-
  // speed rate metrics that old bulk-imported/standalone-entered rows
  // never had real touchpoints to measure against.
  const rows = [...byProduct.entries()].map(([product, productLeads]) => {
    const total = productLeads.length;
    const contacted = productLeads.filter((l) => l.firstContactAt).length;
    const quotedOrBeyond = productLeads.filter((l) => QUOTED_OR_BEYOND.includes(l.status)).length;
    const sold = productLeads.filter((l) => l.status === 'SOLD').length;
    const historicalSold = historicalProducts[product]?.count || 0;
    const manualSold = manualProducts[product]?.count || 0;
    return {
      product,
      totalLeads: total,
      contactRate: pct(contacted, total),
      quoteRate: pct(quotedOrBeyond, total),
      closeRate: pct(sold, total),
      salesCount: sold + historicalSold + manualSold,
    };
  });

  // A product with historical or manual sales but zero live leads in this
  // period still needs a row, so its contribution isn't silently lost.
  const extraProducts = new Set([...Object.keys(historicalProducts), ...Object.keys(manualProducts)]);
  for (const product of extraProducts) {
    if (!byProduct.has(product)) {
      const count = (historicalProducts[product]?.count || 0) + (manualProducts[product]?.count || 0);
      rows.push({ product, totalLeads: 0, contactRate: null, quoteRate: null, closeRate: null, salesCount: count });
    }
  }

  return rows.sort((a, b) => b.totalLeads - a.totalLeads);
}

// { agencyId, from, to } -> one row per TM actively assigned to this
// agency — leads submitted + sold count/rate. Shared by the Agency Owner's
// telemarketers.js performance route and Ed's agency-owner context, so
// there's exactly one place that defines what "TM performance" means.
async function computeTelemarketerPerformance({ agencyId, from, to }) {
  const assignments = await prisma.telemarketerAssignment.findMany({
    where: { agencyId, status: 'ACTIVE' },
    include: { telemarketer: { select: { id: true, firstName: true, lastName: true } } },
  });

  const rows = await Promise.all(
    assignments.map(async (assignment) => {
      const tm = assignment.telemarketer;
      const leads = await prisma.lead.findMany({
        where: { agencyId, createdById: tm.id, source: 'telemarketer', receivedAt: { gte: from, lte: to }, archivedAt: null },
        select: { status: true },
      });
      const total = leads.length;
      const sold = leads.filter((l) => l.status === 'SOLD').length;
      return {
        telemarketerId: tm.id,
        firstName: tm.firstName,
        lastName: tm.lastName,
        leadsSubmitted: total,
        soldCount: sold,
        soldRate: total ? Math.round((sold / total) * 1000) / 10 : null,
      };
    })
  );

  return rows.sort((a, b) => b.leadsSubmitted - a.leadsSubmitted);
}

module.exports = { computeVendorBreakdown, computeProductBreakdown, computeTelemarketerPerformance };
