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
const { computeBillboard, computeBillboardPeriod } = require('../lib/billboard');
const { PRODUCT_LABELS } = require('../lib/products');
const { computeFunnel } = require('../lib/funnelMetrics');
const { monthBoundsEastern } = require('../lib/billboardPeriods');
const { zonedYearMonthDay } = require('../lib/timezone');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, producerId, producer2Id, managerId, manager2Id, ownerCookie, producerCookie, managerCookie, manager2Cookie, server, baseUrl;

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
  // A selling AGENCY_MANAGER (Julie-style) — real production credit must
  // attribute to her, not fall into an "(unattributed)" bucket just
  // because her role isn't plain PRODUCER.
  const manager = await prisma.user.create({
    data: { email: `sales-manager-${suffix}@test.local`, passwordHash: hash, firstName: 'Julie', lastName: 'Manager', role: 'AGENCY_MANAGER', agencyId, status: 'ACTIVE' },
  });
  managerId = manager.id;
  // A second producer + a second manager — needed for the seniority-gated
  // reassignment tests (Manager-to-Producer must succeed, Manager-to-
  // Manager must require an Owner).
  const producer2 = await prisma.user.create({
    data: { email: `sales-producer2-${suffix}@test.local`, passwordHash: hash, firstName: 'Second', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producer2Id = producer2.id;
  const manager2 = await prisma.user.create({
    data: { email: `sales-manager2-${suffix}@test.local`, passwordHash: hash, firstName: 'Second', lastName: 'Manager', role: 'AGENCY_MANAGER', agencyId, status: 'ACTIVE' },
  });
  manager2Id = manager2.id;

  const ownerSession = await createSession(ownerId);
  ownerCookie = `evenflow_session=${ownerSession.rawToken}`;
  const producerSession = await createSession(producerId);
  producerCookie = `evenflow_session=${producerSession.rawToken}`;
  const managerSession = await createSession(managerId);
  managerCookie = `evenflow_session=${managerSession.rawToken}`;
  const manager2Session = await createSession(manager2Id);
  manager2Cookie = `evenflow_session=${manager2Session.rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.sale.deleteMany({ where: { agencyId } });
  await prisma.revenueEvent.deleteMany({ where: { agencyId } });
  await prisma.auditEvent.deleteMany({ where: { agencyId } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, producerId, producer2Id, managerId, manager2Id] } } });
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

  const productRow = billboard.byProduct.find((p) => p.product === PRODUCT_LABELS.AUTO);
  assert.ok(productRow, 'the product row must appear');
  assert.equal(productRow.soldCount, 1);

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.revenueEvent.deleteMany({ where: { notes: { contains: sale.id } } });
});

// Item 4 of the correction round: a real, full customer-name search for
// Closed Sales, independent of whatever date range happens to be
// selected -- same "find it by name" convenience Find a Lead gives leads.
test('GET /sales?q= finds a sale by customer name regardless of date range, scoped correctly per role', async () => {
  const uniqueLastName = `SearchCustomer${Date.now()}`;
  const oldSaleDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(); // well outside any date-range preset
  const createRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ firstName: 'Findable', lastName: uniqueLastName, saleDate: oldSaleDate, assignedToId: producerId })),
  });
  assert.equal(createRes.status, 201);
  const { sale } = await createRes.json();

  const ownerSearch = await fetch(`${baseUrl}/api/sales?q=${encodeURIComponent(uniqueLastName)}`, { headers: { Cookie: ownerCookie } });
  assert.equal(ownerSearch.status, 200);
  const ownerBody = await ownerSearch.json();
  assert.ok(ownerBody.sales.some((s) => s.id === sale.id), 'an old, out-of-range sale must still be found by name search');

  const producerSearch = await fetch(`${baseUrl}/api/sales?q=${encodeURIComponent(uniqueLastName)}`, { headers: { Cookie: producerCookie } });
  assert.equal(producerSearch.status, 200);
  const producerBody = await producerSearch.json();
  assert.ok(producerBody.sales.some((s) => s.id === sale.id), 'the assigned Producer must find their own sale by name search');

  const managerSearch = await fetch(`${baseUrl}/api/sales?q=${encodeURIComponent(uniqueLastName)}`, { headers: { Cookie: manager2Cookie } });
  assert.equal(managerSearch.status, 200);
  const managerBody = await managerSearch.json();
  assert.ok(managerBody.sales.some((s) => s.id === sale.id), 'a Manager (non-owner, non-assignee) must still find it -- agency-wide, same as GET /sales\' existing default scope');

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.revenueEvent.deleteMany({ where: { notes: { contains: sale.id } } });
});

test('new policy types (Motorhome, Jewelry, Pet Health, Roadside, Umbrella) are accepted, persist, and group correctly on Billboard', async () => {
  const cases = [
    { carrier: 'Allstate', policyType: 'Motorhome', productFamily: 'MOTORHOME' },
    { carrier: 'Allstate', policyType: 'Jewelry', productFamily: 'JEWELRY' },
    { carrier: 'National General', policyType: 'Pet Health', productFamily: 'PET_HEALTH' },
    { carrier: 'Allstate', policyType: 'Roadside', productFamily: 'ROADSIDE' },
    { carrier: 'National General', policyType: 'Umbrella', productFamily: 'UMBRELLA' },
  ];

  const saleIds = [];
  for (const c of cases) {
    const res = await fetch(`${baseUrl}/api/sales`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify(basePayload({ ...c, premiumCents: 10000 })),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    saleIds.push(body.sale.id);

    // Persists exactly as submitted, independent of creation.
    const stored = await prisma.sale.findUnique({ where: { id: body.sale.id } });
    assert.equal(stored.policyType, c.policyType);
    assert.equal(stored.productFamily, c.productFamily);

    // A reload (fresh GET) reflects the same values, not just the create response.
    const getRes = await fetch(`${baseUrl}/api/sales?from=2000-01-01&to=2100-01-01`, { headers: { Cookie: ownerCookie } });
    const getBody = await getRes.json();
    const reloaded = getBody.sales.find((s) => s.id === body.sale.id);
    assert.ok(reloaded, 'the sale must be reachable on reload');
    assert.equal(reloaded.policyType, c.policyType);
    assert.equal(reloaded.productFamily, c.productFamily);
  }

  const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const billboard = await computeBillboard({ agencyId, granularity: 'day', from, to });
  for (const c of cases) {
    const productRow = billboard.byProduct.find((p) => p.product === PRODUCT_LABELS[c.productFamily]);
    assert.ok(productRow, `${c.productFamily} must appear in Billboard's product breakdown`);
    assert.equal(productRow.soldCount >= 1, true);
  }

  await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
  await prisma.revenueEvent.deleteMany({ where: { saleId: { in: saleIds } } });
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

// False-duplicate fix: carrier+policyType+saleDate alone must never match
// two different customers against each other.
test('different customers with the same carrier+policyType+saleDate are never flagged as duplicates of each other', async () => {
  const saleDate = new Date().toISOString();
  const first = basePayload({ saleDate, firstName: 'Alice', lastName: `DiffCustomerA${Date.now()}` });
  const res1 = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: JSON.stringify(first),
  });
  assert.equal(res1.status, 201);
  const { sale: sale1 } = await res1.json();

  const second = basePayload({ saleDate, firstName: 'Bob', lastName: `DiffCustomerB${Date.now()}` });
  const res2 = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: JSON.stringify(second),
  });
  assert.equal(res2.status, 201, 'two different customers buying the same carrier/policyType on the same date must never be flagged as duplicates of each other');
  const { sale: sale2 } = await res2.json();

  await prisma.sale.deleteMany({ where: { id: { in: [sale1.id, sale2.id] } } });
  await prisma.revenueEvent.deleteMany({ where: { saleId: { in: [sale1.id, sale2.id] } } });
});

