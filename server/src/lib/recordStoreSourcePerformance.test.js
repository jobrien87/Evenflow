// Real-DB tests for per-source performance computation — real Lead rows
// (with recordStoreSourceCode/recordStoreSubscriptionId set, exactly as
// routes/boberdooDelivery.js writes them) and real Sale rows joined back
// by Sale.leadId, never a fabricated/estimated revenue number.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { computeSourcePerformance, MIN_SAMPLE_SIZE } = require('./recordStoreSourcePerformance');

const suffix = Date.now();
let agencyId, customerId, userId, templateId, subscriptionId;
const leadIds = [];
const saleIds = [];

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Source Perf Test Agency ${suffix}` } });
  agencyId = agency.id;
  const bcrypt = require('bcryptjs');
  const user = await prisma.user.create({
    data: { email: `perf-user-${suffix}@test.local`, passwordHash: await bcrypt.hash('TestPass123!', 12), firstName: 'Perf', lastName: 'Agent', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  userId = user.id;
  const customer = await prisma.customer.create({ data: { firstName: 'Perf', lastName: 'Test', email: `perf-${suffix}@test.local` } });
  customerId = customer.id;

  const template = await prisma.recordStoreTemplate.create({
    data: { slug: `TEST_PERF_TEMPLATE_${suffix}`, displayName: 'Test Perf Template', productCategory: 'AUTO', leadType: 'INTERNET' },
  });
  templateId = template.id;

  const subscription = await prisma.recordStoreSubscription.create({
    data: {
      agencyId, recordStoreTemplateId: templateId, productNameSnapshot: 'Test Perf Template',
      leadType: 'INTERNET', filterSetType: 'STANDARD', priceSnapshotCents: 500, dailyVolume: 20,
      status: 'ACTIVE',
    },
  });
  subscriptionId = subscription.id;
});

after(async () => {
  await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
  await prisma.leadEvent.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.recordStoreSubscription.delete({ where: { id: subscriptionId } });
  await prisma.recordStoreTemplate.delete({ where: { id: templateId } });
  await prisma.customer.delete({ where: { id: customerId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await prisma.$disconnect();
});

async function makeLead({ sourceCode, status, sold }) {
  const lead = await prisma.lead.create({
    data: {
      agencyId, customerId, source: 'record_store:boberdoo', product: 'Auto', status: status || 'NEW',
      leadType: 'DATA_LEAD', recordStoreSourceCode: sourceCode, recordStoreSubscriptionId: subscriptionId,
    },
  });
  leadIds.push(lead.id);
  if (sold) {
    const sale = await prisma.sale.create({
      data: {
        agencyId, customerId, leadId: lead.id, firstName: 'Perf', lastName: 'Test', saleDate: new Date(),
        premiumCents: 10000, productFamily: 'Auto', carrier: 'Test Carrier', policyType: 'Standard',
        assignedToId: userId, createdById: userId,
      },
    });
    saleIds.push(sale.id);
  }
  return lead;
}

test('computes real per-source leadCount/quoteRate/closeRate/cost/revenue from actual Lead + Sale rows', async () => {
  // Source A: 3 leads, 1 sold (10000 cents revenue).
  await makeLead({ sourceCode: 'test-perf-a', status: 'QUOTED' });
  await makeLead({ sourceCode: 'test-perf-a', status: 'SOLD', sold: true });
  await makeLead({ sourceCode: 'test-perf-a', status: 'NEW' });
  // Source B: 2 leads, 0 sold.
  await makeLead({ sourceCode: 'test-perf-b', status: 'NEW' });
  await makeLead({ sourceCode: 'test-perf-b', status: 'LOST' });

  const from = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 1000);
  const result = await computeSourcePerformance({ subscriptionId, from, to });

  assert.equal(result.totalLeads, 5);
  assert.equal(result.minimumSampleSize, MIN_SAMPLE_SIZE);

  const a = result.perSource.find((r) => r.sourceCode === 'test-perf-a');
  const b = result.perSource.find((r) => r.sourceCode === 'test-perf-b');
  assert.ok(a && b);

  assert.equal(a.leadCount, 3);
  assert.equal(a.quotedCount, 2); // QUOTED + SOLD both count as "quoted or beyond"
  assert.equal(a.soldCount, 1);
  assert.equal(a.revenueCents, 10000);
  assert.equal(a.costCents, 3 * 500);
  assert.equal(a.hasMinimumSample, false); // below MIN_SAMPLE_SIZE

  assert.equal(b.leadCount, 2);
  assert.equal(b.soldCount, 0);
  assert.equal(b.revenueCents, 0);

  // Sorted best-closeRate-first.
  assert.equal(result.perSource[0].sourceCode, 'test-perf-a');

  // Never shows the raw code as the only identifier — label is always present.
  assert.ok(a.label.startsWith('EvenFlow '));
});

test('a voided Sale never counts as revenue', async () => {
  const lead = await makeLead({ sourceCode: 'test-perf-voided', status: 'SOLD' });
  const sale = await prisma.sale.create({
    data: {
      agencyId, customerId, leadId: lead.id, firstName: 'Perf', lastName: 'Test', saleDate: new Date(),
      premiumCents: 50000, productFamily: 'Auto', carrier: 'Test Carrier', policyType: 'Standard',
      assignedToId: userId, createdById: userId, voidedAt: new Date(), voidReason: 'test void',
    },
  });
  saleIds.push(sale.id);

  const from = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 1000);
  const result = await computeSourcePerformance({ subscriptionId, from, to });
  const row = result.perSource.find((r) => r.sourceCode === 'test-perf-voided');
  assert.equal(row.revenueCents, 0);
  assert.equal(row.soldCount, 0);
});

test('returns null for a subscription that does not exist', async () => {
  const result = await computeSourcePerformance({ subscriptionId: '00000000-0000-0000-0000-000000000000', from: new Date(0), to: new Date() });
  assert.equal(result, null);
});
