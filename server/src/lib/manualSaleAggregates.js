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
const { zonedYearMonthDay } = require('./timezone');

// Same opt-in Eastern-calendar-day boundary conversion as
// historicalAggregates.js's dateRangeWhere — saleDate is stored as
// UTC-midnight-of-calendar-date (routes/sales.js's `new Date(data.saleDate)`
// on a plain "YYYY-MM-DD" input parses as UTC midnight, same encoding as
// HistoricalRecord.recordDate). Only applied when timeZone is explicitly
// passed (computeBillboardPeriod's real Eastern period boundaries) —
// billboard.js's legacy computeBillboard rolling-range callers keep the
// raw instant comparison unchanged.
function toCalendarUtcMidnight(instant, timeZone) {
  const { year, month, day } = zonedYearMonthDay(instant, timeZone);
  return new Date(Date.UTC(year, month - 1, day));
}

function dateRangeWhere(agencyId, from, to, extra = {}, timeZone) {
  const [gteBound, ltBound] = timeZone
    ? [toCalendarUtcMidnight(from, timeZone), toCalendarUtcMidnight(to, timeZone)]
    : [from, to];
  return {
    agencyId,
    // Exclusive upper bound, matching billboardPeriods.js's own
    // already-exclusive `to` convention and billboard.js's bucketBySpans.
    saleDate: { gte: gteBound, lt: ltBound },
    voidedAt: null,
    // A zero/null-premium Sale must never inflate sold production —
    // explicit user override of this model's earlier "null = unknown,
    // entered later" aggregation stance. The row itself is still stored
    // and editable (PATCH can fill in the real premium later); it just
    // doesn't count toward soldCount/itemCount/revenue until it does,
    // same floor historicalAggregates.js already applies.
    premiumCents: { gt: 0 },
    ...extra,
  };
}

async function sumSalePremium({ agencyId, from, to, assignedToId, productFamily, timeZone }) {
  const where = dateRangeWhere(agencyId, from, to, {
    ...(assignedToId !== undefined ? { assignedToId } : {}),
    ...(productFamily ? { productFamily } : {}),
  }, timeZone);
  const result = await prisma.sale.aggregate({ where, _sum: { premiumCents: true } });
  return result._sum.premiumCents || 0;
}

async function countSales({ agencyId, from, to, assignedToId, productFamily, timeZone }) {
  const where = dateRangeWhere(agencyId, from, to, {
    ...(assignedToId !== undefined ? { assignedToId } : {}),
    ...(productFamily ? { productFamily } : {}),
  }, timeZone);
  return prisma.sale.count({ where });
}

// {userId, premiumCents, count}[] — a Sale always has a real assignedToId
// (required field), so unlike historicalByAgent there's no "unmatched"
// bucket needed here.
async function salesByAgent({ agencyId, from, to, timeZone }) {
  const rows = await prisma.sale.findMany({
    where: dateRangeWhere(agencyId, from, to, {}, timeZone),
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
async function salesByProduct({ agencyId, from, to, assignedToId, timeZone }) {
  const rows = await prisma.sale.findMany({
    where: dateRangeWhere(agencyId, from, to, assignedToId !== undefined ? { assignedToId } : {}, timeZone),
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
async function saleLeadLikeRows({ agencyId, from, to, timeZone }) {
  const rows = await prisma.sale.findMany({
    where: dateRangeWhere(agencyId, from, to, {}, timeZone),
    select: {
      saleDate: true,
      premiumCents: true,
      productFamily: true,
      assignedToId: true,
      assignedTo: { select: { id: true, firstName: true, lastName: true } },
      zip: true,
      items: true,
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
    items: r.items,
  }));
}

module.exports = {
  sumSalePremium,
  countSales,
  salesByAgent,
  salesByProduct,
  saleLeadLikeRows,
};
