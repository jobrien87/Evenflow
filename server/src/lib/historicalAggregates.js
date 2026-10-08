// Read-only aggregate queries over HistoricalRecord — the only way any
// other part of the app is allowed to see Historical Data import numbers.
// Every number here is either a real sum/count from the table or zero/null;
// nothing is estimated (same "deterministic arithmetic, nothing fabricated"
// convention as funnelMetrics.js and the rest of this app's reporting
// layer). These feed INTO existing report computations (financials.js,
// lib/billboard.js, runningReport.js, performanceBreakdown.js) — they are
// never a second, parallel report surface of their own.
const { prisma } = require('./db');

function dateRangeWhere(agencyId, from, to, extra = {}) {
  return {
    agencyId,
    recordDate: { gte: from, lte: to },
    isSold: true,
    // A zero/null-premium row must never count as sold production,
    // regardless of its stored isSold flag — this protects every
    // consumer below (sums, counts, by-vendor/agent/product breakdowns,
    // and Billboard via historicalLeadLikeRows) at read time, including
    // rows that were already imported before classifyIsSold's own fix.
    premiumCents: { gt: 0 },
    ...extra,
  };
}

async function sumHistoricalPremium({ agencyId, from, to, vendorId, assignedToId, product }) {
  const where = dateRangeWhere(agencyId, from, to, {
    ...(vendorId !== undefined ? { vendorId } : {}),
    ...(assignedToId !== undefined ? { assignedToId } : {}),
    ...(product ? { product } : {}),
  });
  const result = await prisma.historicalRecord.aggregate({ where, _sum: { premiumCents: true } });
  return result._sum.premiumCents || 0;
}

async function countHistoricalSold({ agencyId, from, to, vendorId, assignedToId, product }) {
  const where = dateRangeWhere(agencyId, from, to, {
    ...(vendorId !== undefined ? { vendorId } : {}),
    ...(assignedToId !== undefined ? { assignedToId } : {}),
    ...(product ? { product } : {}),
  });
  return prisma.historicalRecord.count({ where });
}

// [{vendorId, vendorName, premiumCents, count}] — includes one
// {vendorId: null, vendorName: 'Historical (unmatched vendor)', ...} row
// only when there's unattributed historical premium in range, so a caller
// merging this into an existing by-vendor list never adds a zero-value row.
async function historicalByVendor({ agencyId, from, to }) {
  const rows = await prisma.historicalRecord.findMany({
    where: dateRangeWhere(agencyId, from, to),
    select: { vendorId: true, vendor: { select: { name: true } }, premiumCents: true },
  });
  const byVendor = new Map();
  let unmatchedPremium = 0;
  let unmatchedCount = 0;
  for (const r of rows) {
    const amount = r.premiumCents || 0;
    if (!r.vendorId) {
      unmatchedPremium += amount;
      unmatchedCount += 1;
      continue;
    }
    const existing = byVendor.get(r.vendorId) || { vendorId: r.vendorId, vendorName: r.vendor?.name || null, premiumCents: 0, count: 0 };
    existing.premiumCents += amount;
    existing.count += 1;
    byVendor.set(r.vendorId, existing);
  }
  const result = [...byVendor.values()];
  if (unmatchedCount > 0) {
    result.push({ vendorId: null, vendorName: 'Historical (unmatched vendor)', premiumCents: unmatchedPremium, count: unmatchedCount });
  }
  return result;
}

// Same shape for agents — {userId, premiumCents, count}, {userId: null, ...}
// bucket for historical rows whose agent name didn't match any real User.
async function historicalByAgent({ agencyId, from, to }) {
  const rows = await prisma.historicalRecord.findMany({
    where: dateRangeWhere(agencyId, from, to),
    select: { assignedToId: true, premiumCents: true },
  });
  const byAgent = new Map();
  let unmatchedPremium = 0;
  let unmatchedCount = 0;
  for (const r of rows) {
    const amount = r.premiumCents || 0;
    if (!r.assignedToId) {
      unmatchedPremium += amount;
      unmatchedCount += 1;
      continue;
    }
    const existing = byAgent.get(r.assignedToId) || { userId: r.assignedToId, premiumCents: 0, count: 0 };
    existing.premiumCents += amount;
    existing.count += 1;
    byAgent.set(r.assignedToId, existing);
  }
  const result = [...byAgent.values()];
  if (unmatchedCount > 0) {
    result.push({ userId: null, premiumCents: unmatchedPremium, count: unmatchedCount });
  }
  return result;
}

// {product: {premiumCents, count}} — product is always present on a sold
// historical row's own text (no "unmatched" bucket needed here, unlike
// vendor/agent, since product is free text, not matched against a roster).
async function historicalByProduct({ agencyId, from, to, assignedToId }) {
  const rows = await prisma.historicalRecord.findMany({
    where: dateRangeWhere(agencyId, from, to, assignedToId !== undefined ? { assignedToId } : {}),
    select: { product: true, premiumCents: true },
  });
  const byProduct = {};
  for (const r of rows) {
    // Matches performanceBreakdown.js's own "Unspecified" fallback key, so
    // a historical row with no product merges into the same row as a live
    // lead with no product, rather than showing as a separate bucket.
    const key = r.product || 'Unspecified';
    if (!byProduct[key]) byProduct[key] = { premiumCents: 0, count: 0 };
    byProduct[key].premiumCents += r.premiumCents || 0;
    byProduct[key].count += 1;
  }
  return byProduct;
}

// Rows shaped exactly like lib/billboard.js's own `soldLeads` select, so a
// historical record can be concatenated straight into that array and reuse
// every bit of Billboard's existing aggregation/grouping logic unchanged —
// see that file's merge point in computeBillboard().
async function historicalLeadLikeRows({ agencyId, from, to }) {
  const rows = await prisma.historicalRecord.findMany({
    where: dateRangeWhere(agencyId, from, to),
    select: {
      recordDate: true,
      premiumCents: true,
      product: true,
      assignedToId: true,
      assignedTo: { select: { id: true, firstName: true, lastName: true } },
      vendorId: true,
      vendor: { select: { id: true, name: true } },
      zip: true,
    },
  });
  return rows.map((r) => ({
    updatedAt: r.recordDate,
    salePremiumCents: r.premiumCents,
    saleProduct: r.product,
    assignedToId: r.assignedToId,
    assignedTo: r.assignedTo,
    vendorId: r.vendorId,
    vendor: r.vendor,
    zip: r.zip,
  }));
}

module.exports = {
  sumHistoricalPremium,
  countHistoricalSold,
  historicalByVendor,
  historicalByAgent,
  historicalByProduct,
  historicalLeadLikeRows,
};
