// Real-database integration test (matches this app's own testing
// philosophy: no mocked Prisma for logic that IS a database query), plus
// pure unit tests for the date-bucketing helpers.
//   DATABASE_URL=postgresql://... node --test src/lib/billboard.test.js

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { computeBillboard, bucketStart, buildSeries } = require('./billboard');

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
