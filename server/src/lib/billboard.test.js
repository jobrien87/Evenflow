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

  async function makeSoldLead(assignedToId, product, premiumCents) {
    const customer = await prisma.customer.create({ data: { firstName: 'Billboard', lastName: 'Cust' } });
    return prisma.lead.create({
      data: { agencyId, customerId: customer.id, assignedToId, status: 'SOLD', saleProduct: product, salePremiumCents: premiumCents },
    });
  }

  // Producer A: 2 Auto sales ($100 + $200). Producer B: 1 Home sale ($300).
  await makeSoldLead(producerAId, 'AUTO', 10000);
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
});

test('computeBillboard: an agency with no sales in range returns real zeros, not an error', async () => {
  const emptyAgency = await prisma.agency.create({ data: { name: `Billboard Empty Agency ${suffix}` } });
  const result = await computeBillboard({ agencyId: emptyAgency.id, granularity: 'day' });
  assert.equal(result.totals.soldCount, 0);
  assert.equal(result.totals.premiumCents, 0);
  assert.deepEqual(result.byProducer, []);
  assert.deepEqual(result.byProduct, []);
  assert.ok(result.series.length > 0, 'series is still fully bucketed even with no data');
});
