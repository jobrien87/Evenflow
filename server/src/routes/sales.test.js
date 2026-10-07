// Real-database, real-HTTP test for Add Closed Sale (routes/sales.js) —
//   DATABASE_URL=postgresql://... node --test src/routes/sales.test.js
//
// Covers: a standalone sale appears in computeBillboard's byProducer/
// byProduct with the right count/premium; zero-premium and zero-item
// sales are preserved, not coerced; a duplicate (same carrier+policyType+
// saleDate) is flagged and blocked without confirmDuplicate, then
// succeeds with it; two POSTs with the same clientRequestId produce
// exactly one row; a void removes the sale's contribution from Billboard;
// a PATCH correction updates in place; and the disposition double-count
// fix (re-dispositioning an already-SOLD lead does not re-post revenue).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const { computeBillboard } = require('../lib/billboard');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, producerId, ownerCookie, producerCookie, server, baseUrl;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Sales Test Agency ${suffix}` } });
  agencyId = agency.id;

  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `sales-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Sales', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const producer = await prisma.user.create({
    data: { email: `sales-producer-${suffix}@test.local`, passwordHash: hash, firstName: 'Sales', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerId = producer.id;

  const ownerSession = await createSession(ownerId);
  ownerCookie = `evenflow_session=${ownerSession.rawToken}`;
  const producerSession = await createSession(producerId);
  producerCookie = `evenflow_session=${producerSession.rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.sale.deleteMany({ where: { agencyId } });
  await prisma.revenueEvent.deleteMany({ where: { agencyId } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, producerId] } } });
  await prisma.user.deleteMany({ where: { agencyId } });
  await prisma.agency.delete({ where: { id: agencyId } }).catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

function basePayload(overrides = {}) {
  return {
    clientRequestId: crypto.randomUUID(),
    firstName: 'Test', lastName: `Customer${Date.now()}`,
    saleDate: new Date().toISOString(),
    carrier: 'Allstate', policyType: 'Auto-Standard', productFamily: 'AUTO',
    premiumCents: 50000,
    assignedToId: producerId,
    ...overrides,
  };
}

test('a standalone sale reaches Billboard\'s byProducer and byProduct with the right count/premium', async () => {
  const res = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ premiumCents: 75000 })),
  });
  assert.equal(res.status, 201);
  const { sale } = await res.json();

  const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const billboard = await computeBillboard({ agencyId, granularity: 'day', from, to });

  const producerRow = billboard.byProducer.find((p) => p.userId === producerId);
  assert.ok(producerRow, 'the producer must appear on the leaderboard');
  assert.equal(producerRow.soldCount, 1);
  assert.equal(producerRow.premiumCents, 75000);

  const productRow = billboard.byProduct.find((p) => p.product === 'AUTO');
  assert.ok(productRow, 'the product row must appear');
  assert.equal(productRow.soldCount, 1);

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.revenueEvent.deleteMany({ where: { notes: { contains: sale.id } } });
});

test('zero-premium and zero-item sales are preserved, not coerced to a default', async () => {
  const res = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ premiumCents: 0, items: 0 })),
  });
  assert.equal(res.status, 201);
  const { sale } = await res.json();
  assert.equal(sale.premiumCents, 0, 'an explicit 0 premium must stay 0, never fall back to null/default');
  assert.equal(sale.items, 0, 'an explicit 0 items must stay 0, never fall back to the default of 1');

  // A zero-premium sale must never post a RevenueEvent (recordManualSaleRevenue
  // guards on a truthy premiumCents) -- confirm no ledger row exists for it.
  const events = await prisma.revenueEvent.findMany({ where: { notes: { contains: sale.id } } });
  assert.equal(events.length, 0);

  await prisma.sale.delete({ where: { id: sale.id } });
});

test('a duplicate (same carrier+policyType+saleDate) is flagged and blocked without confirmDuplicate', async () => {
  const saleDate = new Date().toISOString();
  const first = basePayload({ saleDate, lastName: `DupCustomer${Date.now()}` });
  const res1 = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: JSON.stringify(first),
  });
  assert.equal(res1.status, 201);
  const { sale: sale1 } = await res1.json();

  const second = basePayload({ saleDate, lastName: `DupCustomer2${Date.now()}` });
  const res2 = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: JSON.stringify(second),
  });
  assert.equal(res2.status, 409);
  const body2 = await res2.json();
  assert.equal(body2.error, 'POSSIBLE_DUPLICATE');
  assert.ok(body2.sales.length >= 1);

  const res3 = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ ...second, confirmDuplicate: true }),
  });
  assert.equal(res3.status, 201, 'confirmDuplicate must let the second sale through');
  const { sale: sale2 } = await res3.json();

  await prisma.sale.deleteMany({ where: { id: { in: [sale1.id, sale2.id] } } });
  await prisma.revenueEvent.deleteMany({ where: { OR: [{ notes: { contains: sale1.id } }, { notes: { contains: sale2.id } }] } });
});

