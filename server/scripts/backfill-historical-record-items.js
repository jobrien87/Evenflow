// Reviewable, NOT auto-run backfill for HistoricalRecord.items on rows
// imported before historicalDataImport.js recognized an items-like
// column. Inspects each row's already-losslessly-captured rawFields for
// an unmapped items header; sets items/itemsSource:'explicit' only when
// a clean numeric value is found there. Never guesses/defaults to 1 —
// a row with no recognizable items column is left at items:null,
// flagged for manual reconciliation instead.
//
// Dry run (default): prints what WOULD change, writes nothing.
//   node scripts/backfill-historical-record-items.js
// Apply for real:
//   node scripts/backfill-historical-record-items.js --confirm
const { prisma } = require('../src/lib/db');
const { normalizeHeader } = require('../src/lib/columnMapper');
const { HEADER_SYNONYMS } = require('../src/lib/historicalDataImport');

const ITEMS_SYNONYMS = new Set(HEADER_SYNONYMS.items);

function findItemsValue(rawFields) {
  if (!rawFields || typeof rawFields !== 'object') return null;
  for (const [key, value] of Object.entries(rawFields)) {
    if (ITEMS_SYNONYMS.has(normalizeHeader(key))) {
      const cleaned = String(value).replace(/[^0-9]/g, '');
      if (!cleaned) continue;
      const n = parseInt(cleaned, 10);
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
}

async function main() {
  const confirm = process.argv.includes('--confirm');

  const rows = await prisma.historicalRecord.findMany({
    where: { items: null },
    select: { id: true, agencyId: true, rawFields: true },
  });

  let recoverable = 0;
  let unrecoverable = 0;
  const updates = [];

  for (const row of rows) {
    const items = findItemsValue(row.rawFields);
    if (items === null) {
      unrecoverable += 1;
      continue;
    }
    recoverable += 1;
    updates.push({ id: row.id, items });
  }

  console.log(`Scanned ${rows.length} HistoricalRecord row(s) with items:null.`);
  console.log(`  Recoverable from rawFields: ${recoverable}`);
  console.log(`  Still unrecoverable (left null, flagged for manual reconciliation): ${unrecoverable}`);

  if (!confirm) {
    console.log('\nDry run only — no rows were changed. Re-run with --confirm to apply.');
    return;
  }

  for (const { id, items } of updates) {
    await prisma.historicalRecord.update({ where: { id }, data: { items, itemsSource: 'explicit' } });
  }
  console.log(`\nApplied: ${updates.length} row(s) updated with items/itemsSource:'explicit'.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
