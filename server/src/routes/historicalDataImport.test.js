// Real-DB, real-HTTP tests for the "Historical Data" mode of Back Catalog
// (POST /leads/historical-data-import) — bulk numbers-only imports that must
// never become a workable Lead, but whose revenue/premium/sold-count DOES
// need to show up in the SAME existing reports a live sale already feeds
// (Financials, Billboard, Running Report's sales/premium goals, product
// sold-counts) — never in pipeline-speed rates or the funnel's lead count.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');
const { computeFunnel } = require('../lib/funnelMetrics');
const { computeProductBreakdown } = require('../lib/performanceBreakdown');
const { computeBillboard } = require('../lib/billboard');
const { computeGoalActual } = require('../lib/runningReport');
const { classifyIsSold } = require('../lib/historicalDataImport');
const { sumHistoricalPremium, countHistoricalSold, historicalLeadLikeRows } = require('../lib/historicalAggregates');

const suffix = Date.now();
let agencyId, ownerId, ownerCookie, vendorAId, producerXId, server, port, baseUrl;
let rangeFrom, rangeTo, outOfRangeDate;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Historical Data Test Agency ${suffix}` } });
  agencyId = agency.id;

  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `hist-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Hist', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const { rawToken } = await createSession(ownerId);
  ownerCookie = `evenflow_session=${rawToken}`;

  const producerX = await prisma.user.create({
    data: { email: `hist-prodx-${suffix}@test.local`, passwordHash: hash, firstName: 'Prod', lastName: 'X', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerXId = producerX.id;

  const vendorA = await prisma.vendor.create({
    data: { name: `Vendor A ${suffix}`, email: `vendora-${suffix}@test.local`, agencyId, product: 'Auto', status: 'LIVE' },
  });
  vendorAId = vendorA.id;

  // The date range every aggregate assertion below queries against.
  rangeFrom = new Date('2024-06-01T00:00:00Z');
  rangeTo = new Date('2024-06-30T23:59:59Z');
  outOfRangeDate = '2020-01-15'; // deliberately outside rangeFrom/rangeTo

  // One real live SOLD lead in the same range, to prove the final numbers
  // are LIVE + HISTORICAL, not historical replacing live.
  const customer = await prisma.customer.create({ data: { firstName: 'Live', lastName: 'Sale', phoneNormalized: `live${suffix}` } });
  await prisma.lead.create({
    data: {
      agencyId, customerId: customer.id, source: 'manual', status: 'SOLD',
      vendorId: vendorAId, assignedToId: producerXId, product: 'Auto',
      salePremiumCents: 100000, receivedAt: new Date('2024-06-10'), updatedAt: new Date('2024-06-10'),
      createdAt: new Date('2024-06-10'), createdById: ownerId,
    },
  });

  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.historicalRecord.deleteMany({ where: { agencyId } });
  await prisma.leadImportBatch.deleteMany({ where: { agencyId } });
  await prisma.leadEvent.deleteMany({ where: { lead: { agencyId } } });
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.vendor.deleteMany({ where: { agencyId } });
  await prisma.goal.deleteMany({ where: { agencyId } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, producerXId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, producerXId] } } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

function historicalCsv() {
  const header = 'Date,First Name,Last Name,Product,Vendor,Agent,Premium\n';
  const rows = [
    // row 1: matches VendorA + Prod X exactly, sold $500, in range
    `2024-06-05,Pat,Historical,Auto,Vendor A ${suffix},Prod X,500`,
    // row 2: no vendor/agent match, sold $300, in range -> unattributed buckets
    `2024-06-12,Sam,Unknown,Home,Totally Unknown Vendor,Totally Unknown Agent,300`,
    // row 3: in range, no premium -> not sold
    `2024-06-20,Not,Sold,Life,Vendor A ${suffix},Prod X,`,
    // row 4: valid date but OUTSIDE the aggregation range -> created, excluded from range queries
    `${outOfRangeDate},Old,Record,Auto,Vendor A ${suffix},Prod X,900`,
    // row 5: no date at all -> skipped at parse time
    `,Missing,Date,Auto,Vendor A ${suffix},Prod X,100`,
  ];
  return new Blob([header + rows.join('\n')], { type: 'text/csv' });
}

let batchId;

test('rejects a file with no recognizable date column', async () => {
  const form = new FormData();
  form.append('file', new Blob(['First Name,Last Name\nA,B'], { type: 'text/csv' }), 'bad.csv');
  form.append('sourceSystem', 'OTHER');
  const res = await fetch(`${baseUrl}/api/leads/historical-data-import`, { method: 'POST', headers: { Cookie: ownerCookie }, body: form });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'NO_DATE_COLUMN');
});

test('rejects an unrecognized sourceSystem', async () => {
  const form = new FormData();
  form.append('file', historicalCsv(), 'hist.csv');
  form.append('sourceSystem', 'NOT_REAL');
  const res = await fetch(`${baseUrl}/api/leads/historical-data-import`, { method: 'POST', headers: { Cookie: ownerCookie }, body: form });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'VALIDATION');
});

