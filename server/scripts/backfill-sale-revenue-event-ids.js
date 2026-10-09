// One-time, reviewable backfill for RevenueEvent.saleId. Every
// sourceType:'SALE' RevenueEvent created before that column existed is
// currently unlinked (saleId: null) — the new edit/void sync logic
// (lib/financialEvents.js's syncSaleRevenueEvent) upserts BY saleId, so
// without this backfill the first correction to any pre-existing sale
// would create a second, duplicate RevenueEvent instead of updating the
// orphaned original one.
//
// The link is fully deterministic, never a guess: recordManualSaleRevenue
// always embedded the real sale id verbatim in its `notes` field, as
// `(sale ${sale.id})`. This script regex-extracts that id, confirms a
// real Sale with that id still exists and has no RevenueEvent already
// linked to it, and sets saleId — any row that doesn't match that exact
// pattern, or whose Sale no longer exists, is left untouched and
// reported, never guessed at.
//
// Dry run (default): prints what WOULD change, writes nothing.
//   node scripts/backfill-sale-revenue-event-ids.js
// Apply for real:
//   node scripts/backfill-sale-revenue-event-ids.js --confirm
const { prisma } = require('../src/lib/db');

const SALE_ID_PATTERN = /\(sale ([0-9a-fA-F-]{36})\)$/;

async function main() {
  const confirm = process.argv.includes('--confirm');

  const rows = await prisma.revenueEvent.findMany({
    where: { sourceType: 'SALE', saleId: null },
    select: { id: true, notes: true },
  });

  let linked = 0;
  let noMatch = 0;
  let saleNotFound = 0;
  let saleAlreadyLinked = 0;
  const updates = [];

  for (const row of rows) {
    const match = (row.notes || '').match(SALE_ID_PATTERN);
    if (!match) {
      noMatch += 1;
      continue;
    }
    const saleId = match[1];
    const sale = await prisma.sale.findUnique({ where: { id: saleId }, select: { id: true, revenueEvent: { select: { id: true } } } });
    if (!sale) {
      saleNotFound += 1;
      continue;
    }
    if (sale.revenueEvent && sale.revenueEvent.id !== row.id) {
      saleAlreadyLinked += 1;
      continue;
    }
    linked += 1;
    updates.push({ revenueEventId: row.id, saleId });
  }

  console.log(`Scanned ${rows.length} RevenueEvent row(s) with sourceType:'SALE' and saleId:null.`);
  console.log(`  Linkable (real sale id found in notes, sale exists, not already linked): ${linked}`);
  console.log(`  No sale id pattern found in notes: ${noMatch}`);
  console.log(`  Sale id found but no matching Sale row exists: ${saleNotFound}`);
  console.log(`  Sale already linked to a different RevenueEvent (left alone, flagged): ${saleAlreadyLinked}`);

  if (!confirm) {
    console.log('\nDry run only — no rows were changed. Re-run with --confirm to apply.');
    return;
  }

  for (const { revenueEventId, saleId } of updates) {
    await prisma.revenueEvent.update({ where: { id: revenueEventId }, data: { saleId } });
  }
  console.log(`\nApplied: ${updates.length} RevenueEvent row(s) linked to their Sale via saleId.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
