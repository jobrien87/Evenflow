// One-time, reviewable backfill for RevenueEvent.saleId AND
// RevenueEvent.occurredAt on Sale-linked rows.
//
// Part 1 (saleId): every sourceType:'SALE' RevenueEvent created before
// that column existed is currently unlinked (saleId: null) — the edit/
// void sync logic (lib/financialEvents.js's syncSaleRevenueEvent) upserts
// BY saleId, so without this backfill the first correction to any
// pre-existing sale would create a second, duplicate RevenueEvent instead
// of updating the orphaned original one. The link is fully deterministic,
// never a guess: recordManualSaleRevenue always embedded the real sale id
// verbatim in its `notes` field, as `(sale ${sale.id})`. This script
// regex-extracts that id, confirms a real Sale with that id still exists
// and has no RevenueEvent already linked to it, and sets saleId — any row
// that doesn't match that exact pattern, or whose Sale no longer exists,
// is left untouched and reported, never guessed at.
//
// Part 2 (occurredAt): syncSaleRevenueEvent now always sets occurredAt to
// the Sale's real saleDate (business date), so Financials' date-range
// queries (which filter on occurredAt) agree with Billboard's own
// saleDate-based bucketing — see financialEvents.js's comment for the
// full reasoning. Before that fix, occurredAt defaulted to the row's
// creation/last-edit timestamp, which can differ from saleDate for any
// sale entered after the fact or corrected with a backdated saleDate.
// This pass realigns every saleId-linked RevenueEvent (whether just
// linked by Part 1 above, or already linked from this session's earlier
// saleId rollout) whose occurredAt doesn't match its Sale's saleDate.
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

  // Part 2: every saleId-linked RevenueEvent (the ones Part 1 is about to
  // link, plus any already linked from an earlier run) whose occurredAt
  // doesn't match its Sale's real saleDate.
  const alreadyLinked = await prisma.revenueEvent.findMany({
    where: { sourceType: 'SALE', saleId: { not: null } },
    select: { id: true, saleId: true, occurredAt: true },
  });
  const linkedAfterThisRun = updates.map((u) => ({ id: u.revenueEventId, saleId: u.saleId, occurredAt: null }));
  const allLinkedForDateCheck = [...alreadyLinked, ...linkedAfterThisRun];
  const saleIds = [...new Set(allLinkedForDateCheck.map((r) => r.saleId))];
  const sales = await prisma.sale.findMany({ where: { id: { in: saleIds } }, select: { id: true, saleDate: true } });
  const saleDateById = new Map(sales.map((s) => [s.id, s.saleDate]));

  const dateFixes = [];
  for (const row of allLinkedForDateCheck) {
    const saleDate = saleDateById.get(row.saleId);
    if (!saleDate) continue;
    if (row.occurredAt === null || new Date(row.occurredAt).getTime() !== new Date(saleDate).getTime()) {
      dateFixes.push({ revenueEventId: row.id, saleDate });
    }
  }
  console.log(`\nScanned ${allLinkedForDateCheck.length} saleId-linked RevenueEvent row(s) for occurredAt drift from their Sale's saleDate.`);
  console.log(`  Needs occurredAt realignment: ${dateFixes.length}`);

  if (!confirm) {
    console.log('\nDry run only — no rows were changed. Re-run with --confirm to apply both passes.');
    return;
  }

  for (const { revenueEventId, saleId } of updates) {
    await prisma.revenueEvent.update({ where: { id: revenueEventId }, data: { saleId } });
  }
  console.log(`\nApplied: ${updates.length} RevenueEvent row(s) linked to their Sale via saleId.`);

  for (const { revenueEventId, saleDate } of dateFixes) {
    await prisma.revenueEvent.update({ where: { id: revenueEventId }, data: { occurredAt: saleDate } });
  }
  console.log(`Applied: ${dateFixes.length} RevenueEvent row(s) realigned to their Sale's real saleDate.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