test('imports rows as HistoricalRecord, never Lead/Customer, with vendor/agent matching and zero notifications', async () => {
  const beforeLeadCount = await prisma.lead.count({ where: { agencyId } });
  const beforeNotifCount = await prisma.notification.count({ where: { agencyId } });

  const form = new FormData();
  form.append('file', historicalCsv(), 'hist.csv');
  form.append('sourceSystem', 'OTHER');
  const res = await fetch(`${baseUrl}/api/leads/historical-data-import`, { method: 'POST', headers: { Cookie: ownerCookie }, body: form });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, 4, 'rows 1-4 have dates; row 5 is skipped');
  assert.equal(body.skipped, 1);
  batchId = body.batchId;

  const afterLeadCount = await prisma.lead.count({ where: { agencyId } });
  assert.equal(afterLeadCount, beforeLeadCount, 'historical import must never create a Lead');
  const afterNotifCount = await prisma.notification.count({ where: { agencyId } });
  assert.equal(afterNotifCount, beforeNotifCount, 'historical import must never notify anyone');

  const records = await prisma.historicalRecord.findMany({ where: { importBatchId: batchId }, orderBy: { recordDate: 'asc' } });
  assert.equal(records.length, 4);

  const matched = records.find((r) => r.premiumCents === 50000 && r.isSold);
  assert.ok(matched);
  assert.equal(matched.vendorId, vendorAId, 'exact vendor name match must resolve');
  assert.equal(matched.assignedToId, producerXId, 'exact agent name match must resolve');

  const unmatched = records.find((r) => r.premiumCents === 30000);
  assert.ok(unmatched);
  assert.equal(unmatched.vendorId, null, 'no vendor named "Totally Unknown Vendor" exists — must stay null, never guessed');
  assert.equal(unmatched.assignedToId, null);
  assert.equal(unmatched.vendorNameRaw, 'Totally Unknown Vendor', 'raw text kept even when unmatched');

  const notSold = records.find((r) => r.outcome === null && r.premiumCents === null);
  assert.ok(notSold);
  assert.equal(notSold.isSold, false);
});

test('GET /leads/import-batches?kind=historical_data lists the batch; the default list excludes it', async () => {
  const historicalRes = await fetch(`${baseUrl}/api/leads/import-batches?kind=historical_data`, { headers: { Cookie: ownerCookie } });
  const historicalBody = await historicalRes.json();
  const batch = historicalBody.batches.find((b) => b.id === batchId);
  assert.ok(batch);
  assert.equal(batch.isHistorical, true);
  assert.equal(batch.undoableCount, 4, 'historical undo is always fully available — no "untouched" concept');
  assert.equal(batch.withinUndoWindow, true);

  const defaultRes = await fetch(`${baseUrl}/api/leads/import-batches`, { headers: { Cookie: ownerCookie } });
  const defaultBody = await defaultRes.json();
  assert.equal(defaultBody.batches.find((b) => b.id === batchId), undefined, 'a historical batch must never appear in the ordinary lead-upload history');
});

