// Real-DB, real-HTTP test for the Factory Reset feature (replaces the old
// temporary adminWipe.js): confirms the right rows for an agency are wiped
// (including revenue/cost events scoped directly by agencyId — the real
// gap the old route had, since it only ever scoped those by transferId),
// confirms Vendors/Offices/Goals/Users all survive untouched, and confirms
// the confirmText guard actually blocks a mismatched confirmation.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, ownerCookie, vendorId, officeId, customerId, leadId, server, baseUrl;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Factory Reset Test Agency ${suffix}` } });
  agencyId = agency.id;

  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `fr-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Reset', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const session = await createSession(ownerId);
  ownerCookie = `evenflow_session=${session.rawToken}`;

  const vendor = await prisma.vendor.create({
    data: { name: `FR Vendor ${suffix}`, email: `frvendor-${suffix}@test.local`, agencyId, product: 'Auto', status: 'LIVE' },
  });
  vendorId = vendor.id;

  const office = await prisma.office.create({ data: { agencyId, name: 'FR Office' } });
  officeId = office.id;

  const customer = await prisma.customer.create({ data: { firstName: 'Reset', lastName: 'Customer', phoneNormalized: `reset${suffix}` } });
  customerId = customer.id;

  const lead = await prisma.lead.create({
    data: { agencyId, customerId, source: 'manual', status: 'NEW', vendorId, product: 'Auto', createdById: ownerId },
  });
  leadId = lead.id;
  await prisma.leadNote.create({ data: { leadId, authorId: ownerId, content: 'test note' } });

  await prisma.goal.create({
    data: { agencyId, metric: 'sales', targetValue: 10, periodType: 'MONTHLY', periodStart: new Date('2024-01-01'), periodEnd: new Date('2024-01-31') },
  });

  // A manually-entered revenue ledger row — agencyId-scoped only, no
  // transferId at all. This is the exact case the old adminWipe.js missed.
  await prisma.revenueEvent.create({ data: { agencyId, category: 'OTHER', amountCents: 50000, createdById: ownerId } });
  await prisma.costEvent.create({ data: { agencyId, vendorId, category: 'VENDOR_LEAD_COST', amountCents: 10000, createdById: ownerId } });

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.leadNote.deleteMany({ where: { leadId } }).catch(() => {});
  await prisma.lead.deleteMany({ where: { agencyId } }).catch(() => {});
  await prisma.goal.deleteMany({ where: { agencyId } });
  await prisma.revenueEvent.deleteMany({ where: { agencyId } });
  await prisma.costEvent.deleteMany({ where: { agencyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } }).catch(() => {});
  await prisma.office.deleteMany({ where: { agencyId } });
  await prisma.vendor.deleteMany({ where: { agencyId } });
  await prisma.session.deleteMany({ where: { userId: ownerId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('factory-reset-preview returns real counts without deleting anything', async () => {
  const res = await fetch(`${baseUrl}/api/agencies/${agencyId}/factory-reset-preview`, { headers: { Cookie: ownerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.counts.leads, 1);
  assert.equal(body.counts.revenueEvents, 1);
  assert.equal(body.counts.costEvents, 1);
  // Real roster identity, not just the (non-unique) agency name — lets the
  // confirm UI make a duplicate-named Agency row's mixup visually obvious.
  assert.equal(body.ownerEmail, `fr-owner-${suffix}@test.local`);
  assert.equal(body.ownerName, 'Reset Owner');
  assert.equal(body.totalUsers, 1);

  const stillThere = await prisma.lead.count({ where: { agencyId } });
  assert.equal(stillThere, 1, 'preview must never mutate anything');
});

test('factory-reset rejects a mismatched confirmText', async () => {
  const res = await fetch(`${baseUrl}/api/agencies/${agencyId}/factory-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ confirmText: 'wrong name' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'CONFIRMATION_MISMATCH');

  const stillThere = await prisma.lead.count({ where: { agencyId } });
  assert.equal(stillThere, 1, 'a rejected reset must not delete anything');
});

test('factory-reset wipes leads/financial/historical data but keeps Vendors/Offices/Goals/Users', async () => {
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  const res = await fetch(`${baseUrl}/api/agencies/${agencyId}/factory-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ confirmText: agency.name }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.wipedCounts.leads, 1);
  assert.equal(body.wipedCounts.revenueEvents, 1, 'the agencyId-scoped revenue event must be deleted — the real gap over the old adminWipe.js');
  assert.equal(body.wipedCounts.costEvents, 1);
  assert.equal(body.wipedCounts.customers, 1);

  const [leadsLeft, revenueLeft, costLeft, customerLeft, vendorLeft, officeLeft, goalLeft, userLeft] = await Promise.all([
    prisma.lead.count({ where: { agencyId } }),
    prisma.revenueEvent.count({ where: { agencyId } }),
    prisma.costEvent.count({ where: { agencyId } }),
    prisma.customer.count({ where: { id: customerId } }),
    prisma.vendor.count({ where: { id: vendorId } }),
    prisma.office.count({ where: { id: officeId } }),
    prisma.goal.count({ where: { agencyId } }),
    prisma.user.count({ where: { id: ownerId } }),
  ]);
  assert.equal(leadsLeft, 0);
  assert.equal(revenueLeft, 0);
  assert.equal(costLeft, 0);
  assert.equal(customerLeft, 0);
  assert.equal(vendorLeft, 1, 'Vendor must survive a factory reset');
  assert.equal(officeLeft, 1, 'Office must survive a factory reset');
  assert.equal(goalLeft, 1, 'Goal must survive a factory reset');
  assert.equal(userLeft, 1, 'the Agency Owner login must survive a factory reset');
});
