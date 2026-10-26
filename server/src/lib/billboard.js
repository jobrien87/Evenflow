// The Billboard — a real leaderboard of closed sales by producer and by
// product line, plus a real time-series trend line, for an arbitrary
// granularity (day/week/month/year). A Lead reaching SOLD status is a
// queue/pipeline disposition only and is never read here for production —
// the one real sale unit is a Sale row (Add Closed Sale) or a historical
// import record (Back Catalog's "Historical Data" mode — e.g. a
// Performology/AgencyZoom/Ricochet port-in), reshaped identically via
// manualSaleAggregates.js/historicalAggregates.js and merged into the one
// aggregation pass below.

const { prisma } = require('./db');
const { PRODUCT_LABELS, reportingProductKey } = require('./products');
const { historicalLeadLikeRows } = require('./historicalAggregates');
const { saleLeadLikeRows } = require('./manualSaleAggregates');
const { eligibleProducersWhere } = require('./eligibleProducersQuery');
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

// The real producer/product/vendor/zip grouping pass — pure, given an
// already-fetched soldLeads array and a producer roster to zero-fill.
// Shared by both computeBillboard and computeBillboardPeriod so this
// logic is written exactly once. soldCount is a policy/row count — every
// row in soldLeads counts, premium or not (manualSaleAggregates.js no
// longer excludes a row from the query just because its premium hasn't
// been entered yet; historicalAggregates.js still does, for a different,
// import-data-quality reason). itemCount (sum of Sale.items/
// HistoricalRecord.items), unknownItemsCount (rows with no recoverable
// items figure), and unknownPremiumCount (rows with no premium entered
// yet) are tracked as distinct numbers alongside premiumCents — a policy
// with 3 items and no premium yet shows 3 items, contributes $0, and is
// flagged via unknownPremiumCount, never silently dropped or conflated
// with row count.
function aggregateSoldRows(soldLeads, producers) {
  const byProducerMap = new Map();
  for (const p of producers) {
    byProducerMap.set(p.id, { userId: p.id, firstName: p.firstName, lastName: p.lastName, soldCount: 0, itemCount: 0, unknownItemsCount: 0, unknownPremiumCount: 0, premiumCents: 0 });
  }
  const byProductMap = new Map();
  const byVendorMap = new Map();
  const byZipMap = new Map();

  function itemContribution(lead) {
    return lead.items === null || lead.items === undefined ? 0 : lead.items;
  }
  function isUnknownItems(lead) {
    return lead.items === null || lead.items === undefined ? 1 : 0;
  }
  // Same null-vs-explicit-zero distinction as isUnknownItems above, applied
  // to premium: a row whose premium was never entered yet (null) is flagged
  // as needing reconciliation; an explicit, deliberate $0 sale is not —
  // it already counts fully toward soldCount/itemCount, it just has
  // nothing to add to the dollar total.
  function isUnknownPremium(lead) {
    return lead.salePremiumCents === null || lead.salePremiumCents === undefined ? 1 : 0;
  }

  for (const lead of soldLeads) {
    const premium = lead.salePremiumCents || 0;
    const items = itemContribution(lead);
    const unknownItems = isUnknownItems(lead);
    const unknownPremium = isUnknownPremium(lead);
    if (lead.assignedToId) {
      const row = byProducerMap.get(lead.assignedToId) || {
        userId: lead.assignedToId,
        firstName: lead.assignedTo?.firstName || '',
        lastName: lead.assignedTo?.lastName || '',
        soldCount: 0,
        itemCount: 0,
        unknownItemsCount: 0,
        unknownPremiumCount: 0,
        premiumCents: 0,
      };
      row.soldCount += 1;
      row.itemCount += items;
      row.unknownItemsCount += unknownItems;
      row.unknownPremiumCount += unknownPremium;
      row.premiumCents += premium;
      byProducerMap.set(lead.assignedToId, row);
    }
    const product = reportingProductKey(lead.saleProduct);
    const prow = byProductMap.get(product) || { product, label: PRODUCT_LABELS[product] || product, soldCount: 0, itemCount: 0, unknownItemsCount: 0, unknownPremiumCount: 0, premiumCents: 0 };
    prow.soldCount += 1;
    prow.itemCount += items;
    prow.unknownItemsCount += unknownItems;
    prow.unknownPremiumCount += unknownPremium;
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
      itemCount: 0,
      unknownItemsCount: 0,
      unknownPremiumCount: 0,
      premiumCents: 0,
    };
    vrow.soldCount += 1;
    vrow.itemCount += items;
    vrow.unknownItemsCount += unknownItems;
    vrow.unknownPremiumCount += unknownPremium;
    vrow.premiumCents += premium;
    byVendorMap.set(vendorKey, vrow);

    // zip is only ever captured on telemarketer-intake leads today — a
    // sale from any other source buckets under an honest "Unknown" row
    // rather than being dropped or fabricated.
    const zipKey = lead.zip || 'Unknown';
    const zrow = byZipMap.get(zipKey) || { zip: zipKey, soldCount: 0, itemCount: 0, unknownItemsCount: 0, unknownPremiumCount: 0, premiumCents: 0 };
    zrow.soldCount += 1;
    zrow.itemCount += items;
    zrow.unknownItemsCount += unknownItems;
    zrow.unknownPremiumCount += unknownPremium;
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
      itemCount: soldLeads.reduce((sum, l) => sum + itemContribution(l), 0),
      unknownItemsCount: soldLeads.reduce((sum, l) => sum + isUnknownItems(l), 0),
      unknownPremiumCount: soldLeads.reduce((sum, l) => sum + isUnknownPremium(l), 0),
      premiumCents: soldLeads.reduce((sum, l) => sum + (l.salePremiumCents || 0), 0),
    },
    byProducer,
    byProduct,
    byVendor,
    byZip,
  };
}