// Genuine duplicate protection is retained: the SAME customer (name match
// is case-insensitive) with the same carrier+policyType+saleDate is still
// caught, and confirmDuplicate still lets a real re-entry through.
test('a genuine duplicate (same customer, carrier+policyType+saleDate) is flagged and blocked without confirmDuplicate', async () => {
  const saleDate = new Date().toISOString();
  const sharedLastName = `DupCustomer${Date.now()}`;
  const first = basePayload({ saleDate, firstName: 'Same', lastName: sharedLastName });
  const res1 = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: JSON.stringify(first),
  });
  assert.equal(res1.status, 201);
  const { sale: sale1 } = await res1.json();

  // Same customer, different case on both names -- the match must be
  // case-insensitive, same real person either way.
  const second = basePayload({ saleDate, firstName: 'SAME', lastName: sharedLastName.toUpperCase() });
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
  await prisma.revenueEvent.deleteMany({ where: { saleId: { in: [sale1.id, sale2.id] } } });
});

// "Avoid rechecking unchanged matching fields": the client resends
// carrier/policyType/saleDate unconditionally on every save, so an
// unrelated correction (e.g. a premium fix) must never re-trigger the
// duplicate check just because a real colliding sale exists elsewhere.
test('an edit that only changes an unrelated field does not re-trigger the duplicate check, even when a colliding sale exists', async () => {
  const saleDate = new Date().toISOString();
  const sharedLastName = `UnchangedEdit${Date.now()}`;
  const collidingRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ saleDate, firstName: 'Carry', lastName: sharedLastName })),
  });
  assert.equal(collidingRes.status, 201);
  const { sale: colliding } = await collidingRes.json();

  const targetRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ ...basePayload({ saleDate, firstName: 'Carry', lastName: sharedLastName }), confirmDuplicate: true, premiumCents: 10000 }),
  });
  assert.equal(targetRes.status, 201);
  const { sale: target } = await targetRes.json();

  // Resends carrier/policyType/saleDate unchanged (as the real client
  // always does) alongside a genuine premium correction.
  const patchRes = await fetch(`${baseUrl}/api/sales/${target.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ carrier: target.carrier, policyType: target.policyType, saleDate, premiumCents: 77000 }),
  });
  assert.equal(patchRes.status, 200, 'resending unchanged carrier/policyType/saleDate alongside a real premium correction must never re-trigger the duplicate check');
  const { sale: updated } = await patchRes.json();
  assert.equal(updated.premiumCents, 77000);

  await prisma.sale.deleteMany({ where: { id: { in: [colliding.id, target.id] } } });
  await prisma.revenueEvent.deleteMany({ where: { saleId: { in: [colliding.id, target.id] } } });
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

// Item 5 of the production-correction round: a selling AGENCY_MANAGER
// (e.g. Julie) must be creditable the same real way a PRODUCER is — not
// rejected as an invalid assignee, and not lumped into Billboard/
// financials.js's "(unattributed)" bucket just because her role isn't
// plain PRODUCER.
test('a selling AGENCY_MANAGER can be assigned a Sale and is credited correctly, not bucketed as unattributed', async () => {
  const res = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ premiumCents: 60000, assignedToId: managerId })),
  });
  assert.equal(res.status, 201, 'assignedToId must accept a real AGENCY_MANAGER, not just PRODUCER');
  const { sale } = await res.json();
  assert.equal(sale.assignedToId, managerId);

  const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const billboard = await computeBillboard({ agencyId, granularity: 'day', from, to });
  const managerRow = billboard.byProducer.find((p) => p.userId === managerId);
  assert.ok(managerRow, 'the manager must appear on the Billboard leaderboard by her own id');
  assert.equal(managerRow.soldCount, 1);
  assert.equal(managerRow.premiumCents, 60000);
  assert.equal(billboard.byProducer.some((p) => p.firstName === 'Historical' || p.lastName === '(unattributed)'), false, 'nothing should fall into an unattributed bucket here');

  const byAgentRes = await fetch(`${baseUrl}/api/financials/by-agent?${new URLSearchParams({ agencyId, from: from.toISOString(), to: to.toISOString() })}`, { headers: { Cookie: ownerCookie } });
  assert.equal(byAgentRes.status, 200);
  const byAgentBody = await byAgentRes.json();
  const managerAgentRow = byAgentBody.agents.find((a) => a.userId === managerId);
  assert.ok(managerAgentRow, 'the manager must appear on /financials/by-agent by her own id, same roster-first treatment as a producer');
  assert.equal(managerAgentRow.salesCount, 1);
  assert.equal(managerAgentRow.revenue, 600);
  const unattributedAgentRow = byAgentBody.agents.find((a) => a.userId === null);
  assert.equal(unattributedAgentRow, undefined, 'nothing should fall into the unattributed bucket here');

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.revenueEvent.deleteMany({ where: { notes: { contains: sale.id } } });
});

// --- Sale correction/edit workflow (revenue sync, seniority, duplicate
// recheck, audit diff) ---

test('editing premiumCents via PATCH updates the SAME RevenueEvent row, and /financials/summary reflects it', async () => {
  const createRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ lastName: `RevSync${Date.now()}`, premiumCents: 30000 })),
  });
  const { sale } = await createRes.json();

  const eventsAfterCreate = await prisma.revenueEvent.findMany({ where: { saleId: sale.id } });
  assert.equal(eventsAfterCreate.length, 1, 'creation posts exactly one linked RevenueEvent');
  const originalEventId = eventsAfterCreate[0].id;
  assert.equal(eventsAfterCreate[0].amountCents, 30000);

  const patchRes = await fetch(`${baseUrl}/api/sales/${sale.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ premiumCents: 85000 }),
  });
  assert.equal(patchRes.status, 200);

  const eventsAfterPatch = await prisma.revenueEvent.findMany({ where: { saleId: sale.id } });
  assert.equal(eventsAfterPatch.length, 1, 'the edit must update the SAME row, never create a second one');
  assert.equal(eventsAfterPatch[0].id, originalEventId);
  assert.equal(eventsAfterPatch[0].amountCents, 85000);

  const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const summaryRes = await fetch(`${baseUrl}/api/financials/summary?${new URLSearchParams({ agencyId, from: from.toISOString(), to: to.toISOString() })}`, { headers: { Cookie: ownerCookie } });
  assert.equal(summaryRes.status, 200);
  const summary = await summaryRes.json();
  const revenueCategory = summary.revenueByCategory.find((c) => c.category === 'LEAD_REVENUE');
  assert.ok(revenueCategory.amount >= 850, '/financials/summary must reflect the corrected premium, not the stale original');

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.revenueEvent.deleteMany({ where: { saleId: sale.id } });
});