test('financials /summary includes historical premium/sold-count for the range; a live Lead reaching SOLD contributes nothing', async () => {
  const qs = `from=${rangeFrom.toISOString()}&to=${rangeTo.toISOString()}&agencyId=${agencyId}`;
  const res = await fetch(`${baseUrl}/api/financials/summary?${qs}`, { headers: { Cookie: ownerCookie } });
  const body = await res.json();
  assert.equal(res.status, 200);
  // A Lead reaching SOLD is a queue disposition only now, never a revenue/
  // production source — the seed lead (created directly with status:
  // 'SOLD', never via the disposition route) correctly produced no
  // RevenueEvent and must not count toward salesRecorded either.
  // historical $500 + $300 (row 3 unsold, row 4 out of range excluded)
  assert.equal(body.revenue, (50000 + 30000) / 100);
  assert.equal(body.salesRecorded, 2, 'historical sold count only — the live SOLD lead is a pipeline disposition, not a production record');
  assert.equal(body.historicalRecordsIncluded, 2);
});

test('financials /by-vendor merges matched historical premium into Vendor A, and buckets the unmatched row separately', async () => {
  const qs = `from=${rangeFrom.toISOString()}&to=${rangeTo.toISOString()}&agencyId=${agencyId}`;
  const res = await fetch(`${baseUrl}/api/financials/by-vendor?${qs}`, { headers: { Cookie: ownerCookie } });
  const body = await res.json();
  const vendorARow = body.vendors.find((v) => v.vendorId === vendorAId);
  assert.ok(vendorARow);
  // Only the matched historical row counts now — the live SOLD lead
  // assigned to this vendor is a pipeline disposition, not production.
  assert.equal(vendorARow.salesCount, 1);
  assert.equal(vendorARow.revenue, 500);

  const unmatchedRow = body.vendors.find((v) => v.vendorId === null);
  assert.ok(unmatchedRow, 'an unmatched-vendor historical bucket must be visible, not silently dropped');
  assert.equal(unmatchedRow.salesCount, 1);
  assert.equal(unmatchedRow.revenue, 300);
});

test('financials /by-agent merges matched historical premium into Prod X, and buckets the unattributed row separately', async () => {
  const qs = `from=${rangeFrom.toISOString()}&to=${rangeTo.toISOString()}&agencyId=${agencyId}`;
  const res = await fetch(`${baseUrl}/api/financials/by-agent?${qs}`, { headers: { Cookie: ownerCookie } });
  const body = await res.json();
  const prodXRow = body.agents.find((a) => a.userId === producerXId);
  assert.ok(prodXRow);
  // Only the matched historical row counts — the live SOLD lead assigned
  // to this producer is a pipeline disposition, not production.
  assert.equal(prodXRow.salesCount, 1);
  assert.equal(prodXRow.revenue, 500);

  const unattributedRow = body.agents.find((a) => a.userId === null);
  assert.ok(unattributedRow);
  assert.equal(unattributedRow.salesCount, 1);
  assert.equal(unattributedRow.revenue, 300);
});

test('computeBillboard merges historical sold rows into totals/byVendor; a live Lead reaching SOLD contributes nothing', async () => {
  const result = await computeBillboard({ agencyId, granularity: 'month', from: rangeFrom, to: rangeTo });
  assert.equal(result.totals.soldCount, 2);
  assert.equal(result.totals.premiumCents, 50000 + 30000);

  const vendorARow = result.byVendor.find((v) => v.vendorId === vendorAId);
  assert.equal(vendorARow.soldCount, 1);
  // The unmatched-vendor historical row buckets under Billboard's own
  // existing "Direct / No Vendor" convention — no new bucket type needed.
  const directRow = result.byVendor.find((v) => v.vendorId === null);
  assert.equal(directRow.vendorName, 'Direct / No Vendor');
  assert.equal(directRow.soldCount, 1);
  assert.equal(directRow.premiumCents, 30000);
});