// A Back Catalog import has no automatic check against existing Sale rows
// (only the reverse direction — findPossibleDuplicates in routes/sales.js
// — warns when creating a NEW Sale that might duplicate an existing
// HistoricalRecord, and even that is a soft, overridable warning, not a
// block). Without this, the same real policy can exist in both tables and
// get counted twice here — the one place that reads Sale and
// HistoricalRecord together. Excludes a historical row only when it
// matches a live Sale by the same case-insensitive customer name within
// the agency's own configured saleDuplicateWindowDays — the identical
// judgment call already trusted in production for this exact decision,
// not a new or looser heuristic.
function excludeDuplicateHistoricalRows(historicalRows, manualSaleRows, windowDays) {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const saleNames = manualSaleRows
    .filter((s) => s.firstName && s.lastName)
    .map((s) => ({ name: `${s.firstName}|${s.lastName}`.toLowerCase(), time: s.updatedAt.getTime() }));
  return historicalRows.filter((h) => {
    if (!h.firstName || !h.lastName) return true;
    const hName = `${h.firstName}|${h.lastName}`.toLowerCase();
    const hTime = h.updatedAt.getTime();
    return !saleNames.some((s) => s.name === hName && Math.abs(s.time - hTime) <= windowMs);
  });
}

// Same real active-producer-and-manager roster query financials.js's
// /by-agent already uses — every active producer or selling manager must
// appear on the leaderboard even with zero sales in range, not just
// whoever happened to sell something.
function activeProducersQuery(agencyId) {
  return prisma.user.findMany({ where: eligibleProducersWhere(agencyId), select: { id: true, firstName: true, lastName: true } });
}

async function computeBillboard({ agencyId, granularity = 'month', from, to }) {
  const g = GRANULARITIES.includes(granularity) ? granularity : 'month';
  const range = from && to ? { from: new Date(from), to: new Date(to) } : defaultRange(g);

  const [historicalRows, manualSaleRows, producers, agency] = await Promise.all([
    // Historical Data (Back Catalog) rows — concatenated in so every
    // grouping/series below reuses this one aggregation pass rather than
    // a second copy of it.
    historicalLeadLikeRows({ agencyId, from: range.from, to: range.to }),
    // Add Closed Sale rows — the other real production entry (standalone
    // or linked back to a Lead via Sale.leadId) — same reshape pattern.
    saleLeadLikeRows({ agencyId, from: range.from, to: range.to }),
    activeProducersQuery(agencyId),
    prisma.agency.findUnique({ where: { id: agencyId }, select: { saleDuplicateWindowDays: true } }),
  ]);
  const dedupedHistoricalRows = excludeDuplicateHistoricalRows(historicalRows, manualSaleRows, agency?.saleDuplicateWindowDays ?? 3);
  const soldLeads = [...dedupedHistoricalRows, ...manualSaleRows];
  const aggregated = aggregateSoldRows(soldLeads, producers);
  const series = buildSeries(soldLeads, g, range.from, range.to);

  return {
    granularity: g,
    period: { from: range.from.toISOString(), to: range.to.toISOString() },
    ...aggregated,
    series,
    // Historical Data (Back Catalog) rows folded into the totals above —
    // surfaced so the client can show a small "(includes N historical
    // records)" caption without a second, parallel report surface. Counts
    // only what's actually included (post-duplicate-exclusion), not the
    // raw import count.
    historicalRecordsIncluded: dedupedHistoricalRows.length,
  };
}

