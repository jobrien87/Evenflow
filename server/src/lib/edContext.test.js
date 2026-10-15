// Real-database integration test for edContext.js's Sale-based "new
// sales"/"open leads" fixes —
//   DATABASE_URL=postgresql://... node --test src/lib/edContext.test.js
//
// Covers: buildBriefingContext's newSales (both PRODUCER and
// AGENCY_OWNER branches) counts real Sale/HistoricalRecord production,
// never a Lead-disposition-to-SOLD event (a Lead reaching SOLD posts no
// credit on its own); buildProducerContext/buildAgencyOwnerContext's
// openLeads includes every active status (LEFT_VM/APPOINTMENT/
// QUOTED_HOT), not just the old hand-rolled subset.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { buildBriefingContext, buildProducerContext, buildAgencyOwnerContext } = require('./edContext');

const suffix = Date.now();
let agencyId, producerId, producerUser;
let leadIds = [];
let saleIds = [];
let customerIds = [];

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Ed Context Test Agency ${suffix}` } });
  agencyId = agency.id;
  const producer = await prisma.user.create({
    data: { email: `edctx-producer-${suffix}@test.local`, firstName: 'Ed', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerId = producer.id;
  producerUser = producer;
});

after(async () => {
  await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
  await prisma.revenueEvent.deleteMany({ where: { saleId: { in: saleIds } } });
  await prisma.leadEvent.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  await prisma.user.delete({ where: { id: producerId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await prisma.$disconnect();
});

test('buildBriefingContext (PRODUCER): newSales counts a real Sale, never a bare Lead-SOLD disposition event', async () => {
  // A Lead dispositioned SOLD with no real Sale record ever created for
  // it (the post-disposition nudge was dismissed) -- must contribute 0.
  const customer1 = await prisma.customer.create({ data: { firstName: 'Ed', lastName: `NoRealSale${suffix}` } });
  customerIds.push(customer1.id);
  const lead1 = await prisma.lead.create({ data: { agencyId, customerId: customer1.id, assignedToId: producerId, status: 'SOLD' } });
  leadIds.push(lead1.id);
  await prisma.leadEvent.create({ data: { leadId: lead1.id, type: 'lead.disposition', toStatus: 'SOLD' } });

  const beforeReal = await buildBriefingContext(producerUser);
  assert.equal(beforeReal.newSales, 0, 'a bare Lead-SOLD disposition with no real Sale must not count');

  // A real standalone Sale -- this is what must count.
  const customer2 = await prisma.customer.create({ data: { firstName: 'Ed', lastName: `RealSale${suffix}` } });
  customerIds.push(customer2.id);
  const sale = await prisma.sale.create({
    data: {
      agencyId, customerId: customer2.id, firstName: 'Ed', lastName: `RealSale${suffix}`,
      saleDate: new Date(), carrier: 'Allstate', policyType: 'Auto-Standard', productFamily: 'AUTO',
      premiumCents: 50000, assignedToId: producerId, createdById: producerId,
    },
  });
  saleIds.push(sale.id);

  const afterReal = await buildBriefingContext(producerUser);
  assert.equal(afterReal.newSales, 1, 'the one real Sale must count exactly once');
});

test('buildBriefingContext (AGENCY_OWNER): newSales is agency-wide and also Sale-based, never a disposition-event count', async () => {
  const owner = await prisma.user.create({
    data: { email: `edctx-owner-${suffix}@test.local`, firstName: 'Ed', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  try {
    const result = await buildBriefingContext(owner);
    assert.equal(result.newSales, 1, 'must reflect the same one real agency-wide Sale from the prior test, not the SOLD-disposition lead');
  } finally {
    await prisma.user.delete({ where: { id: owner.id } });
  }
});

test('buildProducerContext/buildAgencyOwnerContext: openLeads includes LEFT_VM/APPOINTMENT/QUOTED_HOT, not just a hand-rolled subset', async () => {
  const c = await prisma.customer.create({ data: { firstName: 'Ed', lastName: `HotQuote${suffix}` } });
  customerIds.push(c.id);
  const lead = await prisma.lead.create({ data: { agencyId, customerId: c.id, assignedToId: producerId, status: 'QUOTED_HOT' } });
  leadIds.push(lead.id);

  const producerCtx = await buildProducerContext(producerUser);
  assert.ok(producerCtx.openLeads >= 1, 'a QUOTED_HOT lead must count as an open lead for the producer');

  const agencyCtx = await buildAgencyOwnerContext(agencyId);
  assert.ok(agencyCtx.openLeads >= 1, 'a QUOTED_HOT lead must count as an open lead agency-wide too');
});
