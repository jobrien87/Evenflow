// Read-only aggregate queries over Sale (the "Add Closed Sale" standalone
// -- no originating Lead -- model) — mirrors lib/historicalAggregates.js's
// own two-pattern playbook exactly: `saleLeadLikeRows` reshapes Sale rows
// into the same {updatedAt, salePremiumCents, saleProduct, assignedToId,
// vendorId, zip} shape lib/billboard.js's `soldLeads` array already uses,
// so a manual sale concatenates straight in with zero change to Billboard's
// aggregation logic; the narrower sum/count/by-X helpers below are for
// routes that already have their own live-data query and just need one
// more number added in (financials.js, performanceBreakdown.js,
// runningReport.js), same as historicalAggregates.js's own narrower
// exports. These feed INTO existing report computations — never a second,
// parallel report surface. A voided Sale is excluded from everything here.
const { prisma } = require('./db');

function dateRangeWhere(agencyId, from, to, extra = {}) {
  return {
    agencyId,
    saleDate: { gte: from, lte: to },
    voidedAt: null,
    ...extra,
  };
}

async function sumSalePremium({ agencyId, from, to, assignedToId, productFamily }) {
  const where = dateRangeWhere(agencyId, from, to, {
    ...(assignedToId !== undefined ? { assignedToId } : {}),
    ...(productFamily ? { productFamily } : {}),
  });
  const result = await prisma.sale.aggregate({ where, _sum: { premiumCents: true } });
  return result._sum.premiumCents || 0;
}

async function countSales({ agencyId, from, to, assignedToId, productFamily }) {
  const where = dateRangeWhere(agencyId, from, to, {
    ...(assignedToId !== undefined ? { assignedToId } : {}),
    ...(productFamily ? { productFamily } : {}),
  });
  return prisma.sale.count({ where });
}

// {userId, premiumCents, count}[] — a Sale always has a real assignedToId
// (required field), so unlike historicalByAgent there's no "unmatched"
// bucket needed here.
async function salesByAgent({ agencyId, from, to }) {
  const rows = await prisma.sale.findMany({
    where: dateRangeWhere(agencyId, from, to),
    select: { assignedToId: true, premiumCents: true },
  });
  const byAgent = new Map();
  for (const r of rows) {
    const existing = byAgent.get(r.assignedToId) || { userId: r.assignedToId, premiumCents: 0, count: 0 };
    existing.premiumCents += r.premiumCents || 0;
    existing.count += 1;
    byAgent.set(r.assignedToId, existing);
  }
  return [...byAgent.values()];
}

// {[productFamily]: {premiumCents, count}} — matches
// performanceBreakdown.js's own grouping-key convention.
async function salesByProduct({ agencyId, from, to, assignedToId }) {
  const rows = await prisma.sale.findMany({
    where: dateRangeWhere(agencyId, from, to, assignedToId !== undefined ? { assignedToId } : {}),
    select: { productFamily: true, premiumCents: true },
  });
  const byProduct = {};
  for (const r of rows) {
    const key = r.productFamily || 'Unspecified';
    if (!byProduct[key]) byProduct[key] = { premiumCents: 0, count: 0 };
    byProduct[key].premiumCents += r.premiumCents || 0;
    byProduct[key].count += 1;
  }
  return byProduct;
}

// Rows shaped exactly like lib/billboard.js's own `soldLeads` select —
// concatenate straight into that array (see that file's merge point in
// computeBillboard()). vendorId/vendor are always null: a standalone sale
// was never bought from a lead vendor by definition, so it naturally lands
// in Billboard's existing "Direct / No Vendor" fallback bucket, which is
// exactly right.
async function saleLeadLikeRows({ agencyId, from, to }) {
  const rows = await prisma.sale.findMany({
    where: dateRangeWhere(agencyId, from, to),
    select: {
      saleDate: true,
      premiumCents: true,
      productFamily: true,
      assignedToId: true,
      assignedTo: { select: { id: true, firstName: true, lastName: true } },
      zip: true,
    },
  });
  return rows.map((r) => ({
    updatedAt: r.saleDate,
    salePremiumCents: r.premiumCents,
    saleProduct: r.productFamily,
    assignedToId: r.assignedToId,
    assignedTo: r.assignedTo,
    vendorId: null,
    vendor: null,
    zip: r.zip,
  }));
}

module.exports = {
  sumSalePremium,
  countSales,
  salesByAgent,
  salesByProduct,
  saleLeadLikeRows,
};