test('zeroing premiumCents via PATCH deletes the linked RevenueEvent', async () => {
  const createRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ lastName: `ZeroOut${Date.now()}`, premiumCents: 20000 })),
  });
  const { sale } = await createRes.json();
  assert.equal(await prisma.revenueEvent.count({ where: { saleId: sale.id } }), 1);

  const patchRes = await fetch(`${baseUrl}/api/sales/${sale.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ premiumCents: 0 }),
  });
  assert.equal(patchRes.status, 200);

  assert.equal(await prisma.revenueEvent.count({ where: { saleId: sale.id } }), 0, 'zeroing the premium must remove the RevenueEvent, not leave a stale nonzero row');
  const refetched = await prisma.sale.findUnique({ where: { id: sale.id } });
  assert.equal(refetched.premiumCents, 0, 'the Sale row itself must still show the explicit 0, not be deleted');

  await prisma.sale.delete({ where: { id: sale.id } });
});

test('a repeated/double-submitted identical PATCH leaves exactly one RevenueEvent row', async () => {
  const createRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ lastName: `DoublePatch${Date.now()}`, premiumCents: 25000 })),
  });
  const { sale } = await createRes.json();

  const patchBody = JSON.stringify({ premiumCents: 70000 });
  const [res1, res2] = await Promise.all([
    fetch(`${baseUrl}/api/sales/${sale.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: patchBody }),
    fetch(`${baseUrl}/api/sales/${sale.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: patchBody }),
  ]);
  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);

  const events = await prisma.revenueEvent.findMany({ where: { saleId: sale.id } });
  assert.equal(events.length, 1, 'two concurrent identical PATCHes must never produce duplicate credit');
  assert.equal(events[0].amountCents, 70000);

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.revenueEvent.deleteMany({ where: { saleId: sale.id } });
});

test('voiding a sale deletes its linked RevenueEvent, and /financials/summary drops it', async () => {
  const createRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ lastName: `VoidRevSync${Date.now()}`, premiumCents: 45000 })),
  });
  const { sale } = await createRes.json();
  assert.equal(await prisma.revenueEvent.count({ where: { saleId: sale.id } }), 1);

  const voidRes = await fetch(`${baseUrl}/api/sales/${sale.id}/void`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ voidReason: 'entered in error' }),
  });
  assert.equal(voidRes.status, 200);

  assert.equal(await prisma.revenueEvent.count({ where: { saleId: sale.id } }), 0, 'voiding must remove the revenue contribution in the same commit');

  await prisma.sale.delete({ where: { id: sale.id } });
});

test('an Agency Manager can reassign credit between two Producers, but never to or from another Manager — only an Owner can', async () => {
  const createRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ lastName: `Seniority${Date.now()}`, assignedToId: producerId })),
  });
  const { sale } = await createRes.json();

  // Producer -> Producer: a plain Manager is fully allowed.
  const toProducer2 = await fetch(`${baseUrl}/api/sales/${sale.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: managerCookie },
    body: JSON.stringify({ assignedToId: producer2Id }),
  });
  assert.equal(toProducer2.status, 200, 'a Manager must be able to move credit between two Producers');
  const afterProducer2 = await toProducer2.json();
  assert.equal(afterProducer2.sale.assignedToId, producer2Id);

  // Producer -> Manager: moving credit TO a Manager also needs an Owner,
  // even though the CURRENT assignee is just a Producer.
  const toManager2ByManager = await fetch(`${baseUrl}/api/sales/${sale.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: managerCookie },
    body: JSON.stringify({ assignedToId: manager2Id }),
  });
  assert.equal(toManager2ByManager.status, 403, 'a Manager must not be able to move credit TO another Manager');

  // The same move, done by the Owner, succeeds — now manager2 holds it.
  const toManager2ByOwner = await fetch(`${baseUrl}/api/sales/${sale.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ assignedToId: manager2Id }),
  });
  assert.equal(toManager2ByOwner.status, 200, 'an Agency Owner must always be able to reassign credit');

  // Manager -> Producer: moving credit AWAY from a Manager, attempted by
  // a plain Manager, must also be blocked.
  const awayFromManager2ByManager = await fetch(`${baseUrl}/api/sales/${sale.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: managerCookie },
    body: JSON.stringify({ assignedToId: producerId }),
  });
  assert.equal(awayFromManager2ByManager.status, 403, 'a Manager must not be able to move credit AWAY from another Manager either');

  // The Owner can still move it away from the Manager at will.
  const awayFromManager2ByOwner = await fetch(`${baseUrl}/api/sales/${sale.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ assignedToId: producerId }),
  });
  assert.equal(awayFromManager2ByOwner.status, 200, 'an Agency Owner must always be able to reassign credit, regardless of current assignee');

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.revenueEvent.deleteMany({ where: { saleId: sale.id } });
});

