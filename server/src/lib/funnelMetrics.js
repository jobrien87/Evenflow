// CRM response-speed & funnel metrics — real rates computed from real Lead
// fields already in the schema (assignedAt, firstAttemptAt, firstContactAt,
// status). Same honesty rule as Flow Score and financialCalc: a rate with
// zero underlying sample is null with a reason, never a fabricated 0/100.

const { prisma } = require('./db');
const { QUOTED_OR_BEYOND_STATUSES } = require('./leadStatusGroups');

function pct(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// { agencyId, userId?, vendorId?, product?, from, to } — userId omitted
// means agency-wide; vendorId/product further narrow to one vendor or
// one product/lead-type (used by the per-vendor and per-product
// performance breakdowns).
async function computeFunnel({ agencyId, userId, vendorId, product, from, to }) {
  const where = {
    agencyId,
    ...(userId ? { assignedToId: userId } : {}),
    ...(vendorId ? { vendorId } : {}),
    ...(product ? { product } : {}),
    receivedAt: { gte: from, lte: to },
    // A bulk/Back Catalog import batch (POST /bulk-import,
    // /back-catalog-import) is backfill/batch data, not real-time CRM
    // work — a 15,000-row historical or Winback/Cross-Sell upload would
    // otherwise silently crater contactRate/quoteRate/closeRate for
    // whoever it lands on, assigned or not. importBatchId is the one
    // clean signal every such row carries that manual/vendor/
    // telemarketer leads never do (see Lead.importBatchId's own schema
    // comment) — excluded everywhere in this function, not just the
    // speed metric below.
    importBatchId: null,
  };
  const leads = await prisma.lead.findMany({
    where,
    select: { status: true, assignedAt: true, firstAttemptAt: true, firstContactAt: true, vendorId: true },
  });

  const total = leads.length;
  // Speed-to-first-attempt is additionally a real-time-vendor-intake SLA —
  // only leads that actually came through the authenticated vendor API
  // (Lead.vendorId set) carry a receipt timestamp worth measuring response
  // speed against. contactRate/quoteRate/closeRate stay unfiltered beyond
  // the importBatchId exclusion above — ordinary CRM pipeline activity
  // from any real-time intake source (manual, vendor, telemarketer) still
  // counts toward them.
  const attempted = leads.filter((l) => l.vendorId && l.assignedAt && l.firstAttemptAt);
  const contacted = leads.filter((l) => l.firstContactAt);
  const quotedOrBeyond = leads.filter((l) => QUOTED_OR_BEYOND_STATUSES.includes(l.status));
  const sold = leads.filter((l) => l.status === 'SOLD');

  const speedToAttemptMinutes = attempted.map(
    (l) => (l.firstAttemptAt.getTime() - l.assignedAt.getTime()) / 60000
  );

  return {
    totalLeads: total,
    speedToFirstAttemptMedianMinutes: attempted.length > 0 ? median(speedToAttemptMinutes) : null,
    speedToFirstAttemptSampleSize: attempted.length,
    contactRate: pct(contacted.length, total),
    contactRateSampleSize: total,
    quoteRate: pct(quotedOrBeyond.length, total),
    quoteRateSampleSize: total,
    closeRate: pct(sold.length, total),
    closeRateSampleSize: total,
  };
}

module.exports = { computeFunnel, pct };