test('computeGoalActual: historical data adds to the sales and premium_cents goal metrics', async () => {
  const salesActual = await computeGoalActual({ metric: 'sales', userId: null, agencyId, periodStart: rangeFrom, periodEnd: rangeTo });
  // Only the real disposition event counts for "live" sales here (the
  // historical rows were never dispositioned) — so this is 1 (real) + 2 (historical).
  assert.equal(salesActual, 0 + 2, 'no real lead.disposition SOLD event was created in this test, only the lead was created pre-SOLD — confirms historical count flows through even with zero live dispositions');

  const premiumActual = await computeGoalActual({ metric: 'premium_cents', userId: null, agencyId, periodStart: rangeFrom, periodEnd: rangeTo });
  assert.equal(premiumActual, 0 + 50000 + 30000, 'same reasoning — no live SOLD leadEvent exists, only historical contributes here');
});

test('computeProductBreakdown: historical sold-count is added to salesCount, never to totalLeads/rates', async () => {
  const rows = await computeProductBreakdown({ agencyId, userId: undefined, from: rangeFrom, to: rangeTo });
  const autoRow = rows.find((r) => r.product === 'Auto');
  assert.ok(autoRow);
  // totalLeads only counts the one real live Lead (receivedAt in range) —
  // the historical row never touches this pipeline-count field.
  assert.equal(autoRow.totalLeads, 1);
  // salesCount is historical + manual only now — the live Lead reaching
  // SOLD is a pipeline disposition, not a production record.
  assert.equal(autoRow.salesCount, 1, 'only the matched historical Auto row — the live SOLD lead is a pipeline disposition');

  // Home has zero live leads but one historical sale — must still appear.
  const homeRow = rows.find((r) => r.product === 'Home');
  assert.ok(homeRow, 'a product with only historical sales must still get a row');
  assert.equal(homeRow.totalLeads, 0);
  assert.equal(homeRow.salesCount, 1);
});

test('computeFunnel (pipeline totalLeads/rates) is completely unaffected by historical data', async () => {
  const funnel = await computeFunnel({ agencyId, from: rangeFrom, to: rangeTo });
  // Only the one real live Lead exists in this range — if historical data
  // leaked in here, totalLeads would be inflated well past 1.
  assert.equal(funnel.totalLeads, 1);
});

test('undo deletes every HistoricalRecord for the batch unconditionally, and the contribution disappears from financials again', async () => {
  const undoRes = await fetch(`${baseUrl}/api/leads/import-batches/${batchId}/undo`, { method: 'POST', headers: { Cookie: ownerCookie } });
  assert.equal(undoRes.status, 200);
  const undoBody = await undoRes.json();
  assert.equal(undoBody.archived, 4);

  const remaining = await prisma.historicalRecord.count({ where: { importBatchId: batchId } });
  assert.equal(remaining, 0);

  const qs = `from=${rangeFrom.toISOString()}&to=${rangeTo.toISOString()}&agencyId=${agencyId}`;
  const res = await fetch(`${baseUrl}/api/financials/summary?${qs}`, { headers: { Cookie: ownerCookie } });
  const body = await res.json();
  // The live seed lead never produced a RevenueEvent (created pre-SOLD,
  // not via disposition) — so with historical data gone, revenue is $0.
  assert.equal(body.revenue, 0, 'back to zero once historical data is undone (live seed lead has no RevenueEvent)');
  assert.equal(body.historicalRecordsIncluded, 0);
});

