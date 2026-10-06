// The Billboard — a real leaderboard of SOLD leads by producer and by
// product line, plus a real time-series trend line, for an arbitrary
// granularity (day/week/month/year). Reuses the exact same "SOLD lead +
// its entered salePremiumCents" unit financials.js's /summary and
// /by-agent already treat as a real sale — never the separate
// LeadProductQuote per-product tracker, so there's one definition of "a
// sale" across the whole app, not two.

const { prisma } = require('./db');
const { PRODUCT_LABELS } = require('./products');
const { historicalLeadLikeRows } = require('./historicalAggregates');

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

  const [realSoldLeads, historicalRows, producers] = await Promise.all([
    prisma.lead.findMany({
      where: { agencyId, status: 'SOLD', updatedAt: { gte: range.from, lte: range.to } },
      select: {
        updatedAt: true,
        salePremiumCents: true,
        saleProduct: true,
        assignedToId: true,
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
        vendorId: true,
        vendor: { select: { id: true, name: true } },
        zip: true,
      },
    }),
    // Historical Data (Back Catalog) rows, shaped identically to the real
    // Lead rows above — concatenated in so every grouping/series below
    // reuses this one aggregation pass rather than a second copy of it.
    historicalLeadLikeRows({ agencyId, from: range.from, to: range.to }),
    // Same roster query financials.js's /by-agent already uses — every
    // active producer must appear on the leaderboard even with zero sales
    // in range, not just whoever happened to sell something.
    prisma.user.findMany({ where: { agencyId, role: 'PRODUCER', status: 'ACTIVE' }, select: { id: true, firstName: true, lastName: true } }),
  ]);
  const soldLeads = [...realSoldLeads, ...historicalRows];

  const byProducerMap = new Map();
  for (const p of producers) {
    byProducerMap.set(p.id, { userId: p.id, firstName: p.firstName, lastName: p.lastName, soldCount: 0, premiumCents: 0 });
  }
  const byProductMap = new Map();
  const byVendorMap = new Map();
  const byZipMap = new Map();
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

    // Vendor-less sales (manual/telemarketer/bulk-import leads) bucket
    // under a real, honest "Direct / No Vendor" row rather than being
    // silently dropped from the breakdown.
    const vendorKey = lead.vendorId || '__direct__';
    const vrow = byVendorMap.get(vendorKey) || {
      vendorId: lead.vendorId || null,
      vendorName: lead.vendor?.name || 'Direct / No Vendor',
      soldCount: 0,
      premiumCents: 0,
    };
    vrow.soldCount += 1;
    vrow.premiumCents += premium;
    byVendorMap.set(vendorKey, vrow);

    // zip is only ever captured on telemarketer-intake leads today — a
    // sale from any other source buckets under an honest "Unknown" row
    // rather than being dropped or fabricated.
    const zipKey = lead.zip || 'Unknown';
    const zrow = byZipMap.get(zipKey) || { zip: zipKey, soldCount: 0, premiumCents: 0 };
    zrow.soldCount += 1;
    zrow.premiumCents += premium;
    byZipMap.set(zipKey, zrow);
  }

  const byProducer = Array.from(byProducerMap.values()).sort(
    (a, b) => b.premiumCents - a.premiumCents || `${a.lastName}${a.firstName}`.localeCompare(`${b.lastName}${b.firstName}`)
  );
  const byProduct = Array.from(byProductMap.values()).sort((a, b) => b.premiumCents - a.premiumCents);
  const byVendor = Array.from(byVendorMap.values()).sort((a, b) => b.premiumCents - a.premiumCents);
  const byZip = Array.from(byZipMap.values()).sort((a, b) => b.premiumCents - a.premiumCents);
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
    byVendor,
    byZip,
    series,
    // Historical Data (Back Catalog) rows folded into the totals above —
    // surfaced so the client can show a small "(includes N historical
    // records)" caption without a second, parallel report surface.
    historicalRecordsIncluded: historicalRows.length,
  };
}

module.exports = { computeBillboard, bucketStart, bucketKey, buildSeries, defaultRange, GRANULARITIES };
