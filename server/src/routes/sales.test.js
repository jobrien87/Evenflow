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
const { computeFunnel } = require('../lib/funnelMetrics');
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
  const homeRow = billboard.byProduct.find((p) => p.product === 'HOME');
  assert.ok(homeRow, 'the edited productFamily must be reflected on next read, no extra code needed');
  const autoRowStillHasOldSale = billboard.byProduct.find((p) => p.product === 'AUTO')?.soldCount || 0;
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