// Buckets an already-fetched soldLeads list into an arbitrary list of
// {key, label, from, to} windows (the Week view's 5 daily buckets, the
// Year view's 12 month buckets, or All Years' N year buckets) — distinct
// from buildSeries, which only ever walks fixed-size granularity steps.
// Every row bucketBySpans receives (historicalLeadLikeRows/saleLeadLikeRows
// — computeBillboardPeriod never reads live Lead rows) has `updatedAt`
// stored as UTC-midnight-of-calendar-date, not a real instant. Comparing
// that raw value directly against span.from/to (real Eastern-zoned
// instants, e.g. Eastern Wed 00:00 = 04:00Z) misreads which day a row
// belongs to — the same root cause the aggregate WHERE clauses already
// fix via toCalendarUtcMidnight, applied here too so the series and the
// totals never disagree about which bucket a row falls in.
function bucketBySpans(soldLeads, spans, timeZone) {
  function calendarUtcMidnight(instant) {
    const { year, month, day } = zonedYearMonthDay(instant, timeZone);
    return Date.UTC(year, month - 1, day);
  }
  const spanBounds = spans.map((span) => ({
    span,
    from: calendarUtcMidnight(span.from),
    to: calendarUtcMidnight(span.to),
  }));
  return spanBounds.map(({ span, from, to }) => {
    let soldCount = 0;
    let itemCount = 0;
    let premiumCents = 0;
    for (const lead of soldLeads) {
      const t = new Date(lead.updatedAt).getTime();
      if (t >= from && t < to) {
        soldCount += 1;
        itemCount += lead.items === null || lead.items === undefined ? 0 : lead.items;
        premiumCents += lead.salePremiumCents || 0;
      }
    }
    return { date: span.key, label: span.label, soldCount, itemCount, premiumCents };
  });
}

// The new Eastern-time fixed-calendar-period entry point — Week/Month/
// Year/All Years, as distinct from computeBillboard's existing rolling
// day/week/month/year granularities, which stay completely unchanged
// above. Shares aggregateSoldRows/activeProducersQuery with
// computeBillboard, so the zero-premium protection and grouping logic are
// identical between the two entry points.
async function computeBillboardPeriod({ agencyId, period, month, year, now = new Date() }) {
  const p = BILLBOARD_PERIODS.includes(period) ? period : 'month';

  const agency = await prisma.agency.findUnique({ where: { id: agencyId }, select: { timezone: true, saleDuplicateWindowDays: true } });
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

  const [historicalRows, manualSaleRows, producers] = await Promise.all([
    historicalLeadLikeRows({ agencyId, from: range.from, to: range.to, timeZone }),
    saleLeadLikeRows({ agencyId, from: range.from, to: range.to, timeZone }),
    activeProducersQuery(agencyId),
  ]);
  const dedupedHistoricalRows = excludeDuplicateHistoricalRows(historicalRows, manualSaleRows, agency?.saleDuplicateWindowDays ?? 3);
  const soldLeads = [...dedupedHistoricalRows, ...manualSaleRows];
  const aggregated = aggregateSoldRows(soldLeads, producers);

  if (p === 'week') {
    series = bucketBySpans(soldLeads, extra.weekBuckets, timeZone);
  } else if (p === 'year') {
    series = bucketBySpans(soldLeads, extra.monthBuckets, timeZone);
  } else if (p === 'all_years') {
    series = bucketBySpans(soldLeads, extra.yearBuckets, timeZone);
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
    historicalRecordsIncluded: dedupedHistoricalRows.length,
  };
}

module.exports = { computeBillboard, computeBillboardPeriod, bucketStart, bucketKey, buildSeries, defaultRange, GRANULARITIES };
