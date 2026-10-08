// Real-database integration test (matches this app's own testing
// philosophy: no mocked Prisma for logic that IS a database query), plus
// pure unit tests for the date-bucketing helpers.
//
// A Lead reaching SOLD status is a queue/pipeline disposition only now —
// it is never read here for production. The one real sale unit is a Sale
// row (Add Closed Sale) or a HistoricalRecord row, so every fixture below
// uses those instead of a live Lead with status:'SOLD'.
//   DATABASE_URL=postgresql://... node --test src/lib/billboard.test.js

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { computeBillboard, computeBillboardPeriod, bucketStart, buildSeries } = require('./billboard');

test('bucketStart: week bucket always starts on Monday', () => {
  // 2026-10-01 is a Thursday.
  const start = bucketStart(new Date('2026-10-01T12:00:00Z'), 'week');
  assert.equal(start.getUTCDay(), 1, 'bucket start must be Monday (day index 1)');
  assert.equal(start.toISOString().slice(0, 10), '2026-09-28');
});

test('bucketStart: month bucket truncates to the 1st', () => {
  const start = bucketStart(new Date('2026-10-15T12:00:00Z'), 'month');
  assert.equal(start.toISOString().slice(0, 10), '2026-10-01');
});

test('buildSeries: fills every bucket in range, including zero-sale buckets', () => {
  const from = new Date('2026-10-01T00:00:00Z');
  const to = new Date('2026-10-03T00:00:00Z');
  const soldLeads = [{ updatedAt: new Date('2026-10-01T10:00:00Z'), salePremiumCents: 10000 }];
  const series = buildSeries(soldLeads, 'day', from, to);
  assert.equal(series.length, 3, 'one bucket per day across the 3-day range');
  assert.equal(series[0].soldCount, 1);
  assert.equal(series[0].premiumCents, 10000);
  assert.equal(series[1].soldCount, 0, 'a day with no sales is zero, never omitted');
  assert.equal(series[2].soldCount, 0);
});

