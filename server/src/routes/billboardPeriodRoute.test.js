// Real-DB, real-HTTP test for GET /financials/billboard's new ?period=
// query param wiring — computeBillboardPeriod's own logic is already
// covered thoroughly by billboard.test.js; this just confirms the route
// itself correctly threads period/month/year through and falls back to
// the legacy granularity contract when no period is given.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, ownerCookie, server, port, baseUrl;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Billboard Period Route Test Agency ${suffix}` } });
  agencyId = agency.id;
  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `billboard-period-route-${suffix}@test.local`, passwordHash: hash, firstName: 'Route', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const { rawToken } = await createSession(ownerId);
  ownerCookie = `evenflow_session=${rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.session.deleteMany({ where: { userId: ownerId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function getBillboard(qs) {
  const res = await fetch(`${baseUrl}/api/financials/billboard?${qs}`, { headers: { Cookie: ownerCookie } });
  return { status: res.status, body: await res.json() };
}

test('no ?period= falls back to the legacy granularity contract, unchanged', async () => {
  const { status, body } = await getBillboard('granularity=month');
  assert.equal(status, 200);
  assert.equal(body.granularity, 'month');
  assert.ok(body.period && typeof body.period === 'object' && 'from' in body.period, 'legacy shape: period is a {from,to} object, not a string');
});

test('?period=week returns the new Eastern-time period shape', async () => {
  const { status, body } = await getBillboard('period=week');
  assert.equal(status, 200);
  assert.equal(body.period, 'week');
  assert.equal(body.timezone, 'America/New_York');
  assert.ok(body.periodLabel);
  assert.equal(body.series.length, 5);
});

test('?period=month defaults to the current month and includes availableMonths', async () => {
  const { status, body } = await getBillboard('period=month');
  assert.equal(status, 200);
  assert.equal(body.period, 'month');
  assert.ok(body.selectedMonth);
  assert.ok(Array.isArray(body.availableMonths));
  assert.equal(body.series.length, 0, 'month view has no trend series');
});

test('?period=month&month=YYYY-MM selects an explicit month', async () => {
  const { status, body } = await getBillboard('period=month&month=2026-01');
  assert.equal(status, 200);
  assert.equal(body.selectedMonth.year, 2026);
  assert.equal(body.selectedMonth.month, 1);
  assert.equal(body.periodLabel, 'January 2026');
});

test('?period=year defaults to the current year with 12 month buckets', async () => {
  const { status, body } = await getBillboard('period=year');
  assert.equal(status, 200);
  assert.equal(body.period, 'year');
  assert.ok(body.selectedYear);
  assert.equal(body.series.length, 12);
});

test('?period=all_years returns a real response shape', async () => {
  const { status, body } = await getBillboard('period=all_years');
  assert.equal(status, 200);
  assert.equal(body.period, 'all_years');
  assert.ok(Array.isArray(body.series));
});

test('an unrecognized ?period= value is treated the same as no period given — falls back to the legacy contract, not an error', async () => {
  const { status, body } = await getBillboard('period=not_a_real_period');
  assert.equal(status, 200);
  assert.equal(body.granularity, 'month', 'an unrecognized period value never reaches computeBillboardPeriod at all');
});
