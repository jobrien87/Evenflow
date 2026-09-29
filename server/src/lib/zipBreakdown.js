// Zip-code performance breakdown — one row per zip code an agency has
// received leads from, in the same "group real Lead rows, compute real
// rates" style as performanceBreakdown.js's vendor/product breakdowns.
//
// There is no zip-level cost field anywhere in the schema (cost only ever
// exists per-vendor, via Vendor.costPerLeadCents/CostEvent). So a zip's
// cost is attributed lead-by-lead: each lead's cost is its vendor's real
// cost-per-lead for this exact period (same CostEvent-aggregate formula
// financials.js's /by-vendor already uses — never a second cost model),
// summed per zip. Leads with no vendor (manual/telemarketer-sourced)
// contribute no cost, never a fabricated one. A zip with zero attributable
// cost gets costPerLead/cpa: null (INSUFFICIENT_DATA), same honesty rule
// as every other cost metric in this app.

const { prisma } = require('./db');
const { pct } = require('./funnelMetrics');

const QUOTED_OR_BEYOND = ['QUOTE_STARTED', 'QUOTED', 'APPOINTMENT', 'FOLLOW_UP', 'SOLD'];

function costPer(costCents, count) {
  return count > 0 ? Math.round(costCents / count) / 100 : null;
}

// { agencyId, from, to } -> one row per distinct Lead.zip this agency
// received in the period, sorted by lead volume descending (so "top N
// zips" is just array.slice(0, N)).
async function computeZipBreakdown({ agencyId, from, to }) {
  const [leads, vendors] = await Promise.all([
    prisma.lead.findMany({
      where: { agencyId, receivedAt: { gte: from, lte: to }, archivedAt: null },
      select: { zip: true, vendorId: true, status: true, salePremiumCents: true },
    }),
    prisma.vendor.findMany({ where: { agencyId }, select: { id: true } }),
  ]);

  // Real per-vendor cost-per-lead for this exact period — identical
  // formula to financials.js's /by-vendor route, so a zip's attributed
  // cost is never a second, different cost model.
  const vendorCostPerLeadCents = new Map();
  await Promise.all(
    vendors.map(async (v) => {
      const [costAgg, vendorLeadCount] = await Promise.all([
        prisma.costEvent.aggregate({ where: { vendorId: v.id, occurredAt: { gte: from, lte: to } }, _sum: { amountCents: true } }),
        prisma.lead.count({ where: { vendorId: v.id, receivedAt: { gte: from, lte: to }, archivedAt: null } }),
      ]);
      const costCents = costAgg._sum.amountCents || 0;
      vendorCostPerLeadCents.set(v.id, vendorLeadCount > 0 ? costCents / vendorLeadCount : 0);
    })
  );

  const byZip = new Map();
  for (const lead of leads) {
    const key = lead.zip || 'Unspecified';
    if (!byZip.has(key)) byZip.set(key, []);
    byZip.get(key).push(lead);
  }

  return [...byZip.entries()]
    .map(([zip, zipLeads]) => {
      const totalLeads = zipLeads.length;
      const quotedCount = zipLeads.filter((l) => QUOTED_OR_BEYOND.includes(l.status)).length;
      const soldLeads = zipLeads.filter((l) => l.status === 'SOLD');
      const soldCount = soldLeads.length;
      const revenueCents = soldLeads.reduce((sum, l) => sum + (l.salePremiumCents || 0), 0);

      const hasCostData = zipLeads.some((l) => l.vendorId && vendorCostPerLeadCents.has(l.vendorId));
      const totalCostCents = zipLeads.reduce((sum, l) => {
        if (!l.vendorId) return sum;
        return sum + (vendorCostPerLeadCents.get(l.vendorId) || 0);
      }, 0);

      return {
        zip,
        totalLeads,
        quotedCount,
        quoteRate: pct(quotedCount, totalLeads),
        soldCount,
        closeRate: pct(soldCount, totalLeads),
        revenue: revenueCents / 100,
        totalCost: hasCostData ? totalCostCents / 100 : null,
        costPerLead: hasCostData ? costPer(totalCostCents, totalLeads) : null,
        cpa: hasCostData ? costPer(totalCostCents, soldCount) : null,
      };
    })
    .sort((a, b) => b.totalLeads - a.totalLeads);
}

module.exports = { computeZipBreakdown };