const suffix = Date.now();
let agencyId;
let ownerId;
let producerAId;
let producerBId;
let producerCId;
let vendorId;
let importBatchId;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Billboard Test Agency ${suffix}` } });
  agencyId = agency.id;

  const owner = await prisma.user.create({
    data: { agencyId, email: `billboard-owner-${suffix}@test.local`, passwordHash: 'x', firstName: 'Own', lastName: 'Er', role: 'AGENCY_OWNER', status: 'ACTIVE' },
  });
  ownerId = owner.id;

  const producerA = await prisma.user.create({
    data: { agencyId, email: `billboard-a-${suffix}@test.local`, passwordHash: 'x', firstName: 'Bea', lastName: 'Con', role: 'PRODUCER', status: 'ACTIVE' },
  });
  producerAId = producerA.id;
  const producerB = await prisma.user.create({
    data: { agencyId, email: `billboard-b-${suffix}@test.local`, passwordHash: 'x', firstName: 'Bo', lastName: 'Dur', role: 'PRODUCER', status: 'ACTIVE' },
  });
  producerBId = producerB.id;
  // No sales at all this range — must still appear on the leaderboard,
  // zero-filled, rather than being silently absent.
  const producerC = await prisma.user.create({
    data: { agencyId, email: `billboard-c-${suffix}@test.local`, passwordHash: 'x', firstName: 'Zig', lastName: 'Zane', role: 'PRODUCER', status: 'ACTIVE' },
  });
  producerCId = producerC.id;
  // Inactive — must NOT appear on the leaderboard.
  await prisma.user.create({
    data: { agencyId, email: `billboard-d-${suffix}@test.local`, passwordHash: 'x', firstName: 'De', lastName: 'Parted', role: 'PRODUCER', status: 'DEACTIVATED' },
  });

  const vendor = await prisma.vendor.create({
    data: { agencyId, name: `Billboard Test Vendor ${suffix}`, email: `vendor-${suffix}@test.local`, product: 'AUTO' },
  });
  vendorId = vendor.id;

  const batch = await prisma.leadImportBatch.create({
    data: { agencyId, uploadedById: ownerId, isHistorical: true, totalRows: 0, created: 0, skipped: 0 },
  });
  importBatchId = batch.id;

  // Vendor-sourced + zip-attributed sold row — HistoricalRecord is the only
  // source that carries a vendor/zip dimension (a standalone Sale never
  // has a vendor, by definition).
  async function makeHistoricalRecord(assignedToId, product, premiumCents, recordDate, extra = {}) {
    return prisma.historicalRecord.create({
      data: {
        agencyId, importBatchId, assignedToId, product, premiumCents, recordDate,
        isSold: true, sourceSystem: 'OTHER', ...extra,
      },
    });
  }

  // Direct/no-vendor sold row — Add Closed Sale (standalone).
  async function makeSale(assignedToId, productFamily, premiumCents, saleDate, items = 1) {
    const customer = await prisma.customer.create({ data: { firstName: 'Billboard', lastName: 'Cust' } });
    return prisma.sale.create({
      data: {
        agencyId, customerId: customer.id, firstName: 'Billboard', lastName: 'Cust',
        saleDate, carrier: 'Test Carrier', policyType: 'Standard', productFamily, premiumCents, items,
        assignedToId, createdById: ownerId,
      },
    });
  }

  const recordDate = new Date('2026-06-15');
  // Producer A: 2 Auto sales ($100 + $200, 3 + 1 items), one vendor-sourced
  // w/ zip (HistoricalRecord), one direct/no-vendor w/ no zip (Sale).
  // Producer B: 1 Home sale ($300, 2 items), direct (Sale).
  await makeHistoricalRecord(producerAId, 'AUTO', 10000, recordDate, { vendorId, zip: '90210', items: 3 });
  await makeSale(producerAId, 'AUTO', 20000, recordDate, 1);
  await makeSale(producerBId, 'HOME', 30000, recordDate, 2);

  // A zero-premium and a null-premium "sold" row from each source — must
  // never count toward soldCount/premiumCents/itemCount anywhere.
  await makeHistoricalRecord(producerBId, 'HOME', 0, recordDate);
  await makeHistoricalRecord(producerBId, 'HOME', null, recordDate);
  await makeSale(producerBId, 'HOME', 0, recordDate);
});

test('computeBillboard: aggregates real sold leads by producer and by product', async () => {
  const result = await computeBillboard({ agencyId, granularity: 'month', from: new Date('2026-06-01'), to: new Date('2026-07-01') });

  assert.equal(result.totals.soldCount, 3);
  assert.equal(result.totals.premiumCents, 60000);
  assert.equal(result.totals.itemCount, 3 + 1 + 2, 'items sum across all 3 real sold rows, never conflated with row count');
  assert.equal(result.totals.unknownItemsCount, 0, 'every row in this fixture has a known items figure');

  const rowA = result.byProducer.find((r) => r.userId === producerAId);
  assert.equal(rowA.soldCount, 2);
  assert.equal(rowA.premiumCents, 30000);
  assert.equal(rowA.itemCount, 4, '3 items (historical) + 1 item (sale)');

  const rowB = result.byProducer.find((r) => r.userId === producerBId);
  assert.equal(rowB.soldCount, 1);
  assert.equal(rowB.premiumCents, 30000);
  assert.equal(rowB.itemCount, 2);

  // Sorted by premium descending — A and B are tied with producers'
  // relative product totals, so check product rows directly instead.
  const auto = result.byProduct.find((p) => p.product === 'AUTO');
  assert.equal(auto.soldCount, 2);
  assert.equal(auto.premiumCents, 30000);
  assert.equal(auto.itemCount, 4);

  const home = result.byProduct.find((p) => p.product === 'HOME');
  assert.equal(home.soldCount, 1);
  assert.equal(home.premiumCents, 30000);
  assert.equal(home.itemCount, 2);

  const vendorRow = result.byVendor.find((v) => v.vendorId === vendorId);
  assert.equal(vendorRow.soldCount, 1);
  assert.equal(vendorRow.premiumCents, 10000);
  assert.equal(vendorRow.itemCount, 3);

  const directRow = result.byVendor.find((v) => v.vendorId === null);
  assert.equal(directRow.vendorName, 'Direct / No Vendor');
  assert.equal(directRow.soldCount, 2);
  assert.equal(directRow.premiumCents, 50000);
  assert.equal(directRow.itemCount, 3, '1 item (producer A sale) + 2 items (producer B sale)');

  const zipRow = result.byZip.find((z) => z.zip === '90210');
  assert.equal(zipRow.soldCount, 1);
  assert.equal(zipRow.premiumCents, 10000);

  const unknownZipRow = result.byZip.find((z) => z.zip === 'Unknown');
  assert.equal(unknownZipRow.soldCount, 2);
  assert.equal(unknownZipRow.premiumCents, 50000);

  // Every active producer must appear, zero-filled when they have no
  // sales in range — not just whoever happened to sell something.
  assert.equal(result.byProducer.length, 3, 'all 3 active producers must appear, including the one with zero sales');
  const rowC = result.byProducer.find((r) => r.userId === producerCId);
  assert.ok(rowC, 'a zero-activity active producer must still appear on the leaderboard');
  assert.equal(rowC.soldCount, 0);
  assert.equal(rowC.premiumCents, 0);
  assert.equal(rowC.itemCount, 0);
  assert.equal(rowC.firstName, 'Zig');
  assert.equal(rowC.lastName, 'Zane');
  // Zero-premium rows tie on the primary sort key, so they fall back to
  // an alphabetical-by-name tiebreak rather than arbitrary insertion order.
  assert.equal(result.byProducer[2].userId, producerCId, 'the sole zero-sale producer is last, after the two who sold something');
});

test('computeBillboard: an agency with no sales in range returns real zeros, not an error', async () => {
  const emptyAgency = await prisma.agency.create({ data: { name: `Billboard Empty Agency ${suffix}` } });
  const result = await computeBillboard({ agencyId: emptyAgency.id, granularity: 'day' });
  assert.equal(result.totals.soldCount, 0);
  assert.equal(result.totals.premiumCents, 0);
  assert.deepEqual(result.byProducer, []);
  assert.deepEqual(result.byProduct, []);
  assert.deepEqual(result.byVendor, []);
  assert.deepEqual(result.byZip, []);
  assert.ok(result.series.length > 0, 'series is still fully bucketed even with no data');
});

// computeBillboardPeriod — the new Eastern-time fixed-calendar period
// system (Week/Month/Year/All Years), using its own small dedicated
// fixture and an injected `now` so every assertion is fully
// deterministic regardless of when this test actually runs.
let periodAgencyId;
let periodOwnerId;
let periodProducerId;
let periodBatchId;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Billboard Period Test Agency ${suffix}`, timezone: 'America/New_York' } });
  periodAgencyId = agency.id;
  const owner = await prisma.user.create({
    data: { agencyId: periodAgencyId, email: `billboard-period-owner-${suffix}@test.local`, passwordHash: 'x', firstName: 'Per', lastName: 'Owner', role: 'AGENCY_OWNER', status: 'ACTIVE' },
  });
  periodOwnerId = owner.id;
  const producer = await prisma.user.create({
    data: { agencyId: periodAgencyId, email: `billboard-period-${suffix}@test.local`, passwordHash: 'x', firstName: 'Per', lastName: 'Iod', role: 'PRODUCER', status: 'ACTIVE' },
  });
  periodProducerId = producer.id;
  const batch = await prisma.leadImportBatch.create({
    data: { agencyId: periodAgencyId, uploadedById: periodOwnerId, isHistorical: true, totalRows: 0, created: 0, skipped: 0 },
  });
  periodBatchId = batch.id;

  // recordDate is a UTC-midnight-of-calendar-date value (see
  // historicalDataImport.js) — the real encoding this test's Eastern-
  // boundary fix (item 6a) protects against misreading.
  async function makeHistoricalRecordOn(premiumCents, recordDate) {
    return prisma.historicalRecord.create({
      data: {
        agencyId: periodAgencyId, importBatchId: periodBatchId, assignedToId: periodProducerId,
        product: 'AUTO', premiumCents, recordDate, isSold: true, sourceSystem: 'OTHER',
      },
    });
  }

  // One sale inside the completed Mon-Fri week (Wed Sep 30, Eastern), one
  // the Saturday right after it (must NOT count toward the week view),
  // one earlier in the same month (Sep 10), one in a different month of
  // the same year (Aug 5), and one in a prior year (2025).
  await makeHistoricalRecordOn(5000, new Date('2026-09-30'));
  await makeHistoricalRecordOn(7000, new Date('2026-10-03'));
  await makeHistoricalRecordOn(3000, new Date('2026-09-10'));
  await makeHistoricalRecordOn(4000, new Date('2026-08-05'));
  await makeHistoricalRecordOn(2000, new Date('2025-11-20'));
});

