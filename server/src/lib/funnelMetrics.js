// CRM response-speed & funnel metrics — real rates computed from real Lead
// fields already in the schema (assignedAt, firstAttemptAt, firstContactAt,
// status). Same honesty rule as Flow Score and financialCalc: a rate with
// zero underlying sample is null with a reason, never a fabricated 0/100.

const { prisma } = require('./db');

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

// { agencyId, userId?, from, to } — userId omitted means agency-wide.
async function computeFunnel({ agencyId, userId, from, to }) {
  const where = {
    agencyId,
    ...(userId ? { assignedToId: userId } : {}),
    receivedAt: { gte: from, lte: to },
  };
  const leads = await prisma.lead.findMany({
    where,
    select: { status: true, assignedAt: true, firstAttemptAt: true, firstContactAt: true },
  });

  const total = leads.length;
  const attempted = leads.filter((l) => l.assignedAt && l.firstAttemptAt);
  const contacted = leads.filter((l) => l.firstContactAt);
  const quotedOrBeyond = leads.filter((l) =>
    ['QUOTE_STARTED', 'QUOTED', 'APPOINTMENT', 'FOLLOW_UP', 'SOLD'].includes(l.status)
  );
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

module.exports = { computeFunnel };