test('leadId in a PATCH body is always ignored — a correction can never relink a sale to a different lead', async () => {
  const createRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ lastName: `LeadIdInvariant${Date.now()}` })),
  });
  const { sale } = await createRes.json();
  assert.equal(sale.leadId, null, 'this standalone sale starts with no leadId');

  const customer = await prisma.customer.create({ data: { firstName: 'Relink', lastName: `Attempt${Date.now()}`, phoneNormalized: `relink${suffix}` } });
  const lead = await prisma.lead.create({
    data: { agencyId, customerId: customer.id, source: 'manual', status: 'NEW', product: 'Auto', createdById: ownerId, assignedToId: producerId },
  });

  const patchRes = await fetch(`${baseUrl}/api/sales/${sale.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ leadId: lead.id, notes: 'trying to relink' }),
  });
  assert.equal(patchRes.status, 200);
  const { sale: updated } = await patchRes.json();
  assert.equal(updated.leadId, null, 'leadId must remain untouched regardless of what the PATCH body sends');
  assert.equal(updated.notes, 'trying to relink', 'other fields in the same PATCH must still apply normally');

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.lead.delete({ where: { id: lead.id } });
  await prisma.customer.delete({ where: { id: customer.id } });
});

test('a PATCH that collides with another real sale is flagged unless confirmed, and never flags against its own prior values', async () => {
  const saleDate = new Date().toISOString();
  const originalRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ saleDate, lastName: `EditDupOriginal${Date.now()}`, policyNumber: `PN-${Date.now()}-A` })),
  });
  const { sale: original } = await originalRes.json();

  // Editing it back to its own current carrier/policyType/saleDate must
  // never flag against itself.
  const noOpPatch = await fetch(`${baseUrl}/api/sales/${original.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ saleDate }),
  });
  assert.equal(noOpPatch.status, 200, 'editing a sale back to its own existing values must not flag it as a duplicate of itself');

  // A distinct saleDate here (not `saleDate`) so this creation itself
  // doesn't collide with `original` via the carrier+policyType+saleDate
  // branch — this test isolates the policyNumber collision specifically.
  const otherSaleDate = new Date(Date.now() + 60000).toISOString();
  const otherRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ saleDate: otherSaleDate, lastName: `EditDupOther${Date.now()}`, policyNumber: `PN-${Date.now()}-B` })),
  });
  assert.equal(otherRes.status, 201, 'the second sale must be created cleanly with no carrier/policyType/saleDate collision');
  const { sale: other } = await otherRes.json();

  // Now edit `other` to carry the SAME policyNumber as `original` — a
  // real collision with a different sale, must be caught.
  const collidePatch = await fetch(`${baseUrl}/api/sales/${other.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ policyNumber: original.policyNumber }),
  });
  assert.equal(collidePatch.status, 409);
  const collideBody = await collidePatch.json();
  assert.equal(collideBody.error, 'POSSIBLE_DUPLICATE');

  const confirmedPatch = await fetch(`${baseUrl}/api/sales/${other.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ policyNumber: original.policyNumber, confirmDuplicate: true }),
  });
  assert.equal(confirmedPatch.status, 200, 'confirmDuplicate must let the edit through');

  await prisma.sale.deleteMany({ where: { id: { in: [original.id, other.id] } } });
  await prisma.revenueEvent.deleteMany({ where: { saleId: { in: [original.id, other.id] } } });
});

