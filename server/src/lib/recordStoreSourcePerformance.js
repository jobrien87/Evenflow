// Per-source performance for one Record Store lead program
// (RecordStoreSubscription) — "how good are the leads coming from each
// individual source on this filter set." Pure analysis, no side effects.
//
// Real sold count/revenue comes from actual Sale rows joined back by
// Sale.leadId — same "never trust a live Lead's own status/snapshot
// alone for revenue" discipline lib/vendorReport.js and lib/
// zipBreakdown.js already follow — just queried directly against this
// subscription's own lead set rather than through saleLeadLikeRows
// (whose agency-wide date-range query has no leadId in its return shape
// today, and widening a function several other reports depend on isn't
// warranted for this one join). Quote rate reuses the same
// QUOTED_OR_BEYOND_STATUSES convention as those reports.
//
// lib/recordStoreSourceOptimization.js is the one caller that turns this
// into an actual filter-set change; routes/recordStore.js's own GET
// /subscriptions/:id/source-performance just surfaces it read-only.

const { prisma } = require('./db');
const { pct } = require('./funnelMetrics');
const { QUOTED_OR_BEYOND_STATUSES } = require('./leadStatusGroups');
const { labelSources } = require('./recordStoreSourceLabels');

// A source needs at least this many leads in the window before its own
// rates are trusted for anything decision-driving (dropping it, etc.) —
// below this, display it honestly but never let it drive an automatic
// change (see recordStoreSourceOptimization.js's decideChanges). A
// handful of random leads converting at 0% or 100% is noise, not signal.
const MIN_SAMPLE_SIZE = 10;

// { subscriptionId, from, to } -> { subscription, perSource: [...], totalLeads } | null
// perSource is sorted best-closeRate-first; every row carries `label`,
// never the raw `sourceCode` is meant to be rendered by a caller.
async function computeSourcePerformance({ subscriptionId, from, to }) {
  const subscription = await prisma.recordStoreSubscription.findUnique({
    where: { id: subscriptionId },
  });
  if (!subscription) return null;

  const leads = await prisma.lead.findMany({
    where: { recordStoreSubscriptionId: subscriptionId, receivedAt: { gte: from, lte: to } },
    select: { id: true, status: true, recordStoreSourceCode: true },
  });

  const sales = leads.length
    ? await prisma.sale.findMany({
        where: { leadId: { in: leads.map((l) => l.id) }, voidedAt: null },
        select: { leadId: true, premiumCents: true },
      })
    : [];
  const revenueByLeadId = new Map();
  for (const sale of sales) {
    if (!sale.leadId) continue;
    revenueByLeadId.set(sale.leadId, (revenueByLeadId.get(sale.leadId) || 0) + (sale.premiumCents || 0));
  }

  const bySource = new Map();
  for (const lead of leads) {
    const code = lead.recordStoreSourceCode || 'UNKNOWN';
    if (!bySource.has(code)) bySource.set(code, { leadCount: 0, quotedCount: 0, soldCount: 0, revenueCents: 0 });
    const bucket = bySource.get(code);
    bucket.leadCount += 1;
    if (QUOTED_OR_BEYOND_STATUSES.includes(lead.status)) bucket.quotedCount += 1;
    const revenue = revenueByLeadId.get(lead.id);
    if (revenue) {
      bucket.soldCount += 1;
      bucket.revenueCents += revenue;
    }
  }

  const priceCents = subscription.priceSnapshotCents || 0;
  const codes = [...bySource.keys()].filter((c) => c !== 'UNKNOWN');
  const labels = new Map((await labelSources(codes)).map((l) => [l.value, l.label]));

  const perSource = [...bySource.entries()]
    .map(([code, stats]) => ({
      sourceCode: code,
      label: code === 'UNKNOWN' ? 'Unattributed' : labels.get(code) || code,
      leadCount: stats.leadCount,
      quotedCount: stats.quotedCount,
      quoteRate: pct(stats.quotedCount, stats.leadCount),
      soldCount: stats.soldCount,
      closeRate: pct(stats.soldCount, stats.leadCount),
      costCents: stats.leadCount * priceCents,
      revenueCents: stats.revenueCents,
      hasMinimumSample: stats.leadCount >= MIN_SAMPLE_SIZE,
    }))
    .sort((a, b) => (b.closeRate ?? -1) - (a.closeRate ?? -1));

  return {
    subscription: { id: subscription.id, productName: subscription.productNameSnapshot },
    totalLeads: leads.length,
    minimumSampleSize: MIN_SAMPLE_SIZE,
    perSource,
  };
}

module.exports = { computeSourcePerformance, MIN_SAMPLE_SIZE };