// Real Performology-shaped header set (Part 7 hardening): "Issue Date" as
// the date column, "Customer" as a single full-name column, "Policy Type"
// for product, "Premium Amount" for premium, "Dataset" carrying Sale/
// Termination/Reinstatement text, "Location" for office matching, plus an
// unrecognized "Source Batch" column that must still be captured losslessly.
function performologyCsv() {
  const header = 'Issue Date,Customer,Policy Type,Location,Premium Amount,Dataset,Source Batch\n';
  const rows = [
    `2024-06-05,Pat Historical,Auto,HQ Office ${suffix},500,Sale,BATCH-001`,
    // A termination carrying its original policy's premium must never be
    // double-counted as a new sale, regardless of the premium figure.
    `2024-06-10,Terminated Guy,Auto,HQ Office ${suffix},900,Termination,BATCH-002`,
    // A reinstatement IS a real incremental sale.
    `2024-06-15,Reinstated Person,Auto,HQ Office ${suffix},700,Reinstatement,BATCH-003`,
    // No office named this — officeId must stay null, officeNameRaw kept.
    `2024-06-20,No Office Guy,Auto,Nowhere Branch,200,Sale,BATCH-004`,
  ];
  return new Blob([header + rows.join('\n')], { type: 'text/csv' });
}

let performologyOfficeId;
let performologyBatchId;

test('a real Performology-shaped file is fully handled by the new synonyms alone, with zero AI calls', async () => {
  const office = await prisma.office.create({ data: { agencyId, name: `HQ Office ${suffix}` } });
  performologyOfficeId = office.id;

  // Force the honest "not configured" path regardless of what this sandbox's
  // own .env happens to have, so this assertion is about the synonyms
  // themselves, never an accident of environment — mirrors
  // columnMapper.test.js's own save/restore convention.
  const originalKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const form = new FormData();
    form.append('file', performologyCsv(), 'performology.csv');
    form.append('sourceSystem', 'PERFORMOLOGY');
    const res = await fetch(`${baseUrl}/api/leads/historical-data-import`, { method: 'POST', headers: { Cookie: ownerCookie }, body: form });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.created, 4);
    performologyBatchId = body.batchId;

    assert.equal(body.columnMapping.aiUsed, false);
    assert.equal(body.columnMapping.aiSkippedReason, 'not_configured', 'no live AI call in this test environment — the deterministic synonyms alone resolve every structured field');
    assert.ok(body.columnMapping.matchedFields.includes('recordDate') && body.columnMapping.matchedFields.includes('office') && body.columnMapping.matchedFields.includes('outcome'), 'the new Performology synonyms resolved these deterministically, with no AI needed');
  } finally {
    if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
  }

  const records = await prisma.historicalRecord.findMany({ where: { importBatchId: performologyBatchId }, orderBy: { recordDate: 'asc' } });
  assert.equal(records.length, 4);

  const sale = records.find((r) => r.outcome === 'Sale' && r.premiumCents === 50000);
  assert.ok(sale);
  assert.equal(sale.isSold, true);
  assert.equal(sale.officeId, performologyOfficeId, 'an exact "Location" match must resolve the real Office');
  assert.equal(sale.rawFields['Source Batch'], 'BATCH-001', 'an unrecognized column must still be captured losslessly');

  const termination = records.find((r) => r.outcome === 'Termination');
  assert.ok(termination);
  assert.equal(termination.premiumCents, 90000);
  assert.equal(termination.isSold, false, 'a termination must never be counted as sold, even carrying a premium');

  const reinstatement = records.find((r) => r.outcome === 'Reinstatement');
  assert.ok(reinstatement);
  assert.equal(reinstatement.isSold, true, 'a reinstatement is a real incremental sale');

  const unmatchedOffice = records.find((r) => r.officeNameRaw === 'Nowhere Branch');
  assert.ok(unmatchedOffice);
  assert.equal(unmatchedOffice.officeId, null, 'no office named "Nowhere Branch" exists — must stay null, never guessed');
});

test('undo cleans up the Performology batch', async () => {
  const undoRes = await fetch(`${baseUrl}/api/leads/import-batches/${performologyBatchId}/undo`, { method: 'POST', headers: { Cookie: ownerCookie } });
  assert.equal(undoRes.status, 200);
  await prisma.office.delete({ where: { id: performologyOfficeId } });
});