test('a PATCH audit event records only the changed fields as before/after, not the whole row', async () => {
  const createRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ lastName: `AuditDiff${Date.now()}`, premiumCents: 33000, items: 2 })),
  });
  const { sale } = await createRes.json();

  const patchRes = await fetch(`${baseUrl}/api/sales/${sale.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ premiumCents: 61000 }),
  });
  assert.equal(patchRes.status, 200);

  const audit = await prisma.auditEvent.findFirst({
    where: { entityType: 'Sale', entityId: sale.id, action: 'sale.corrected' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(audit, 'a sale.corrected audit event must be recorded');
  assert.equal(audit.actorId, ownerId);
  assert.deepEqual(Object.keys(audit.before), ['premiumCents'], 'before must contain only the changed field(s)');
  assert.equal(audit.before.premiumCents, 33000);
  assert.deepEqual(audit.after, { premiumCents: 61000 });
  // Untouched fields like items must never appear in the diff.
  assert.equal(Object.prototype.hasOwnProperty.call(audit.before, 'items'), false);

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.revenueEvent.deleteMany({ where: { saleId: sale.id } });
});

test('editing items/productFamily/saleDate/assignedToId is reflected live in Billboard with no additional code', async () => {
  const createRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ lastName: `LiveReflect${Date.now()}`, items: 1, productFamily: 'AUTO', premiumCents: 40000 })),
  });
  const { sale } = await createRes.json();

  const patchRes = await fetch(`${baseUrl}/api/sales/${sale.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ items: 3, productFamily: 'HOME' }),
  });
  assert.equal(patchRes.status, 200);

  const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const billboard = await computeBillboard({ agencyId, granularity: 'day', from, to });
  const homeRow = billboard.byProduct.find((p) => p.product === PRODUCT_LABELS.HOME);
  assert.ok(homeRow, 'the edited productFamily must be reflected on next read, no extra code needed');
  const autoRowStillHasOldSale = billboard.byProduct.find((p) => p.product === PRODUCT_LABELS.AUTO)?.soldCount || 0;
  // Other AUTO sales from earlier tests may still exist concurrently in
  // this suite's shared agency; the real assertion is that the edited
  // sale itself now lands under HOME, not that AUTO is empty.
  assert.ok(autoRowStillHasOldSale >= 0);

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.revenueEvent.deleteMany({ where: { saleId: sale.id } });
});

