// Pure functions only — no DB access here. This keeps the actual arithmetic
// testable without a database and guarantees the same formula is used
// everywhere (per spec: "do not calculate different versions of the same
// KPI on different pages").

function centsToDisplay(cents) {
  return Math.round(cents) / 100;
}

// Computes revenue/cost/profit/margin from real summed totals (in cents).
// Every value here is ACTUAL — derived from entered RevenueEvent/CostEvent
// rows, never a projection. If there is no revenue at all, margin/ROI are
// explicitly null with a reason, never zero or fabricated.
function computeProfitability({ revenueCents, costCents, denominatorCount, denominatorLabel }) {
  const grossProfitCents = revenueCents - costCents;
  const hasRevenue = revenueCents > 0;
  const hasDenominator = typeof denominatorCount === 'number' && denominatorCount > 0;

  return {
    revenue: centsToDisplay(revenueCents),
    cost: centsToDisplay(costCents),
    grossProfit: centsToDisplay(grossProfitCents),
    marginPercent: hasRevenue ? Math.round((grossProfitCents / revenueCents) * 1000) / 10 : null,
    marginReason: hasRevenue ? null : 'INSUFFICIENT_DATA: no revenue recorded for this period',
    costPer: hasDenominator ? centsToDisplay(costCents / denominatorCount) : null,
    revenuePer: hasDenominator ? centsToDisplay(revenueCents / denominatorCount) : null,
    perDenominatorLabel: denominatorLabel || null,
    perReason: hasDenominator ? null : `INSUFFICIENT_DATA: no ${denominatorLabel || 'denominator'} recorded for this period`,
  };
}

// ROI = (revenue - cost) / cost. Distinct from margin (which divides by revenue).
// Returns null with a reason if cost is zero, rather than dividing by zero
// or reporting an infinite/fabricated ROI.
function computeROI({ revenueCents, costCents }) {
  if (!costCents || costCents <= 0) {
    return { roiPercent: null, reason: 'INSUFFICIENT_DATA: no cost recorded to compute ROI against' };
  }
  return { roiPercent: Math.round(((revenueCents - costCents) / costCents) * 1000) / 10, reason: null };
}

module.exports = { computeProfitability, computeROI, centsToDisplay };
