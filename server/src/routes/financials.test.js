// Real-database, real-HTTP test for GET /financials/by-agent (the "Agent
// Leaderboard" PerformanceLeaderboards.jsx renders) —
//   DATABASE_URL=postgresql://... node --test src/routes/financials.test.js
//
// Covers the two confirmed bugs behind "a real Closed Sale doesn't show
// up on the leaderboard, but everything else tracks":
//   1. A date-range timezone mismatch, same bug class already fixed in
//      sales.js/billboard.js — a Sale dated the 1st of the selected
//      period was silently excluded.
//   2. A Sale credited to someone outside the active PRODUCER/
//      AGENCY_MANAGER roster was folded into one anonymous "Manual
//      Sales (unattributed)" row instead of its own named row.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, producerId, deactivatedProducerId, ownerCookie, server, baseUrl;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Financials Test Agency ${suffix}`, timezone: 'America/New_York' } });
  agencyId = agency.id;

  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `financials-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Fin', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const producer = await prisma.user.create({
    data: { email: `financials-producer-${suffix}@test.local`, passwordHash: hash, firstName: 'Fin', lastName: 'Producer', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  producerId = producer.id;
  // Outside eligibleProducersWhere's roster (status != ACTIVE) — a real
  // Sale can still be assigned to them (sales.js's create route places no
  // role/status restriction on assignedToId).
  const deactivatedProducer = await prisma.user.create({
    data: { email: `financials-deactivated-${suffix}@test.local`, passwordHash: hash, firstName: 'Former', lastName: 'Rep', role: 'PRODUCER', agencyId, status: 'DEACTIVATED' },
  });
  deactivatedProducerId = deactivatedProducer.id;

  const ownerSession = await createSession(ownerId);
  ownerCookie = `evenflow_session=${ownerSession.rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.revenueEvent.deleteMany({ where: { agencyId } });
  await prisma.sale.deleteMany({ where: { agencyId } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, producerId, deactivatedProducerId] } } });
  await prisma.user.deleteMany({ where: { agencyId } });
  await prisma.agency.delete({ where: { id: agencyId } }).catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function createSale(overrides = {}) {
  const customer = await prisma.customer.create({ data: { firstName: 'Fin', lastName: `Sale${Date.now()}${Math.random()}` } });
  return prisma.sale.create({
    data: {
      agencyId, customerId: customer.id, firstName: 'Fin', lastName: 'Sale',
      saleDate: new Date('2026-02-01'), carrier: 'Allstate', policyType: 'Auto-Standard', productFamily: 'AUTO',
      premiumCents: 50000, assignedToId: producerId, createdById: ownerId, clientRequestId: `fin-test-${Date.now()}-${Math.random()}`,
      ...overrides,
    },
  });
}

test('GET /financials/by-agent: a Sale dated the 1st of the month is not dropped by a local-midnight-shifted from boundary', async () => {
  const sale = await createSale({ saleDate: new Date('2026-02-01') });

  // Same shape ClosedSalesPanel's/PerformanceLeaderboards' "This month"
  // preset would send for a US-timezone browser: local midnight on the
  // 1st, which as a raw UTC instant lands a few hours after UTC midnight.
  const params = `?agencyId=${agencyId}&from=${encodeURIComponent('2026-02-01T05:00:00.000Z')}&to=${encodeURIComponent('2026-02-28T23:59:59.999Z')}`;
  const res = await fetch(`${baseUrl}/api/financials/by-agent${params}`, { headers: { Cookie: ownerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();

  const row = body.agents.find((a) => a.userId === producerId);
  assert.ok(row, 'the producer must appear on the leaderboard');
  assert.equal(row.salesCount, 1, 'the Feb 1 sale must count toward this period, not be silently dropped');
  assert.equal(row.revenue, 500);

  await prisma.revenueEvent.deleteMany({ where: { saleId: sale.id } });
  await prisma.sale.delete({ where: { id: sale.id } });
});

test('GET /financials/by-agent: a Sale credited to someone outside the active roster gets its own real, named row, not an anonymous bucket', async () => {
  const sale = await createSale({ saleDate: new Date('2026-02-15'), assignedToId: deactivatedProducerId });

  const params = `?agencyId=${agencyId}&from=${encodeURIComponent('2026-02-01T00:00:00.000Z')}&to=${encodeURIComponent('2026-02-28T23:59:59.999Z')}`;
  const res = await fetch(`${baseUrl}/api/financials/by-agent${params}`, { headers: { Cookie: ownerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();

  const row = body.agents.find((a) => a.userId === deactivatedProducerId);
  assert.ok(row, 'a sale credited to a non-roster producer must still appear as its own row');
  assert.equal(row.firstName, 'Former');
  assert.equal(row.lastName, 'Rep');
  assert.equal(row.salesCount, 1);
  assert.equal(row.revenue, 500);
  assert.ok(!body.agents.some((a) => a.lastName === '(unattributed)'), 'the old anonymous bucket must never appear once every sale has a real named row');

  await prisma.revenueEvent.deleteMany({ where: { saleId: sale.id } });
  await prisma.sale.delete({ where: { id: sale.id } });
});
