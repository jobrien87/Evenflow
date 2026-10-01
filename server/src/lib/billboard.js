// The Billboard — a real leaderboard of SOLD leads by producer and by
// product line, plus a real time-series trend line, for an arbitrary
// granularity (day/week/month/year). Reuses the exact same "SOLD lead +
// its entered salePremiumCents" unit financials.js's /summary and
// /by-agent already treat as a real sale — never the separate
// LeadProductQuote per-product tracker, so there's one definition of "a
// sale" across the whole app, not two.

const { prisma } = require('./db');
const { PRODUCT_LABELS } = require('./products');

const GRANULARITIES = ['day', 'week', 'month', 'year'];

// Real calendar bucket start for a date at a given granularity. Week
// buckets start Monday (ISO) — the one week-boundary convention already
// used elsewhere in this app (no Sunday-start option exists anywhere).
function bucketStart(date, granularity) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (granularity === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  if (granularity === 'year') return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  if (granularity === 'week') {
    const day = d.getUTCDay(); // 0 = Sunday
    const diff = (day === 0 ? -6 : 1) - day;
    d.setUTCDate(d.getUTCDate() + diff);
    return d;
  }
  return d; // day
}

function bucketKey(date, granularity) {
  return bucketStart(new Date(date), granularity).toISOString().slice(0, 10);
}

function advance(date, granularity) {
  const next = new Date(date);
  if (granularity === 'day') next.setUTCDate(next.getUTCDate() + 1);
  else if (granularity === 'week') next.setUTCDate(next.getUTCDate() + 7);
  else if (granularity === 'year') next.setUTCFullYear(next.getUTCFullYear() + 1);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

// Real default lookback window per granularity when the caller supplies
// no explicit range — enough buckets for a real trend line, never an
// unbounded "since the beginning of time" scan.
function defaultRange(granularity, now = new Date()) {
  const to = now;
  const from = new Date(now);
  if (granularity === 'day') from.setUTCDate(from.getUTCDate() - 30);
  else if (granularity === 'week') from.setUTCDate(from.getUTCDate() - 7 * 12);
  else if (granularity === 'year') from.setUTCFullYear(from.getUTCFullYear() - 5);
  else from.setUTCMonth(from.getUTCMonth() - 11); // month: trailing 12 months
  return { from, to };
}

// Pure — buckets an already-fetched list of SOLD leads into one row per
// real calendar bucket across the whole range. A bucket with zero sales
// is reported as zero, never omitted, so the line is never fabricated
// into looking continuous when a period genuinely had nothing.
function buildSeries(soldLeads, granularity, from, to) {
  const buckets = new Map();
  let cursor = bucketStart(from, granularity);
  const end = bucketStart(to, granularity);
  let guard = 0;
  while (cursor <= end && guard < 1000) {
    const key = cursor.toISOString().slice(0, 10);
    buckets.set(key, { date: key, soldCount: 0, premiumCents: 0 });
    cursor = advance(cursor, granularity);
    guard += 1;
  }
  for (const lead of soldLeads) {
    const key = bucketKey(lead.updatedAt, granularity);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.soldCount += 1;
      bucket.premiumCents += lead.salePremiumCents || 0;
    }
  }
  return Array.from(buckets.values());
}

async function computeBillboard({ agencyId, granularity = 'month', from, to }) {
  const g = GRANULARITIES.includes(granularity) ? granularity : 'month';
  const range = from && to ? { from: new Date(from), to: new Date(to) } : defaultRange(g);

  const soldLeads = await prisma.lead.findMany({
    where: { agencyId, status: 'SOLD', updatedAt: { gte: range.from, lte: range.to } },
    select: {
      updatedAt: true,
      salePremiumCents: true,
      saleProduct: true,
      assignedToId: true,
      assignedTo: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  const byProducerMap = new Map();
  const byProductMap = new Map();
  for (const lead of soldLeads) {
    const premium = lead.salePremiumCents || 0;
    if (lead.assignedToId) {
      const row = byProducerMap.get(lead.assignedToId) || {
        userId: lead.assignedToId,
        firstName: lead.assignedTo?.firstName || '',
        lastName: lead.assignedTo?.lastName || '',
        soldCount: 0,
        premiumCents: 0,
      };
      row.soldCount += 1;
      row.premiumCents += premium;
      byProducerMap.set(lead.assignedToId, row);
    }
    const product = lead.saleProduct || 'Unspecified';
    const prow = byProductMap.get(product) || { product, label: PRODUCT_LABELS[product] || product, soldCount: 0, premiumCents: 0 };
    prow.soldCount += 1;
    prow.premiumCents += premium;
    byProductMap.set(product, prow);
  }

  const byProducer = Array.from(byProducerMap.values()).sort((a, b) => b.premiumCents - a.premiumCents);
  const byProduct = Array.from(byProductMap.values()).sort((a, b) => b.premiumCents - a.premiumCents);
  const series = buildSeries(soldLeads, g, range.from, range.to);

  return {
    granularity: g,
    period: { from: range.from.toISOString(), to: range.to.toISOString() },
    totals: {
      soldCount: soldLeads.length,
      premiumCents: soldLeads.reduce((sum, l) => sum + (l.salePremiumCents || 0), 0),
    },
    byProducer,
    byProduct,
    series,
  };
}

module.exports = { computeBillboard, bucketStart, bucketKey, buildSeries, defaultRange, GRANULARITIES };