const PERIOD_NOW = new Date('2026-10-08T15:00:00Z'); // Thursday Oct 8 2026, matching the user's own worked example

test('computeBillboardPeriod: week resolves to the most recently completed Mon-Fri and excludes data outside it', async () => {
  const result = await computeBillboardPeriod({ agencyId: periodAgencyId, period: 'week', now: PERIOD_NOW });
  assert.equal(result.period, 'week');
  assert.equal(result.periodLabel, 'Sep 28 – Oct 2, 2026');
  assert.equal(result.totals.soldCount, 1, 'only the Sep 30 sale falls inside Sep 28 - Oct 2');
  assert.equal(result.totals.premiumCents, 5000);
  assert.equal(result.series.length, 5, 'one bucket per weekday Mon-Fri');
  const wed = result.series.find((p) => p.label.startsWith('Wed'));
  assert.equal(wed.soldCount, 1);
  assert.equal(wed.premiumCents, 5000);
});

test('computeBillboardPeriod: month defaults to the current Eastern month and shows only that month\'s total', async () => {
  const result = await computeBillboardPeriod({ agencyId: periodAgencyId, period: 'month', now: PERIOD_NOW });
  assert.equal(result.period, 'month');
  assert.equal(result.periodLabel, 'October 2026');
  assert.equal(result.selectedMonth.year, 2026);
  assert.equal(result.selectedMonth.month, 10);
  // Oct 3 (Sat) is the only October sale — Sep/Aug/2025 sales excluded.
  assert.equal(result.totals.soldCount, 1);
  assert.equal(result.totals.premiumCents, 7000);
  assert.equal(result.series.length, 0, 'month view has no trend series, only a single total');
  assert.ok(result.availableMonths.length >= 2, 'the selector includes at least this month and an earlier one with real data');
});

