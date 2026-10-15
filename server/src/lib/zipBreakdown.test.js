// Real-database integration test (matches this app's own testing
// philosophy: no mocked Prisma for logic that IS a database query).
// Run with a real DATABASE_URL, same as performanceBreakdown.test.js:
//   DATABASE_URL=postgresql://... node --test src/lib/zipBreakdown.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { computeZipBreakdown } = require('./zipBreakdown');

const suffix = Date.now();
const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
const to = new Date(Date.now() + 24 * 60 * 60 * 1000);

let agencyId;
let vendorAId;
let producerId;
let customerIds = [];
let leadIds = [];
let saleIds = [];
let costEventId;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Zip Test Agency ${suffix}` } });
  agencyId = agency.id;

  const vendorA = await prisma.vendor.create({ data: { name: 'Zip Vendor A', email: `zva-${suffix}@test.local`, agencyId, product: 'Auto' } });
  vendorAId = vendorA.id;

  const producer = await prisma.user.create({
    data: { email: `zip-producer-${suffix}@test.local`, passwordHash: 'x', firstName: 'Zip', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerId = producer.id;

  // Vendor A: 3 leads total in period ($3.00 in CostEvents -> $1.00/lead).
  const costEvent = await prisma.costEvent.create({
    data: { agencyId, vendorId: vendorAId, category: 'VENDOR_LEAD_COST', amountCents: 300, occurredAt: new Date() },
  });
  costEventId = costEvent.id;

  async function makeCustomer() {
    const c = await prisma.customer.create({ data: { firstName: 'Zip', lastName: `Cust${customerIds.length}` } });
    customerIds.push(c.id);
    return c;
  }

  // Real sold count/revenue now come exclusively from real Sale records,
  // never a live Lead's own salePremiumCents snapshot (see zipBreakdown.js's
  // own comment) -- each "sold" lead below gets a matching Sale row with
  // the same zip, standing in for the real Add-Closed-Sale entry a
  // producer would actually make after a SOLD disposition.
  async function makeSale(customer, zip, premiumCents) {
    const sale = await prisma.sale.create({
      data: {
        agencyId, customerId: customer.id, firstName: customer.firstName, lastName: customer.lastName,
        saleDate: new Date(), carrier: 'Allstate', policyType: 'Auto-Standard', productFamily: 'AUTO',
        premiumCents, zip, assignedToId: producerId, createdById: producerId,
      },
    });
    saleIds.push(sale.id);
    return sale;
  }

  // zip 10001: 2 vendor-A leads, one SOLD ($500 premium via a real Sale).
  const c1 = await makeCustomer();
  const lead1 = await prisma.lead.create({
    data: { agencyId, customerId: c1.id, vendorId: vendorAId, zip: '10001', product: 'Auto', status: 'SOLD' },
  });
  await makeSale(c1, '10001', 50000);
  const c2 = await makeCustomer();
  const lead2 = await prisma.lead.create({
    data: { agencyId, customerId: c2.id, vendorId: vendorAId, zip: '10001', product: 'Auto', status: 'NEW' },
  });

  // zip 10002: 1 vendor-A lead (QUOTED, no sale) + 1 manual/no-vendor lead (SOLD, $200 premium via a real Sale).
  const c3 = await makeCustomer();
  const lead3 = await prisma.lead.create({
    data: { agencyId, customerId: c3.id, vendorId: vendorAId, zip: '10002', product: 'Auto', status: 'QUOTED' },
  });
  const c4 = await makeCustomer();
  const lead4 = await prisma.lead.create({
    data: { agencyId, customerId: c4.id, zip: '10002', product: 'Auto', status: 'SOLD' },
  });
  await makeSale(c4, '10002', 20000);

  // No zip at all -> groups under 'Unspecified', no vendor -> no cost data.
  const c5 = await makeCustomer();
  const lead5 = await prisma.lead.create({
    data: { agencyId, customerId: c5.id, product: 'Auto', status: 'NEW' },
  });

  leadIds = [lead1.id, lead2.id, lead3.id, lead4.id, lead5.id];
});

after(async () => {
  await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
  await prisma.revenueEvent.deleteMany({ where: { saleId: { in: saleIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  await prisma.costEvent.delete({ where: { id: costEventId } });
  await prisma.user.delete({ where: { id: producerId } });
  await prisma.vendor.deleteMany({ where: { agencyId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await prisma.$disconnect();
});

test('computeZipBreakdown groups leads by zip and computes real counts/rates', async () => {
  const rows = await computeZipBreakdown({ agencyId, from, to });
  assert.equal(rows.length, 3, 'expected 10001, 10002, and Unspecified');

  const zip10001 = rows.find((r) => r.zip === '10001');
  assert.equal(zip10001.totalLeads, 2);
  assert.equal(zip10001.quotedCount, 1, 'only the SOLD lead counts as quoted-or-beyond');
  assert.equal(zip10001.soldCount, 1);
  assert.equal(zip10001.revenue, 500);

  const zip10002 = rows.find((r) => r.zip === '10002');
  assert.equal(zip10002.totalLeads, 2);
  assert.equal(zip10002.quotedCount, 2, 'the QUOTED vendor lead and the SOLD manual lead both count');
  assert.equal(zip10002.soldCount, 1);
  assert.equal(zip10002.revenue, 200);
});

test('computeZipBreakdown attributes real per-vendor cost to each zip, never a fabricated one', async () => {
  const rows = await computeZipBreakdown({ agencyId, from, to });

  // Vendor A had 3 leads agency-wide in period and $3.00 in CostEvents -> $1.00/lead.
  const zip10001 = rows.find((r) => r.zip === '10001');
  assert.equal(zip10001.totalCost, 2.0, 'both zip10001 leads came from vendor A at $1.00/lead');
  assert.equal(zip10001.costPerLead, 1.0);
  assert.equal(zip10001.cpa, 2.0, 'the one sale in this zip absorbs both leads worth of cost');

  const zip10002 = rows.find((r) => r.zip === '10002');
  assert.equal(zip10002.totalCost, 1.0, 'only the vendor-A lead in this zip has attributable cost, the manual lead contributes none');
  assert.equal(zip10002.costPerLead, 0.5);
  assert.equal(zip10002.cpa, 1.0);

  const unspecified = rows.find((r) => r.zip === 'Unspecified');
  assert.equal(unspecified.totalCost, null, 'a fully manual, no-vendor lead has no real cost data — never fabricated as 0 or a number');
  assert.equal(unspecified.costPerLead, null);
  assert.equal(unspecified.cpa, null);
});

test('computeZipBreakdown sorts by lead volume descending', async () => {
  const rows = await computeZipBreakdown({ agencyId, from, to });
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].totalLeads >= rows[i].totalLeads, 'rows must be sorted by totalLeads descending');
  }
});

test('a QUOTED_HOT lead counts toward quotedCount, same as QUOTED', async () => {
  const c = await prisma.customer.create({ data: { firstName: 'Zip', lastName: `HotQuote${suffix}` } });
  customerIds.push(c.id);
  const lead = await prisma.lead.create({
    data: { agencyId, customerId: c.id, vendorId: vendorAId, zip: '10003', product: 'Auto', status: 'QUOTED_HOT' },
  });
  leadIds.push(lead.id);

  const rows = await computeZipBreakdown({ agencyId, from, to });
  const zip10003 = rows.find((r) => r.zip === '10003');
  assert.ok(zip10003, 'the new zip must appear');
  assert.equal(zip10003.quotedCount, 1, 'QUOTED_HOT must count toward quotedCount, not be silently dropped');
});

test('revenue/soldCount never read a live Lead\'s own salePremiumCents snapshot, only real Sale/HistoricalRecord rows', async () => {
  const c = await prisma.customer.create({ data: { firstName: 'Zip', lastName: `NoRealSale${suffix}` } });
  customerIds.push(c.id);
  // A lead dispositioned SOLD with a salePremiumCents snapshot but NO real
  // Sale record created for it (the post-disposition "log as Closed Sale"
  // nudge was dismissed) -- this must contribute zero sold count/revenue.
  const lead = await prisma.lead.create({
    data: { agencyId, customerId: c.id, zip: '10004', product: 'Auto', status: 'SOLD', salePremiumCents: 99999 },
  });
  leadIds.push(lead.id);

  const rows = await computeZipBreakdown({ agencyId, from, to });
  const zip10004 = rows.find((r) => r.zip === '10004');
  assert.ok(zip10004, 'the new zip must appear (it still has a live lead)');
  assert.equal(zip10004.soldCount, 0, 'no real Sale record exists for this lead -- it must not count as sold');
  assert.equal(zip10004.revenue, 0, 'the Lead\'s own stale salePremiumCents must never be read as real revenue');
});