test('two POSTs with the same clientRequestId produce exactly one row (idempotent retry)', async () => {
  const payload = basePayload({ lastName: `IdemCustomer${Date.now()}` });
  const res1 = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: JSON.stringify(payload),
  });
  assert.equal(res1.status, 201);
  const { sale: sale1 } = await res1.json();

  const res2 = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: JSON.stringify(payload),
  });
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.equal(body2.idempotentReplay, true);
  assert.equal(body2.sale.id, sale1.id, 'the retry must return the SAME row, never a second one');

  const count = await prisma.sale.count({ where: { clientRequestId: payload.clientRequestId } });
  assert.equal(count, 1);

  await prisma.sale.delete({ where: { id: sale1.id } });
  await prisma.revenueEvent.deleteMany({ where: { notes: { contains: sale1.id } } });
});

test('voiding a sale removes its contribution from Billboard', async () => {
  const res = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ lastName: `VoidCustomer${Date.now()}`, premiumCents: 60000 })),
  });
  const { sale } = await res.json();

  const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const before1 = await computeBillboard({ agencyId, granularity: 'day', from, to });
  const beforeCount = before1.byProducer.find((p) => p.userId === producerId)?.soldCount || 0;

  const voidRes = await fetch(`${baseUrl}/api/sales/${sale.id}/void`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ voidReason: 'entered in error' }),
  });
  assert.equal(voidRes.status, 200);

  const after1 = await computeBillboard({ agencyId, granularity: 'day', from, to });
  const afterCount = after1.byProducer.find((p) => p.userId === producerId)?.soldCount || 0;
  assert.equal(afterCount, beforeCount - 1, 'a voided sale must no longer count on the leaderboard');

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.revenueEvent.deleteMany({ where: { notes: { contains: sale.id } } });
});

test('PATCH correction updates the sale in place, not a second row', async () => {
  const res = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ lastName: `PatchCustomer${Date.now()}`, premiumCents: 40000 })),
  });
  const { sale } = await res.json();

  const patchRes = await fetch(`${baseUrl}/api/sales/${sale.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ premiumCents: 90000 }),
  });
  assert.equal(patchRes.status, 200);
  const { sale: updated } = await patchRes.json();
  assert.equal(updated.id, sale.id);
  assert.equal(updated.premiumCents, 90000);

  const count = await prisma.sale.count({ where: { lastName: sale.lastName, agencyId } });
  assert.equal(count, 1, 'a correction must never create a second row');

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.revenueEvent.deleteMany({ where: { notes: { contains: sale.id } } });
});

test('a Producer can only credit themselves on a standalone sale', async () => {
  const otherProducer = await prisma.user.create({
    data: { email: `sales-other-${suffix}@test.local`, passwordHash: await bcrypt.hash('TestPass123!', 12), firstName: 'Other', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });

  const res = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: producerCookie },
    body: JSON.stringify(basePayload({ lastName: `SelfCustomer${Date.now()}`, assignedToId: otherProducer.id })),
  });
  assert.equal(res.status, 201);
  const { sale } = await res.json();
  assert.equal(sale.assignedToId, producerId, 'a Producer must always self-assign, regardless of what assignedToId they sent');

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.revenueEvent.deleteMany({ where: { notes: { contains: sale.id } } });
  await prisma.user.delete({ where: { id: otherProducer.id } });
});

test('re-dispositioning an already-SOLD lead to SOLD again does not post a second RevenueEvent', async () => {
  const customer = await prisma.customer.create({ data: { firstName: 'Lead', lastName: `SoldTwice${Date.now()}`, phoneNormalized: `soldtwice${suffix}` } });
  const lead = await prisma.lead.create({
    data: { agencyId, customerId: customer.id, source: 'manual', status: 'NEW', product: 'Auto', createdById: ownerId, assignedToId: producerId },
  });

  const first = await fetch(`${baseUrl}/api/leads/${lead.id}/disposition`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ status: 'SOLD', salePremiumCents: 50000, saleProduct: 'AUTO' }),
  });
  assert.equal(first.status, 200);

  const countAfterFirst = await prisma.revenueEvent.count({ where: { agencyId, notes: { contains: lead.id } } });

  // Re-disposition the already-SOLD lead to SOLD again (a correction, e.g.
  // adjusting the premium) -- this must NOT post a second RevenueEvent.
  const second = await fetch(`${baseUrl}/api/leads/${lead.id}/disposition`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ status: 'SOLD', salePremiumCents: 55000, saleProduct: 'AUTO' }),
  });
  assert.equal(second.status, 200);

  const countAfterSecond = await prisma.revenueEvent.count({ where: { agencyId, notes: { contains: lead.id } } });
  assert.equal(countAfterSecond, countAfterFirst, 'no second RevenueEvent must be posted for an already-SOLD lead');

  await prisma.leadEvent.deleteMany({ where: { leadId: lead.id } });
  await prisma.revenueEvent.deleteMany({ where: { agencyId, notes: { contains: lead.id } } });
  await prisma.lead.delete({ where: { id: lead.id } });
  await prisma.customer.delete({ where: { id: customer.id } });
});