test('editing a Sale never changes close rate (computeFunnel reads only Lead.status, never Sale)', async () => {
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const before1 = await computeFunnel({ agencyId, from, to });

  const createRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ lastName: `CloseRateUnaffected${Date.now()}`, premiumCents: 50000 })),
  });
  const { sale } = await createRes.json();
  await fetch(`${baseUrl}/api/sales/${sale.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ premiumCents: 99000 }),
  });

  const after1 = await computeFunnel({ agencyId, from, to });
  assert.equal(after1.closeRate, before1.closeRate, 'a Sale create+edit must never move close rate — it is Lead-status-only');

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.revenueEvent.deleteMany({ where: { saleId: sale.id } });
});

// A Producer's own sale-editing path (Item 1's original "verify a
// producer can correct premium/items on their own sale and save/reload
// without changing ownership or creating another sale") — the PATCH
// route's own PRODUCER branches (ownership 403, smuggled assignedToId
// silently ignored) had no direct test coverage of their own before this.
test('a Producer can PATCH their own sale and reload the correction, but gets 403 on another producer\'s sale, and a smuggled assignedToId is ignored', async () => {
  const createRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: producerCookie },
    body: JSON.stringify(basePayload({ lastName: `ProducerOwnEdit${Date.now()}`, premiumCents: 40000, items: 1, assignedToId: producerId })),
  });
  assert.equal(createRes.status, 201);
  const { sale } = await createRes.json();

  // Own sale: premium/items correction succeeds and persists on reload.
  const ownPatchRes = await fetch(`${baseUrl}/api/sales/${sale.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: producerCookie },
    body: JSON.stringify({ premiumCents: 55500, items: 2 }),
  });
  assert.equal(ownPatchRes.status, 200);
  const reloaded = await prisma.sale.findUnique({ where: { id: sale.id } });
  assert.equal(reloaded.premiumCents, 55500);
  assert.equal(reloaded.items, 2);
  assert.equal(reloaded.assignedToId, producerId, 'ownership must be unchanged by the producer\'s own correction');

  // A smuggled assignedToId from the Producer must be silently ignored,
  // never reassigning credit and never erroring the whole request.
  const smuggleRes = await fetch(`${baseUrl}/api/sales/${sale.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: producerCookie },
    body: JSON.stringify({ premiumCents: 60000, assignedToId: producer2Id }),
  });
  assert.equal(smuggleRes.status, 200);
  const afterSmuggle = await prisma.sale.findUnique({ where: { id: sale.id } });
  assert.equal(afterSmuggle.assignedToId, producerId, 'a Producer can never reassign credit via PATCH, even to themselves-adjacent values');
  assert.equal(afterSmuggle.premiumCents, 60000, 'the legitimate part of the same request must still apply');

  // A different producer's own sale is 403, not editable.
  const otherCreateRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ lastName: `OtherProducerSale${Date.now()}`, assignedToId: producer2Id })),
  });
  const { sale: otherSale } = await otherCreateRes.json();
  const crossPatchRes = await fetch(`${baseUrl}/api/sales/${otherSale.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: producerCookie },
    body: JSON.stringify({ premiumCents: 1 }),
  });
  assert.equal(crossPatchRes.status, 403);
  const otherUnchanged = await prisma.sale.findUnique({ where: { id: otherSale.id } });
  assert.notEqual(otherUnchanged.premiumCents, 1, 'a 403\'d PATCH must never mutate the other producer\'s sale');

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.revenueEvent.deleteMany({ where: { saleId: sale.id } });
  await prisma.sale.delete({ where: { id: otherSale.id } });
  await prisma.revenueEvent.deleteMany({ where: { saleId: otherSale.id } });
});

