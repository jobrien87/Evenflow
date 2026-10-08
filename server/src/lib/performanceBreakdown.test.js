// Real-database integration test (matches this app's own testing
// philosophy: no mocked Prisma for logic that IS a database query).
// Run with a real DATABASE_URL, same as agencyChat.test.js:
//   DATABASE_URL=postgresql://... node --test src/lib/performanceBreakdown.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { computeVendorBreakdown, computeProductBreakdown, computeTelemarketerPerformance } = require('./performanceBreakdown');

const suffix = Date.now();
const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
const to = new Date(Date.now() + 24 * 60 * 60 * 1000);

let agencyId;
let producer1Id;
let producer2Id;
let vendorAId;
let vendorBId;
let tmId;
let assignmentId;
let customerIds = [];
let leadIds = [];

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Perf Test Agency ${suffix}` } });
  agencyId = agency.id;

  const p1 = await prisma.user.create({
    data: { email: `perf-p1-${suffix}@test.local`, firstName: 'Perf', lastName: 'One', role: 'PRODUCER', status: 'ACTIVE', agencyId },
  });
  producer1Id = p1.id;
  const p2 = await prisma.user.create({
    data: { email: `perf-p2-${suffix}@test.local`, firstName: 'Perf', lastName: 'Two', role: 'PRODUCER', status: 'ACTIVE', agencyId },
  });
  producer2Id = p2.id;

  const vendorA = await prisma.vendor.create({ data: { name: 'Perf Vendor A', email: 'va@test.local', agencyId, product: 'Auto' } });
  vendorAId = vendorA.id;
  const vendorB = await prisma.vendor.create({ data: { name: 'Perf Vendor B', email: 'vb@test.local', agencyId, product: 'Home' } });
  vendorBId = vendorB.id;

  const tm = await prisma.user.create({
    data: { email: `perf-tm-${suffix}@test.local`, firstName: 'Perf', lastName: 'TM', role: 'TELEMARKETER', status: 'ACTIVE' },
  });
  tmId = tm.id;
  const assignment = await prisma.telemarketerAssignment.create({ data: { telemarketerId: tmId, agencyId, status: 'ACTIVE' } });
  assignmentId = assignment.id;

  async function makeCustomer() {
    const c = await prisma.customer.create({ data: { firstName: 'Perf', lastName: `Cust${customerIds.length}` } });
    customerIds.push(c.id);
    return c;
  }

  // producer1: 2 leads from vendorA (1 SOLD w/ contact+attempt, 1 untouched NEW), 1 from vendorB (QUOTED)
  const c1 = await makeCustomer();
  const lead1 = await prisma.lead.create({
    data: {
      agencyId, customerId: c1.id, vendorId: vendorAId, assignedToId: producer1Id, product: 'Auto',
      status: 'SOLD', firstAttemptAt: new Date(), firstContactAt: new Date(),
    },
  });
  const c2 = await makeCustomer();
  const lead2 = await prisma.lead.create({
    data: { agencyId, customerId: c2.id, vendorId: vendorAId, assignedToId: producer1Id, product: 'Auto', status: 'NEW' },
  });
  const c3 = await makeCustomer();
  const lead3 = await prisma.lead.create({
    data: {
      agencyId, customerId: c3.id, vendorId: vendorBId, assignedToId: producer1Id, product: 'Home',
      status: 'QUOTED', firstAttemptAt: new Date(), firstContactAt: new Date(),
    },
  });

  // producer2: 1 lead from vendorA — must never count toward producer1's breakdown.
  const c4 = await makeCustomer();
  const lead4 = await prisma.lead.create({
    data: { agencyId, customerId: c4.id, vendorId: vendorAId, assignedToId: producer2Id, product: 'Auto', status: 'NEW' },
  });

  // TM-sourced leads: 2 submitted, 1 SOLD.
  const c5 = await makeCustomer();
  const lead5 = await prisma.lead.create({
    data: { agencyId, customerId: c5.id, source: 'telemarketer', createdById: tmId, product: 'Auto', status: 'SOLD' },
  });
  const c6 = await makeCustomer();
  const lead6 = await prisma.lead.create({
    data: { agencyId, customerId: c6.id, source: 'telemarketer', createdById: tmId, product: 'Auto', status: 'NEW' },
  });

  leadIds = [lead1.id, lead2.id, lead3.id, lead4.id, lead5.id, lead6.id];
});

after(async () => {
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  await prisma.telemarketerAssignment.deleteMany({ where: { id: assignmentId } });
  await prisma.vendor.deleteMany({ where: { agencyId } });
  await prisma.user.deleteMany({ where: { id: { in: [producer1Id, producer2Id, tmId] } } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await prisma.$disconnect();
});

test('computeVendorBreakdown scopes to one producer and excludes another producer\'s leads', async () => {
  const rows = await computeVendorBreakdown({ agencyId, userId: producer1Id, from, to });
  assert.equal(rows.length, 2, 'expected exactly vendor A and vendor B for producer1');

  const vendorA = rows.find((r) => r.vendorId === vendorAId);
  assert.equal(vendorA.totalLeads, 2);
  assert.equal(vendorA.untouched, 1, 'one of producer1\'s two vendorA leads has no firstAttemptAt');
  assert.equal(vendorA.closeRate, 50, '1 of 2 leads SOLD');

  const vendorB = rows.find((r) => r.vendorId === vendorBId);
  assert.equal(vendorB.totalLeads, 1);
  assert.equal(vendorB.untouched, 0);
});

test('computeVendorBreakdown omits a vendor with zero leads for this scope', async () => {
  const rows = await computeVendorBreakdown({ agencyId, userId: producer2Id, from, to });
  assert.equal(rows.length, 1, 'producer2 only ever touched vendorA, vendorB must be omitted, not shown as a zero row');
  assert.equal(rows[0].vendorId, vendorAId);
});

test('computeProductBreakdown groups producer1\'s leads by product', async () => {
  const rows = await computeProductBreakdown({ agencyId, userId: producer1Id, from, to });
  const auto = rows.find((r) => r.product === 'Auto');
  const home = rows.find((r) => r.product === 'Home');
  assert.equal(auto.totalLeads, 2);
  // A live Lead reaching SOLD is a pipeline disposition only now, never a
  // production/revenue count — salesCount only ever comes from Historical
  // Data/Add Closed Sale rows, of which this fixture has none.
  assert.equal(auto.salesCount, 0);
  assert.equal(auto.closeRate, 50, 'closeRate stays a pipeline-conversion rate, unaffected by the salesCount change');
  assert.equal(home.totalLeads, 1);
  assert.equal(home.salesCount, 0);
});

test('computeTelemarketerPerformance reports real submitted/sold counts for the agency\'s active TM roster', async () => {
  const rows = await computeTelemarketerPerformance({ agencyId, from, to });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].telemarketerId, tmId);
  assert.equal(rows[0].leadsSubmitted, 2);
  assert.equal(rows[0].soldCount, 1);
  assert.equal(rows[0].soldRate, 50);
});
