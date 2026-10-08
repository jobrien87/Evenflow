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
const { saleLeadLikeRows } = require('./manualSaleAggregates');
const {
  PERIODS: BILLBOARD_PERIODS,
  mostRecentCompletedWorkWeek,
  monthBoundsEastern,
  yearBoundsEastern,
  yearMonthBuckets,
  agencyDataYearSpan,
} = require('./billboardPeriods');
const { zonedYearMonthDay } = require('./timezone');

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

// Real-Lead query shared by both computeBillboard (legacy rolling range)
// and computeBillboardPeriod (new fixed-calendar periods) — a SOLD lead
// with null/zero salePremiumCents must never count as sold production,
// so the premium floor lives here, once, protecting both callers.
function soldLeadsQuery(agencyId, from, to) {
  return prisma.lead.findMany({
    where: { agencyId, status: 'SOLD', salePremiumCents: { gt: 0 }, updatedAt: { gte: from, lte: to } },
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
  });
}

// The real producer/product/vendor/zip grouping pass — pure, given an
// already-fetched soldLeads array and a producer roster to zero-fill.
// Shared by both computeBillboard and computeBillboardPeriod so this
// logic (and its zero-premium protection, applied upstream in
// soldLeadsQuery/historicalAggregates/manualSaleAggregates) is written
// exactly once.
function aggregateSoldRows(soldLeads, producers) {
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

  return {
    totals: {
      soldCount: soldLeads.length,
      premiumCents: soldLeads.reduce((sum, l) => sum + (l.salePremiumCents || 0), 0),
    },
    byProducer,
    byProduct,
    byVendor,
    byZip,
  };
}

// Same real active-producer roster query financials.js's /by-agent
// already uses — every active producer must appear on the leaderboard
// even with zero sales in range, not just whoever happened to sell
// something.
function activeProducersQuery(agencyId) {
  return prisma.user.findMany({ where: { agencyId, role: 'PRODUCER', status: 'ACTIVE' }, select: { id: true, firstName: true, lastName: true } });
}

async function computeBillboard({ agencyId, granularity = 'month', from, to }) {
  const g = GRANULARITIES.includes(granularity) ? granularity : 'month';
  const range = from && to ? { from: new Date(from), to: new Date(to) } : defaultRange(g);

  const [realSoldLeads, historicalRows, manualSaleRows, producers] = await Promise.all([
    soldLeadsQuery(agencyId, range.from, range.to),
    // Historical Data (Back Catalog) rows, shaped identically to the real
    // Lead rows above — concatenated in so every grouping/series below
    // reuses this one aggregation pass rather than a second copy of it.
    historicalLeadLikeRows({ agencyId, from: range.from, to: range.to }),
    // Add Closed Sale (standalone, no Lead) rows — same reshape pattern.
    saleLeadLikeRows({ agencyId, from: range.from, to: range.to }),
    activeProducersQuery(agencyId),
  ]);
  const soldLeads = [...realSoldLeads, ...historicalRows, ...manualSaleRows];
  const aggregated = aggregateSoldRows(soldLeads, producers);
  const series = buildSeries(soldLeads, g, range.from, range.to);

  return {
    granularity: g,
    period: { from: range.from.toISOString(), to: range.to.toISOString() },
    ...aggregated,
    series,
    // Historical Data (Back Catalog) rows folded into the totals above —
    // surfaced so the client can show a small "(includes N historical
    // records)" caption without a second, parallel report surface.
    historicalRecordsIncluded: historicalRows.length,
  };
}

// Buckets an already-fetched soldLeads list into an arbitrary list of
// {key, label, from, to} windows (the Week view's 5 daily buckets, the
// Year view's 12 month buckets, or All Years' N year buckets) — distinct
// from buildSeries, which only ever walks fixed-size granularity steps.
function bucketBySpans(soldLeads, spans) {
  return spans.map((span) => {
    let soldCount = 0;
    let premiumCents = 0;
    for (const lead of soldLeads) {
      const t = new Date(lead.updatedAt).getTime();
      if (t >= span.from.getTime() && t < span.to.getTime()) {
        soldCount += 1;
        premiumCents += lead.salePremiumCents || 0;
      }
    }
    return { date: span.key, label: span.label, soldCount, premiumCents };
  });
}