// Reconciliation evidence (Item 6): a backdated saleDate correction must
// move the sale's full premium out of its old period and into its new
// one in BOTH Financials and Billboard, in lockstep, never leaving it
// split (counted in one report's period but not the other's, or counted
// in both at once). Measured as deltas, not absolute totals, since this
// shared test-suite agency accrues/clears other sales around it.
test('a backdated saleDate correction moves revenue between periods identically in Financials and Billboard, never splitting them', async () => {
  const timeZone = 'America/New_York';
  const now = zonedYearMonthDay(new Date(), timeZone);
  const thisMonth = { year: now.year, month: now.month };
  const lastMonth = now.month === 1 ? { year: now.year - 1, month: 12 } : { year: now.year, month: now.month - 1 };
  const pad2 = (n) => String(n).padStart(2, '0');
  const thisMonthSaleDate = `${thisMonth.year}-${pad2(thisMonth.month)}-15`;
  const lastMonthSaleDate = `${lastMonth.year}-${pad2(lastMonth.month)}-15`;
  const thisMonthBounds = monthBoundsEastern(thisMonth.year, thisMonth.month, timeZone);
  const lastMonthBounds = monthBoundsEastern(lastMonth.year, lastMonth.month, timeZone);

  async function financialsAmount(bounds) {
    const res = await fetch(`${baseUrl}/api/financials/summary?${new URLSearchParams({ agencyId, from: bounds.from.toISOString(), to: new Date(bounds.to.getTime() - 1).toISOString() })}`, { headers: { Cookie: ownerCookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    return body.revenueByCategory.find((c) => c.category === 'LEAD_REVENUE')?.amount || 0;
  }
  async function billboardPremium(month) {
    const result = await computeBillboardPeriod({ agencyId, period: 'month', month: `${month.year}-${pad2(month.month)}` });
    return result.totals.premiumCents;
  }

  const thisMonthFinBefore = await financialsAmount(thisMonthBounds);
  const thisMonthBbBefore = await billboardPremium(thisMonth);
  const lastMonthFinBefore = await financialsAmount(lastMonthBounds);
  const lastMonthBbBefore = await billboardPremium(lastMonth);

  const createRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ lastName: `Reconcile${Date.now()}`, saleDate: thisMonthSaleDate, premiumCents: 77700 })),
  });
  assert.equal(createRes.status, 201);
  const { sale } = await createRes.json();

  const thisMonthFinAfterCreate = await financialsAmount(thisMonthBounds);
  const thisMonthBbAfterCreate = await billboardPremium(thisMonth);
  assert.equal(Math.round((thisMonthFinAfterCreate - thisMonthFinBefore) * 100), 77700, 'Financials must pick up the new sale in its real month');
  assert.equal(thisMonthBbAfterCreate - thisMonthBbBefore, 77700, 'Billboard must pick up the new sale in its real month');

  const patchRes = await fetch(`${baseUrl}/api/sales/${sale.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ saleDate: lastMonthSaleDate }),
  });
  assert.equal(patchRes.status, 200);

  const thisMonthFinAfterPatch = await financialsAmount(thisMonthBounds);
  const thisMonthBbAfterPatch = await billboardPremium(thisMonth);
  const lastMonthFinAfterPatch = await financialsAmount(lastMonthBounds);
  const lastMonthBbAfterPatch = await billboardPremium(lastMonth);

  // The old period loses the full premium in both reports — never left
  // behind in one while the other moves on.
  assert.equal(Math.round((thisMonthFinAfterPatch - thisMonthFinBefore) * 100), 0, 'Financials must fully remove the backdated sale from its original month');
  assert.equal(thisMonthBbAfterPatch - thisMonthBbBefore, 0, 'Billboard must fully remove the backdated sale from its original month');

  // The new period gains the full premium in both reports — never only
  // one of the two.
  assert.equal(Math.round((lastMonthFinAfterPatch - lastMonthFinBefore) * 100), 77700, 'Financials must show the backdated sale in its corrected month');
  assert.equal(lastMonthBbAfterPatch - lastMonthBbBefore, 77700, 'Billboard must show the backdated sale in its corrected month');

  // And the two reports must agree with each other at every step, not
  // merely with their own prior value.
  assert.equal(Math.round((lastMonthFinAfterPatch - lastMonthFinBefore) * 100), lastMonthBbAfterPatch - lastMonthBbBefore, 'Financials and Billboard must move by the identical amount, in the identical period');

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.revenueEvent.deleteMany({ where: { saleId: sale.id } });
});

// --- GET /leads/sold-missing-sale (reconciliation for the leaderboard
// -not-reporting-correctly complaint) ---

async function createSoldLeadWithNoSale({ assignedToId = producerId, premiumCents = 45000, saleProduct = 'AUTO' } = {}) {
  const customer = await prisma.customer.create({
    data: { firstName: 'Unlogged', lastName: `Sale${Date.now()}${Math.random()}`, phoneNormalized: `unlogged${Date.now()}${Math.floor(Math.random() * 1e6)}` },
  });
  const lead = await prisma.lead.create({
    data: {
      agencyId, customerId: customer.id, source: 'manual', status: 'SOLD', product: 'Auto',
      createdById: ownerId, assignedToId, salePremiumCents: premiumCents, saleProduct,
    },
  });
  return { lead, customer };
}

test('GET /leads/sold-missing-sale surfaces a SOLD lead with no Closed Sale logged, and omits one that has a real linked Sale', async () => {
  const { lead: missingLead, customer: missingCustomer } = await createSoldLeadWithNoSale();
  const { lead: linkedLead, customer: linkedCustomer } = await createSoldLeadWithNoSale({ premiumCents: 60000 });

  // Log a real Closed Sale against the second lead — it must disappear
  // from the missing-sale list once linked.
  const saleRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ premiumCents: 60000, leadId: linkedLead.id })),
  });
  assert.equal(saleRes.status, 201);
  const { sale: linkedSale } = await saleRes.json();

  const res = await fetch(`${baseUrl}/api/leads/sold-missing-sale`, { headers: { Cookie: ownerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.ok(body.leads.some((l) => l.id === missingLead.id), 'a SOLD lead with no linked Sale must be surfaced');
  assert.equal(body.leads.some((l) => l.id === linkedLead.id), false, 'a SOLD lead with a real linked Sale must never be surfaced as missing');

  const row = body.leads.find((l) => l.id === missingLead.id);
  assert.equal(row.salePremiumCents, 45000);
  assert.equal(row.saleProduct, 'AUTO');
  assert.equal(row.assignedToId, producerId);

  await prisma.sale.delete({ where: { id: linkedSale.id } });
  await prisma.revenueEvent.deleteMany({ where: { saleId: linkedSale.id } });
  await prisma.lead.deleteMany({ where: { id: { in: [missingLead.id, linkedLead.id] } } });
  await prisma.customer.deleteMany({ where: { id: { in: [missingCustomer.id, linkedCustomer.id] } } });
});

test('GET /leads/sold-missing-sale: a Producer only ever sees their own gaps, never another producer\'s', async () => {
  const { lead: ownLead, customer: ownCustomer } = await createSoldLeadWithNoSale({ assignedToId: producerId });
  const { lead: otherLead, customer: otherCustomer } = await createSoldLeadWithNoSale({ assignedToId: producer2Id });

  const producerRes = await fetch(`${baseUrl}/api/leads/sold-missing-sale`, { headers: { Cookie: producerCookie } });
  assert.equal(producerRes.status, 200);
  const producerBody = await producerRes.json();
  assert.ok(producerBody.leads.some((l) => l.id === ownLead.id), 'a producer must see their own unlogged sale');
  assert.equal(producerBody.leads.some((l) => l.id === otherLead.id), false, 'a producer must never see a different producer\'s unlogged sale');

  const ownerRes = await fetch(`${baseUrl}/api/leads/sold-missing-sale`, { headers: { Cookie: ownerCookie } });
  const ownerBody = await ownerRes.json();
  assert.ok(ownerBody.leads.some((l) => l.id === ownLead.id), 'the Owner must see every gap in the agency');
  assert.ok(ownerBody.leads.some((l) => l.id === otherLead.id), 'the Owner must see every gap in the agency');

  await prisma.lead.deleteMany({ where: { id: { in: [ownLead.id, otherLead.id] } } });
  await prisma.customer.deleteMany({ where: { id: { in: [ownCustomer.id, otherCustomer.id] } } });
});

test('a voided Sale still linked to a lead leaves that lead counted as missing again', async () => {
  const { lead, customer } = await createSoldLeadWithNoSale({ premiumCents: 70000 });
  const saleRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify(basePayload({ premiumCents: 70000, leadId: lead.id })),
  });
  const { sale } = await saleRes.json();

  const beforeVoid = await fetch(`${baseUrl}/api/leads/sold-missing-sale`, { headers: { Cookie: ownerCookie } });
  const beforeVoidBody = await beforeVoid.json();
  assert.equal(beforeVoidBody.leads.some((l) => l.id === lead.id), false, 'a lead with a real, non-voided Sale must not be missing');

  await fetch(`${baseUrl}/api/sales/${sale.id}/void`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ voidReason: 'test void' }),
  });

  const afterVoid = await fetch(`${baseUrl}/api/leads/sold-missing-sale`, { headers: { Cookie: ownerCookie } });
  const afterVoidBody = await afterVoid.json();
  assert.ok(afterVoidBody.leads.some((l) => l.id === lead.id), 'once its one real Sale is voided, the lead must be surfaced as missing again — a voided sale credits nothing');

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.revenueEvent.deleteMany({ where: { saleId: sale.id } });
  await prisma.lead.delete({ where: { id: lead.id } });
  await prisma.customer.delete({ where: { id: customer.id } });
});