// Regression test for the real production bug: a genuine Excel date-typed
// cell, read the old way (raw:false), round-trips through SheetJS's own
// locale-formatted display string before ever reaching parseDateOrNull —
// exactly the mechanism that silently dropped rows from Tom Paterson's
// real Performology upload with no visible reason why. Builds a REAL
// .xlsx buffer (not CSV, which has no cell-type metadata at all) with an
// actual Date object in the date cell, so this only passes if the fix
// (raw:true + cellDates:true, using the native Date instance directly)
// is really in effect.
let xlsxBatchId;

test('a real .xlsx file with a genuine Excel date cell parses correctly, not silently dropped', async () => {
  const XLSX = require('xlsx');
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Date', 'Name', 'Product', 'Premium'],
    [new Date(Date.UTC(2026, 5, 15)), 'Real DateCell', 'Auto', 30000],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'realdates.xlsx');
  form.append('sourceSystem', 'OTHER');
  const res = await fetch(`${baseUrl}/api/leads/historical-data-import`, { method: 'POST', headers: { Cookie: ownerCookie }, body: form });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, 1, 'the real date-typed cell must parse correctly, not be silently skipped');
  assert.equal(body.skipped, 0);
  xlsxBatchId = body.batchId;

  const record = await prisma.historicalRecord.findFirst({ where: { importBatchId: xlsxBatchId } });
  assert.ok(record);
  assert.equal(record.recordDate.toISOString().slice(0, 10), '2026-06-15');
});

test('cleanup real .xlsx test batch', async () => {
  await fetch(`${baseUrl}/api/leads/import-batches/${xlsxBatchId}/undo`, { method: 'POST', headers: { Cookie: ownerCookie } });
});

// Regression test for the second real bug: a blank row previously vanished
// with no accounting anywhere (not created, not skipped), so the numbers
// shown to the user never reconciled against totalRows. Also confirms the
// new skippedReasons tally the client now reads instead of a hardcoded guess.
test('blank rows are counted in skipped with a real reason, and created+skipped reconciles against totalRows', async () => {
  const csv = [
    'Date,Name,Product,Premium',
    '2026-01-05,Good Row,Auto,10000',
    ',,,', // entirely blank
    ',Missing Date,Auto,20000', // real row, but no date -> different skip reason
  ].join('\n');

  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'blanks.csv');
  form.append('sourceSystem', 'OTHER');
  const res = await fetch(`${baseUrl}/api/leads/historical-data-import`, { method: 'POST', headers: { Cookie: ownerCookie }, body: form });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.totalRows, 3);
  assert.equal(body.created, 1);
  assert.equal(body.skipped, 2);
  assert.equal(body.created + body.skipped, body.totalRows, 'created + skipped must always reconcile against totalRows now');
  assert.equal(body.skippedReasons['Blank row'], 1);
  assert.equal(body.skippedReasons['Missing or unparseable date'], 1);

  await fetch(`${baseUrl}/api/leads/import-batches/${body.batchId}/undo`, { method: 'POST', headers: { Cookie: ownerCookie } });
});

// Regression test for the zero-premium-counted-as-sold bug: a positive
// keyword alone (e.g. "Sale") must no longer be enough to mark a row
// sold — a real premium is required too, matching the user's own
// "zero-premium terminations must not count as sold production" rule.
test('classifyIsSold: a positive keyword with $0/null premium is never sold (the fix)', () => {
  assert.equal(classifyIsSold('Sale', 0), false);
  assert.equal(classifyIsSold('Sale', null), false);
  assert.equal(classifyIsSold('Issued', 0), false);
});

test('classifyIsSold: existing behavior is unchanged — a real premium still counts, a termination never does', () => {
  assert.equal(classifyIsSold('Sale', 50000), true);
  assert.equal(classifyIsSold('Terminated', 50000), false);
  assert.equal(classifyIsSold(null, 10000), true, 'no outcome column at all still falls through to the premium-floor rule');
  assert.equal(classifyIsSold(null, 0), false);
});

