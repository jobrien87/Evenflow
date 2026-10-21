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
const { reportingProductKey } = require('./products');
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
    // A logged sale counts the moment it's logged — premium or not. A
    // producer routinely logs a real Closed Sale before the carrier has
    // confirmed the premium (the row stays editable via PATCH once it's
    // known), and that row must still show up as sold production, not
    // vanish from soldCount/itemCount/byProducer until someone fills in
    // a dollar amount. No row-level exclusion here on premiumCents —
    // every sum below (_sum.premiumCents, `r.premiumCents || 0`
    // accumulators) already null-coalesces to 0 on its own, so dollar
    // totals stay exactly as accurate as what's actually been entered
    // without needing to drop the row from the query. See
    // billboard.js's aggregateSoldRows for the paired unknownPremiumCount
    // figure that keeps an understated dollar total visibly flagged
    // instead of silently wrong.
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

// Standalone sales only (no originating Lead) — the one case a "quotes"
// count can safely add Sale-based credit without risking a double-count:
// a Lead-linked sale's quote credit already comes from that Lead's own
// disposition history (or doesn't, if the Lead was never dispositioned
// QUOTED/QUOTED_HOT), so adding it again here would double-count the
// same real prospect. A standalone sale has no Lead at all to generate
// that disposition event, so counting it here is purely additive.
async function countStandaloneSales({ agencyId, from, to, assignedToId, timeZone }) {
  const where = dateRangeWhere(agencyId, from, to, {
    leadId: null,
    ...(assignedToId !== undefined ? { assignedToId } : {}),
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
    const key = reportingProductKey(r.productFamily);
    if (!byProduct[key]) byProduct[key] = { premiumCents: 0, count: 0 };
    byProduct[key].premiumCents += r.premiumCents || 0;
    byProduct[key].count += 1;
  }
  return byProduct;
}

// {vendorId|null, premiumCents, count}[] — a standalone sale (no
// originating Lead) has no vendor by definition, so it's grouped under the
// null bucket; a Lead-linked sale is attributed to that Lead's real
// vendorId (the one place a Closed Sale CAN carry a vendor dimension,
// since Sale itself has no vendorId column). financials.js's /by-vendor
// route turns the null bucket into a visible "Direct / No Vendor" row,
// same convention saleLeadLikeRows below already uses for Billboard.
async function salesByVendor({ agencyId, from, to, timeZone }) {
  const rows = await prisma.sale.findMany({
    where: dateRangeWhere(agencyId, from, to, {}, timeZone),
    select: { premiumCents: true, lead: { select: { vendorId: true } } },
  });
  const byVendor = new Map();
  for (const r of rows) {
    const key = r.lead?.vendorId || null;
    const existing = byVendor.get(key) || { vendorId: key, premiumCents: 0, count: 0 };
    existing.premiumCents += r.premiumCents || 0;
    existing.count += 1;
    byVendor.set(key, existing);
  }
  return [...byVendor.values()];
}

// Rows shaped exactly like lib/billboard.js's own `soldLeads` select —
// concatenate straight into that array (see that file's merge point in
// computeBillboard()). A standalone sale has no vendor by definition
// (vendorId/vendor stay null, landing in Billboard's "Direct / No Vendor"
// bucket); a Lead-linked sale is attributed to that Lead's real vendor,
// the same join salesByVendor above uses.
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
      lead: { select: { vendorId: true, vendor: { select: { id: true, name: true } } } },
    },
  });
  return rows.map((r) => ({
    updatedAt: r.saleDate,
    salePremiumCents: r.premiumCents,
    saleProduct: r.productFamily,
    assignedToId: r.assignedToId,
    assignedTo: r.assignedTo,
    vendorId: r.lead?.vendorId || null,
    vendor: r.lead?.vendor || null,
    zip: r.zip,
    items: r.items,
  }));
}

module.exports = {
  sumSalePremium,
  countSales,
  countStandaloneSales,
  salesByAgent,
  salesByProduct,
  salesByVendor,
  saleLeadLikeRows,
};
