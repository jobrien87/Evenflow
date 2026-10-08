// Read-only reconciliation report (item 3 of the production-correction
// round). Lead reaching SOLD (whole-lead or per-product) used to post a
// real RevenueEvent via recordLeadSaleRevenue/recordLeadProductSaleRevenue
// — both removed, since a Lead reaching SOLD is a queue/pipeline
// disposition only now. This script classifies every pre-existing
// LEAD_REVENUE RevenueEvent row (there is no sourceType to filter on for
// these — that field was only added going forward) so the user can see
// real counts/dollar totals before deciding whether to leave them as
// permanent historical record or build a reviewable void/annotate pass.
// Never mutates anything.
//
// Run with: node scripts/report-legacy-lead-revenue-events.js
const { prisma } = require('../src/lib/db');

const LEAD_NOTES_RE = /^Sale premium recorded for lead ([0-9a-f-]{36}) \((.+)\)$/;
const MANUAL_NOTES_RE = /^Manual closed-sale entry: .* \(sale ([0-9a-f-]{36})\)$/;

async function classify(event) {
  if (event.sourceType === 'SALE') return 'manual_sale_post_sourcetype';
  if (event.notes && MANUAL_NOTES_RE.test(event.notes)) return 'manual_sale_pre_sourcetype';

  const match = event.notes && event.notes.match(LEAD_NOTES_RE);
  if (!match) return 'unclassified';

  const leadId = match[1];
  // Best-effort: look for the real LeadEvent nearest this RevenueEvent's
  // occurredAt among the two legacy posting paths, to label whole-lead
  // disposition vs. per-product. Not load-bearing for the dollar totals
  // below — purely informational.
  const candidates = await prisma.leadEvent.findMany({
    where: { leadId, type: { in: ['lead.disposition', 'lead.product_sold'] } },
    select: { type: true, createdAt: true },
  });
  if (candidates.length === 0) return 'legacy_lead_revenue_no_matching_leadevent';
  const nearest = candidates.reduce((best, c) => {
    const diff = Math.abs(new Date(c.createdAt) - new Date(event.occurredAt));
    return diff < best.diff ? { diff, type: c.type } : best;
  }, { diff: Infinity, type: null });
  return nearest.type === 'lead.product_sold' ? 'legacy_lead_product_sold' : 'legacy_lead_disposition';
}

async function main() {
  const events = await prisma.revenueEvent.findMany({
    where: { category: 'LEAD_REVENUE' },
    select: { id: true, agencyId: true, amountCents: true, occurredAt: true, notes: true, sourceType: true },
    orderBy: { occurredAt: 'asc' },
  });

  const summary = new Map();
  for (const event of events) {
    const label = await classify(event);
    const bucket = summary.get(label) || { count: 0, amountCents: 0, agencyIds: new Set() };
    bucket.count += 1;
    bucket.amountCents += event.amountCents || 0;
    if (event.agencyId) bucket.agencyIds.add(event.agencyId);
    summary.set(label, bucket);
  }

  console.log(`Total LEAD_REVENUE RevenueEvent rows: ${events.length}\n`);
  for (const [label, bucket] of summary) {
    console.log(`${label}:`);
    console.log(`  count: ${bucket.count}`);
    console.log(`  total: $${(bucket.amountCents / 100).toFixed(2)}`);
    console.log(`  distinct agencies: ${bucket.agencyIds.size}`);
    console.log('');
  }

  console.log('No rows were modified. This is a read-only report.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
