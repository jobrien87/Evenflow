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

test('financials /summary includes historical premium/sold-count for the range, added to live', async () => {
  const qs = `from=${rangeFrom.toISOString()}&to=${rangeTo.toISOString()}&agencyId=${agencyId}`;
  const res = await fetch(`${baseUrl}/api/financials/summary?${qs}`, { headers: { Cookie: ownerCookie } });
  const body = await res.json();
  assert.equal(res.status, 200);
  // /summary's revenue comes from RevenueEvent rows, not Lead.salePremiumCents
  // directly — the seed lead was created pre-SOLD (not via the disposition
  // route), so it never produced a RevenueEvent and contributes $0 revenue
  // here (it still counts toward salesRecorded via the real Lead.count).
  // historical $500 + $300 (row 3 unsold, row 4 out of range excluded)
  assert.equal(body.revenue, (50000 + 30000) / 100);
  assert.equal(body.salesRecorded, 1 + 2);
  assert.equal(body.historicalRecordsIncluded, 2);
});

test('financials /by-vendor merges matched historical premium into Vendor A, and buckets the unmatched row separately', async () => {
  const qs = `from=${rangeFrom.toISOString()}&to=${rangeTo.toISOString()}&agencyId=${agencyId}`;
  const res = await fetch(`${baseUrl}/api/financials/by-vendor?${qs}`, { headers: { Cookie: ownerCookie } });
  const body = await res.json();
  const vendorARow = body.vendors.find((v) => v.vendorId === vendorAId);
  assert.ok(vendorARow);
  assert.equal(vendorARow.salesCount, 1 + 1, 'live sale + the matched historical row');
  assert.equal(vendorARow.revenue, (100000 + 50000) / 100);

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
  assert.equal(prodXRow.salesCount, 1 + 1);
  assert.equal(prodXRow.revenue, (100000 + 50000) / 100);

  const unattributedRow = body.agents.find((a) => a.userId === null);
  assert.ok(unattributedRow);
  assert.equal(unattributedRow.salesCount, 1);
  assert.equal(unattributedRow.revenue, 300);
});

test('computeBillboard merges historical sold rows into the same totals/byVendor/byProducer aggregation as live leads', async () => {
  const result = await computeBillboard({ agencyId, granularity: 'month', from: rangeFrom, to: rangeTo });
  assert.equal(result.totals.soldCount, 3);
  assert.equal(result.totals.premiumCents, 100000 + 50000 + 30000);

  const vendorARow = result.byVendor.find((v) => v.vendorId === vendorAId);
  assert.equal(vendorARow.soldCount, 2);
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
  assert.equal(autoRow.salesCount, 1 + 1, 'live sold + the matched historical Auto row');

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