test('a $0-premium row imported with a positive-keyword outcome is excluded end-to-end (import + every aggregate consumer)', async () => {
  const csv = [
    'Date,Name,Product,Premium,Outcome',
    `2024-07-01,Zero Premium Guy ${suffix},Auto,0,Sale`,
  ].join('\n');
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'zero-premium.csv');
  form.append('sourceSystem', 'OTHER');
  const res = await fetch(`${baseUrl}/api/leads/historical-data-import`, { method: 'POST', headers: { Cookie: ownerCookie }, body: form });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, 1);

  const [record] = await prisma.historicalRecord.findMany({ where: { importBatchId: body.batchId } });
  assert.equal(record.isSold, false, 'the import-time classifier must not mark a $0 "Sale" row as sold');

  await fetch(`${baseUrl}/api/leads/import-batches/${body.batchId}/undo`, { method: 'POST', headers: { Cookie: ownerCookie } });
});

test('historicalAggregates read-time guard: a pre-existing bad row (isSold:true, premiumCents:0) is excluded from every consumer, not just future imports', async () => {
  const batch = await prisma.leadImportBatch.create({
    data: { agencyId, uploadedById: ownerId, isHistorical: true, totalRows: 1, created: 1, skipped: 0 },
  });
  const badRecord = await prisma.historicalRecord.create({
    data: {
      agencyId,
      importBatchId: batch.id,
      recordDate: new Date('2024-08-01'),
      firstName: 'Legacy', lastName: 'BadRow',
      premiumCents: 0,
      isSold: true, // simulates a row imported before the classifyIsSold fix shipped
      product: 'AUTO',
      sourceSystem: 'OTHER',
    },
  });

  const from = new Date('2024-07-01');
  const to = new Date('2024-09-01');
  assert.equal(await sumHistoricalPremium({ agencyId, from, to }), 0, 'the bad row contributes nothing to the premium sum');
  assert.equal(await countHistoricalSold({ agencyId, from, to }), 0, 'the bad row is not counted as sold');
  const rows = await historicalLeadLikeRows({ agencyId, from, to });
  assert.equal(rows.length, 0, 'the bad row never reaches Billboard via historicalLeadLikeRows');

  await prisma.historicalRecord.delete({ where: { id: badRecord.id } });
  await prisma.leadImportBatch.delete({ where: { id: batch.id } });
});

// Item 4 of the production-correction round: Billboard must count policy
// ITEMS, not rows — this is the import-time half (a recognized items
// column populates items/itemsSource:'explicit'; an absent one leaves
// items:null, never silently defaulted to 1).
let itemsBatchId;

function itemsCsv() {
  const header = 'Date,First Name,Last Name,Product,Premium,Items\n';
  const rows = [
    `2024-06-05,Multi,Item,Auto,500,3`,
    // no Items value for this row — items must stay null, never default to 1.
    `2024-06-06,No,Items,Auto,400,`,
  ];
  return new Blob([header + rows.join('\n')], { type: 'text/csv' });
}

test('a recognized Items column populates items/itemsSource:explicit; an absent value stays null, never defaulted to 1', async () => {
  const form = new FormData();
  form.append('file', itemsCsv(), 'items.csv');
  form.append('sourceSystem', 'OTHER');
  const res = await fetch(`${baseUrl}/api/leads/historical-data-import`, { method: 'POST', headers: { Cookie: ownerCookie }, body: form });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, 2);
  itemsBatchId = body.batchId;

  const records = await prisma.historicalRecord.findMany({ where: { importBatchId: itemsBatchId }, orderBy: { recordDate: 'asc' } });
  const withItems = records.find((r) => r.lastName === 'Item');
  assert.equal(withItems.items, 3);
  assert.equal(withItems.itemsSource, 'explicit');

  const withoutItems = records.find((r) => r.lastName === 'Items');
  assert.equal(withoutItems.items, null, 'a blank Items cell must never be guessed/defaulted to 1');
  assert.equal(withoutItems.itemsSource, null);

  await fetch(`${baseUrl}/api/leads/import-batches/${itemsBatchId}/undo`, { method: 'POST', headers: { Cookie: ownerCookie } });
});