// The new Eastern-time fixed-calendar-period entry point — Week/Month/
// Year/All Years, as distinct from computeBillboard's existing rolling
// day/week/month/year granularities, which stay completely unchanged
// above. Shares soldLeadsQuery/aggregateSoldRows/activeProducersQuery
// with computeBillboard, so the zero-premium protection and grouping
// logic are identical between the two entry points.
async function computeBillboardPeriod({ agencyId, period, month, year, now = new Date() }) {
  const p = BILLBOARD_PERIODS.includes(period) ? period : 'month';

  const agency = await prisma.agency.findUnique({ where: { id: agencyId }, select: { timezone: true } });
  const timeZone = agency?.timezone || 'America/New_York';

  let range;
  let series = [];
  let extra = {};

  if (p === 'week') {
    const week = mostRecentCompletedWorkWeek(now, timeZone);
    range = { from: week.from, to: week.to, label: week.label };
    extra.weekBuckets = week.buckets;
  } else if (p === 'month') {
    const { year: curYear, month: curMonth } = month
      ? { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) }
      : zonedYearMonthDay(now, timeZone);
    const bounds = monthBoundsEastern(curYear, curMonth, timeZone);
    range = { ...bounds };
    extra.selectedMonth = { year: curYear, month: curMonth };

    const span = await agencyDataYearSpan({ agencyId, timeZone });
    const nowYmd = zonedYearMonthDay(now, timeZone);
    const earliestYear = span ? Math.min(span.minYear, nowYmd.year) : nowYmd.year;
    const months = [];
    for (let yy = nowYmd.year; yy >= earliestYear; yy--) {
      const maxMonth = yy === nowYmd.year ? nowYmd.month : 12;
      for (let mm = maxMonth; mm >= 1; mm--) {
        const { label } = monthBoundsEastern(yy, mm, timeZone);
        months.push({ year: yy, month: mm, label });
      }
    }
    extra.availableMonths = months;
  } else if (p === 'year') {
    const curYear = year ? Number(year) : zonedYearMonthDay(now, timeZone).year;
    const bounds = yearBoundsEastern(curYear, timeZone);
    range = { ...bounds };
    extra.selectedYear = curYear;
    extra.monthBuckets = yearMonthBuckets(curYear, timeZone);
  } else {
    const span = await agencyDataYearSpan({ agencyId, timeZone });
    const nowYmd = zonedYearMonthDay(now, timeZone);
    const minYear = span ? span.minYear : nowYmd.year;
    const maxYear = span ? Math.max(span.maxYear, nowYmd.year) : nowYmd.year;
    const yearBounds = [];
    for (let yy = minYear; yy <= maxYear; yy++) yearBounds.push(yearBoundsEastern(yy, timeZone));
    range = { from: yearBounds[0].from, to: yearBounds[yearBounds.length - 1].to, label: `${minYear}–${maxYear}` };
    extra.yearBuckets = yearBounds;
  }

  const [realSoldLeads, historicalRows, manualSaleRows, producers] = await Promise.all([
    soldLeadsQuery(agencyId, range.from, range.to),
    historicalLeadLikeRows({ agencyId, from: range.from, to: range.to }),
    saleLeadLikeRows({ agencyId, from: range.from, to: range.to }),
    activeProducersQuery(agencyId),
  ]);
  const soldLeads = [...realSoldLeads, ...historicalRows, ...manualSaleRows];
  const aggregated = aggregateSoldRows(soldLeads, producers);

  if (p === 'week') {
    series = bucketBySpans(soldLeads, extra.weekBuckets);
  } else if (p === 'year') {
    series = bucketBySpans(soldLeads, extra.monthBuckets);
  } else if (p === 'all_years') {
    series = bucketBySpans(soldLeads, extra.yearBuckets);
  }
  // Month period intentionally has no series — only a single total.

  return {
    period: p,
    timezone: timeZone,
    periodLabel: range.label,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    ...(p === 'month' ? { selectedMonth: extra.selectedMonth, availableMonths: extra.availableMonths } : {}),
    ...(p === 'year' ? { selectedYear: extra.selectedYear } : {}),
    ...aggregated,
    series,
    historicalRecordsIncluded: historicalRows.length,
  };
}

module.exports = { computeBillboard, computeBillboardPeriod, bucketStart, bucketKey, buildSeries, defaultRange, GRANULARITIES };
