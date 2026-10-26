// Read-only report, never run automatically. Sale.items defaults to the
// literal integer 1 whenever a value isn't explicitly provided (DB default,
// createSaleRecord's own fallback, and the Add Closed Sale form's prefill —
// now fixed going forward to prefill from a lead's real sold-product-quote
// count, but that fix does nothing for rows already saved with a stale 1).
// This script finds Sale rows that likely got the wrong items count: a
// bundled/multi-product lead (2+ productQuotes reaching SOLD) whose linked
// Sale is still sitting at items === 1. It changes nothing — a producer may
// have legitimately logged items: 1 even when a lead had multiple quotes
// (e.g. only one product actually closed), so each row needs a human to
// confirm before correcting it via the existing Closed Sales edit flow
// (click the row -> fix Items -> Save).
//
// Usage: node scripts/report-sale-items-mismatch.js
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const candidates = await prisma.sale.findMany({
    where: {
      voidedAt: null,
      items: 1,
      lead: { is: { productQuotes: { some: { status: 'SOLD' } } } },
    },
    select: {
      id: true,
      agencyId: true,
      firstName: true,
      lastName: true,
      policyNumber: true,
      saleDate: true,
      items: true,
      assignedToId: true,
      lead: { select: { productQuotes: { select: { status: true } } } },
    },
  });

  const mismatches = candidates
    .map((sale) => ({
      ...sale,
      soldQuoteCount: sale.lead?.productQuotes.filter((q) => q.status === 'SOLD').length || 0,
    }))
    .filter((sale) => sale.soldQuoteCount > 1);

  console.log(`[report] ${mismatches.length} Sale row(s) have items=1 but their lead has more than 1 SOLD product quote.`);

  if (mismatches.length === 0) return;

  const byAgencyProducer = new Map();
  for (const sale of mismatches) {
    const key = `${sale.agencyId}|${sale.assignedToId || '(unassigned)'}`;
    byAgencyProducer.set(key, (byAgencyProducer.get(key) || 0) + 1);
  }
  console.log('\nBreakdown by agency + producer:');
  for (const [key, count] of byAgencyProducer) {
    const [agencyId, assignedToId] = key.split('|');
    console.log(`  agencyId=${agencyId} assignedToId=${assignedToId} count=${count}`);
  }

  console.log('\nRows (review each, then correct via Closed Sales -> click row -> Items -> Save):');
  for (const sale of mismatches) {
    console.log(
      `  saleId=${sale.id} agencyId=${sale.agencyId} producer=${sale.assignedToId || '(unassigned)'} ` +
        `customer=${sale.firstName} ${sale.lastName} policy=${sale.policyNumber || '(none)'} ` +
        `saleDate=${sale.saleDate?.toISOString()} storedItems=${sale.items} soldQuoteCount=${sale.soldQuoteCount}`,
    );
  }
}

main()
  .catch((err) => {
    console.error('[report-sale-items-mismatch] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
