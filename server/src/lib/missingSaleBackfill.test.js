// Real-database test for the automatic SOLD-without-Sale backfill —
//   DATABASE_URL=postgresql://... node --test src/lib/missingSaleBackfill.test.js
//
// Scoped to its own dedicated agency via backfillMissingSales({ agencyId })
// (not the platform-wide call index.js makes) so this never touches any
// other test file's in-flight SOLD leads in the same shared CI database.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { backfillMissingSales } = require('./missingSaleBackfill');

const suffix = Date.now();
let agencyId, producerId, ownerId;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Backfill Test Agency ${suffix}` } });
  agencyId = agency.id;
  const hash = 'x';
  const owner = await prisma.user.create({
    data: { email: `backfill-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Backfill', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const producer = await prisma.user.create({
    data: { email: `backfill-producer-${suffix}@test.local`, passwordHash: hash, firstName: 'Backfill', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerId = producer.id;
});

after(async () => {
  await prisma.revenueEvent.deleteMany({ where: { agencyId } });
  await prisma.sale.deleteMany({ where: { agencyId } });
  await prisma.leadProductQuote.deleteMany({ where: { lead: { agencyId } } });
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.user.deleteMany({ where: { agencyId } });
  await prisma.agency.delete({ where: { id: agencyId } });
});

async function makeSoldLead(overrides = {}) {
  const customer = await prisma.customer.create({ data: { firstName: 'Backfill', lastName: `Lead${Date.now()}${Math.random()}` } });
  return prisma.lead.create({
    data: {
      agencyId, customerId: customer.id, status: 'SOLD', assignedToId: producerId,
      receivedAt: new Date(), assignedAt: new Date(),
      ...overrides,
    },
  });
}

test('backfillMissingSales: a SOLD lead with real captured carrier/policyType/product/premium gets a real Sale, no placeholder needed', async () => {
  const lead = await makeSoldLead({
    saleCarrier: 'Progressive', salePolicyTypeDetail: 'Auto-Preferred', saleProduct: 'AUTO', salePremiumCents: 125000,
  });

  const result = await backfillMissingSales({ agencyId });
  assert.equal(result.backfilled, 1);

  const sale = await prisma.sale.findFirst({ where: { leadId: lead.id } });
  assert.ok(sale, 'a real Sale must be created for this lead');
  assert.equal(sale.carrier, 'Progressive');
  assert.equal(sale.policyType, 'Auto-Preferred');
  assert.equal(sale.productFamily, 'AUTO');
  assert.equal(sale.premiumCents, 125000);
  assert.equal(sale.assignedToId, producerId);
  assert.equal(sale.voidedAt, null);
});

test('backfillMissingSales: a legacy SOLD lead with no real carrier/policyType/product/premium anywhere gets backfilled with Unknown placeholders and a null premium, never a fabricated dollar amount', async () => {
  const lead = await makeSoldLead({});

  const result = await backfillMissingSales({ agencyId });
  assert.ok(result.backfilled >= 1);

  const sale = await prisma.sale.findFirst({ where: { leadId: lead.id } });
  assert.ok(sale, 'a Sale must still be created so this lead counts as sold production');
  assert.equal(sale.carrier, 'Unknown');
  assert.equal(sale.policyType, 'Unknown');
  assert.equal(sale.productFamily, 'Unknown');
  assert.equal(sale.premiumCents, null, 'premium is never fabricated — stays null when never entered');
});

test('backfillMissingSales: a SOLD lead that already has a real linked Sale is left alone, and a second run is a no-op', async () => {
  const lead = await makeSoldLead({ saleCarrier: 'Allstate', salePolicyTypeDetail: 'Standard', saleProduct: 'HOME', salePremiumCents: 90000 });
  const existingSale = await prisma.sale.create({
    data: {
      agencyId, customerId: lead.customerId, leadId: lead.id, firstName: 'Already', lastName: 'Logged',
      saleDate: new Date(), carrier: 'Allstate', policyType: 'Standard', productFamily: 'HOME', premiumCents: 90000,
      assignedToId: producerId, createdById: ownerId, clientRequestId: `already-logged-${lead.id}`,
    },
  });

  await backfillMissingSales({ agencyId });

  const sales = await prisma.sale.findMany({ where: { leadId: lead.id } });
  assert.equal(sales.length, 1, 'a lead that already has a real Sale must never get a second one');
  assert.equal(sales[0].id, existingSale.id);

  // Full idempotency check across everything created in this test file so
  // far — a second complete run must create nothing new.
  const countBefore = await prisma.sale.count({ where: { agencyId } });
  await backfillMissingSales({ agencyId });
  const countAfter = await prisma.sale.count({ where: { agencyId } });
  assert.equal(countAfter, countBefore, 'a second run must be a true no-op once the backlog is closed');
});

test('backfillMissingSales: a SOLD lead with 2 SOLD product quotes gets a Sale with items=2, not the bare default of 1', async () => {
  const lead = await makeSoldLead({});
  await prisma.leadProductQuote.create({ data: { leadId: lead.id, product: 'AUTO', status: 'SOLD' } });
  await prisma.leadProductQuote.create({ data: { leadId: lead.id, product: 'HOME', status: 'SOLD' } });

  await backfillMissingSales({ agencyId });

  const sale = await prisma.sale.findFirst({ where: { leadId: lead.id } });
  assert.ok(sale, 'a Sale must be created for this lead');
  assert.equal(sale.items, 2, 'items must reflect the real count of SOLD product quotes, not default to 1');
});
