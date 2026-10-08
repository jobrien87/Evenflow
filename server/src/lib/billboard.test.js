// Real-database integration test (matches this app's own testing
// philosophy: no mocked Prisma for logic that IS a database query), plus
// pure unit tests for the date-bucketing helpers.
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
let producerAId;
let producerBId;
let producerCId;
let vendorId;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Billboard Test Agency ${suffix}` } });
  agencyId = agency.id;

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

  async function makeSoldLead(assignedToId, product, premiumCents, extra = {}) {
    const customer = await prisma.customer.create({ data: { firstName: 'Billboard', lastName: 'Cust' } });
    return prisma.lead.create({
      data: { agencyId, customerId: customer.id, assignedToId, status: 'SOLD', saleProduct: product, salePremiumCents: premiumCents, ...extra },
    });
  }

  // Producer A: 2 Auto sales ($100 + $200), one vendor-sourced w/ zip, one
  // direct/no-vendor w/ no zip. Producer B: 1 Home sale ($300), direct.
  await makeSoldLead(producerAId, 'AUTO', 10000, { vendorId, zip: '90210' });
  await makeSoldLead(producerAId, 'AUTO', 20000);
  await makeSoldLead(producerBId, 'HOME', 30000);

  // A zero-premium and a null-premium SOLD lead — must never count toward
  // soldCount/premiumCents anywhere, regardless of status.
  await makeSoldLead(producerBId, 'HOME', 0);
  await makeSoldLead(producerBId, 'HOME', null);
});

test('computeBillboard: aggregates real sold leads by producer and by product', async () => {
  const result = await computeBillboard({ agencyId, granularity: 'month' });

  assert.equal(result.totals.soldCount, 3);
  assert.equal(result.totals.premiumCents, 60000);

  const rowA = result.byProducer.find((r) => r.userId === producerAId);
  assert.equal(rowA.soldCount, 2);
  assert.equal(rowA.premiumCents, 30000);

  const rowB = result.byProducer.find((r) => r.userId === producerBId);
  assert.equal(rowB.soldCount, 1);
  assert.equal(rowB.premiumCents, 30000);

  // Sorted by premium descending — A and B are tied with producers'
  // relative product totals, so check product rows directly instead.
  const auto = result.byProduct.find((p) => p.product === 'AUTO');
  assert.equal(auto.soldCount, 2);
  assert.equal(auto.premiumCents, 30000);

  const home = result.byProduct.find((p) => p.product === 'HOME');
  assert.equal(home.soldCount, 1);
  assert.equal(home.premiumCents, 30000);

  const vendorRow = result.byVendor.find((v) => v.vendorId === vendorId);
  assert.equal(vendorRow.soldCount, 1);
  assert.equal(vendorRow.premiumCents, 10000);

  const directRow = result.byVendor.find((v) => v.vendorId === null);
  assert.equal(directRow.vendorName, 'Direct / No Vendor');
  assert.equal(directRow.soldCount, 2);
  assert.equal(directRow.premiumCents, 50000);

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
let periodProducerId;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Billboard Period Test Agency ${suffix}`, timezone: 'America/New_York' } });
  periodAgencyId = agency.id;
  const producer = await prisma.user.create({
    data: { agencyId: periodAgencyId, email: `billboard-period-${suffix}@test.local`, passwordHash: 'x', firstName: 'Per', lastName: 'Iod', role: 'PRODUCER', status: 'ACTIVE' },
  });
  periodProducerId = producer.id;

  async function makeSoldLeadAt(premiumCents, updatedAt) {
    const customer = await prisma.customer.create({ data: { firstName: 'Period', lastName: 'Cust' } });
    return prisma.lead.create({
      data: { agencyId: periodAgencyId, customerId: customer.id, assignedToId: periodProducerId, status: 'SOLD', saleProduct: 'AUTO', salePremiumCents: premiumCents, updatedAt },
    });
  }

  // One sale inside the completed Mon-Fri week (Wed Sep 30, Eastern), one
  // the Saturday right after it (must NOT count toward the week view),
  // one earlier in the same month (Sep 10), one in a different month of
  // the same year (Aug 5), and one in a prior year (2025).
  await makeSoldLeadAt(5000, new Date('2026-09-30T18:00:00Z')); // Wed Sep 30 2026, 14:00 EDT — inside the completed week
  await makeSoldLeadAt(7000, new Date('2026-10-03T18:00:00Z')); // Sat Oct 3 2026 — the following Saturday, excluded from the week
  await makeSoldLeadAt(3000, new Date('2026-09-10T18:00:00Z')); // same month (September), outside the week
  await makeSoldLeadAt(4000, new Date('2026-08-05T18:00:00Z')); // same year, different month (August)
  await makeSoldLeadAt(2000, new Date('2025-11-20T18:00:00Z')); // prior year
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

test('computeBillboardPeriod: zero-premium SOLD leads never count toward any period\'s totals', async () => {
  const customer = await prisma.customer.create({ data: { firstName: 'Zero', lastName: 'Premium' } });
  await prisma.lead.create({
    data: { agencyId: periodAgencyId, customerId: customer.id, assignedToId: periodProducerId, status: 'SOLD', saleProduct: 'AUTO', salePremiumCents: 0, updatedAt: new Date('2026-09-30T18:00:00Z') },
  });
  const result = await computeBillboardPeriod({ agencyId: periodAgencyId, period: 'week', now: PERIOD_NOW });
  assert.equal(result.totals.soldCount, 1, 'the new $0 lead must not inflate the week total');
  assert.equal(result.totals.premiumCents, 5000);
});