test('computeBillboardPeriod: an explicit past month can be selected and returns only that month\'s data', async () => {
  const result = await computeBillboardPeriod({ agencyId: periodAgencyId, period: 'month', month: '2026-09', now: PERIOD_NOW });
  assert.equal(result.periodLabel, 'September 2026');
  assert.equal(result.totals.soldCount, 2, 'both Sep 30 and Sep 10 fall in September');
  assert.equal(result.totals.premiumCents, 5000 + 3000);
});

test('computeBillboardPeriod: year defaults to the current Eastern year and breaks down by month Jan-Dec', async () => {
  const result = await computeBillboardPeriod({ agencyId: periodAgencyId, period: 'year', now: PERIOD_NOW });
  assert.equal(result.period, 'year');
  assert.equal(result.periodLabel, '2026');
  assert.equal(result.selectedYear, 2026);
  // Sep 30 + Oct 3 + Sep 10 + Aug 5 all fall in 2026; the 2025 sale is excluded.
  assert.equal(result.totals.soldCount, 4);
  assert.equal(result.totals.premiumCents, 5000 + 7000 + 3000 + 4000);
  assert.equal(result.series.length, 12, 'one bucket per month Jan-Dec');
  const aug = result.series.find((m) => m.label === 'Aug');
  assert.equal(aug.premiumCents, 4000);
  const sep = result.series.find((m) => m.label === 'Sep');
  assert.equal(sep.premiumCents, 5000 + 3000);
  const oct = result.series.find((m) => m.label === 'Oct');
  assert.equal(oct.premiumCents, 7000);
});

test('computeBillboardPeriod: all_years shows a separate zero-filled total for every year present in the data', async () => {
  const result = await computeBillboardPeriod({ agencyId: periodAgencyId, period: 'all_years', now: PERIOD_NOW });
  assert.equal(result.period, 'all_years');
  assert.equal(result.totals.soldCount, 5, 'every real sold row across every year');
  assert.equal(result.totals.premiumCents, 5000 + 7000 + 3000 + 4000 + 2000);
  const y2025 = result.series.find((y) => y.label === '2025');
  assert.equal(y2025.premiumCents, 2000);
  const y2026 = result.series.find((y) => y.label === '2026');
  assert.equal(y2026.premiumCents, 5000 + 7000 + 3000 + 4000);
});

test('computeBillboardPeriod: zero-premium SOLD rows never count toward any period\'s totals', async () => {
  await prisma.historicalRecord.create({
    data: {
      agencyId: periodAgencyId, importBatchId: periodBatchId, assignedToId: periodProducerId,
      product: 'AUTO', premiumCents: 0, recordDate: new Date('2026-09-30'), isSold: true, sourceSystem: 'OTHER',
    },
  });
  const result = await computeBillboardPeriod({ agencyId: periodAgencyId, period: 'week', now: PERIOD_NOW });
  assert.equal(result.totals.soldCount, 1, 'the new $0 row must not inflate the week total');
  assert.equal(result.totals.premiumCents, 5000);
});

test('computeBillboardPeriod: the Oct 8 15:17:58 UTC snapshot discrepancy is fixed — a UTC-midnight-encoded business date lands in the correct Eastern period, not the prior day', async () => {
  // Reproduces the user's own reported bug: a record whose business date
  // is Oct 1 (stored as 2026-10-01T00:00:00Z, per historicalDataImport.js's
  // UTC-midnight-of-calendar-date convention) must land inside October's
  // period, not be misread as belonging to September because Eastern Oct 1
  // 00:00 is actually 04:00Z.
  const customer = await prisma.customer.create({ data: { firstName: 'Snap', lastName: 'Shot' } });
  await prisma.sale.create({
    data: {
      agencyId: periodAgencyId, customerId: customer.id, firstName: 'Snap', lastName: 'Shot',
      saleDate: new Date('2026-10-01'), carrier: 'Test', policyType: 'Standard', productFamily: 'AUTO',
      premiumCents: 123456, assignedToId: periodProducerId, createdById: periodOwnerId,
    },
  });
  const result = await computeBillboardPeriod({ agencyId: periodAgencyId, period: 'month', month: '2026-10', now: PERIOD_NOW });
  assert.equal(result.totals.soldCount, 2, 'the Oct 1 sale plus the existing Oct 3 historical row');
  assert.equal(result.totals.premiumCents, 7000 + 123456, 'the Oct 1 sale premium must land inside October, not leak into September');
});
