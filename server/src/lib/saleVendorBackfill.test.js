// Real-database test for the automatic Sale.vendorId-from-Lead backfill —
//   DATABASE_URL=postgresql://... node --test src/lib/saleVendorBackfill.test.js
//
// Scoped to its own dedicated agency via backfillSaleVendorFromLead({ agencyId })
// (not the platform-wide call index.js makes) so this never touches any
// other test file's Sale rows in the same shared CI database.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { backfillSaleVendorFromLead } = require('./saleVendorBackfill');

const suffix = Date.now();
let agencyId, producerId, ownerId, vendorId, otherVendorId;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Sale Vendor Backfill Test Agency ${suffix}` } });
  agencyId = agency.id;
  const hash = 'x';
  const owner = await prisma.user.create({
    data: { email: `svb-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'SVB', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const producer = await prisma.user.create({
    data: { email: `svb-producer-${suffix}@test.local`, passwordHash: hash, firstName: 'SVB', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerId = producer.id;
  const vendor = await prisma.vendor.create({
    data: { agencyId, name: `SVB Vendor ${suffix}`, email: `svb-vendor-${suffix}@test.local`, product: 'AUTO' },
  });
  vendorId = vendor.id;
  const otherVendor = await prisma.vendor.create({
    data: { agencyId, name: `SVB Other Vendor ${suffix}`, email: `svb-other-vendor-${suffix}@test.local`, product: 'AUTO' },
  });
  otherVendorId = otherVendor.id;
});

after(async () => {
  await prisma.auditEvent.deleteMany({ where: { agencyId } });
  await prisma.sale.deleteMany({ where: { agencyId } });
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.vendor.deleteMany({ where: { agencyId } });
  await prisma.user.deleteMany({ where: { agencyId } });
  await prisma.agency.delete({ where: { id: agencyId } });
});

async function makeLeadAndSale({ leadVendorId = null, saleVendorId = undefined } = {}) {
  const customer = await prisma.customer.create({ data: { firstName: 'SVB', lastName: `Cust${Date.now()}${Math.random()}` } });
  const lead = await prisma.lead.create({
    data: { agencyId, customerId: customer.id, status: 'SOLD', assignedToId: producerId, vendorId: leadVendorId },
  });
  const sale = await prisma.sale.create({
    data: {
      agencyId, customerId: customer.id, leadId: lead.id, firstName: 'SVB', lastName: 'Cust',
      saleDate: new Date(), carrier: 'Test', policyType: 'Standard', productFamily: 'AUTO', premiumCents: 10000,
      assignedToId: producerId, createdById: ownerId, clientRequestId: `svb-${lead.id}`,
      ...(saleVendorId !== undefined ? { vendorId: saleVendorId } : {}),
    },
  });
  return { lead, sale };
}

test('backfillSaleVendorFromLead: a Sale with no vendorId of its own gets its linked Lead\'s vendorId copied onto it', async () => {
  const { sale } = await makeLeadAndSale({ leadVendorId: vendorId });

  const result = await backfillSaleVendorFromLead({ agencyId });
  assert.ok(result.backfilled >= 1);

  const updated = await prisma.sale.findUnique({ where: { id: sale.id } });
  assert.equal(updated.vendorId, vendorId);

  const audit = await prisma.auditEvent.findFirst({ where: { entityId: sale.id, action: 'sale.vendorBackfilled' } });
  assert.ok(audit, 'the backfill must leave an audit trail');
  assert.equal(audit.actorRole, 'SYSTEM');
});

test('backfillSaleVendorFromLead: a Sale that already has its own explicit vendorId is never overwritten', async () => {
  const { sale } = await makeLeadAndSale({ leadVendorId: otherVendorId, saleVendorId: vendorId });

  await backfillSaleVendorFromLead({ agencyId });

  const unchanged = await prisma.sale.findUnique({ where: { id: sale.id } });
  assert.equal(unchanged.vendorId, vendorId, 'the Sale\'s own explicit vendor must win over its Lead\'s, and must never be overwritten by the backfill');
});

test('backfillSaleVendorFromLead: a standalone sale (no Lead) and a Lead with no vendor are both left alone, and a second run is a true no-op', async () => {
  const standaloneCustomer = await prisma.customer.create({ data: { firstName: 'SVB', lastName: `Standalone${Date.now()}` } });
  const standaloneSale = await prisma.sale.create({
    data: {
      agencyId, customerId: standaloneCustomer.id, firstName: 'SVB', lastName: 'Standalone',
      saleDate: new Date(), carrier: 'Test', policyType: 'Standard', productFamily: 'AUTO', premiumCents: 10000,
      assignedToId: producerId, createdById: ownerId, clientRequestId: `svb-standalone-${Date.now()}`,
    },
  });
  const { sale: vendorlessLeadSale } = await makeLeadAndSale({ leadVendorId: null });

  await backfillSaleVendorFromLead({ agencyId });

  const standaloneAfter = await prisma.sale.findUnique({ where: { id: standaloneSale.id } });
  assert.equal(standaloneAfter.vendorId, null, 'a sale with no Lead at all has no vendor signal to recover — must stay null, never guessed');
  const vendorlessAfter = await prisma.sale.findUnique({ where: { id: vendorlessLeadSale.id } });
  assert.equal(vendorlessAfter.vendorId, null, 'a Lead with no vendor of its own has nothing to copy forward');

  // Full idempotency check across everything created in this test file so
  // far — a second complete run must change nothing.
  const before = await prisma.sale.findMany({ where: { agencyId }, select: { id: true, vendorId: true } });
  await backfillSaleVendorFromLead({ agencyId });
  const after = await prisma.sale.findMany({ where: { agencyId }, select: { id: true, vendorId: true } });
  assert.deepEqual(after.sort((a, b) => a.id.localeCompare(b.id)), before.sort((a, b) => a.id.localeCompare(b.id)), 'a second run once everything is already backfilled must be a true no-op');
});
