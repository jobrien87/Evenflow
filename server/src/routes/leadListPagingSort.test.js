// Real-database, real-HTTP test for GET /api/leads paging, leadType filter
// and sort, and GET /api/sales producer scoping.
//
//   node --test src/routes/leadListPagingSort.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, producerId, producer2Id, producerCookie, ownerCookie;
let server, baseUrl;
const customerIds = [];

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Paging Test Agency ${suffix}` } });
  agencyId = agency.id;
  const hash = await bcrypt.hash('TestPass123!', 12);
  const mk = (key, role, last) => prisma.user.create({
    data: { email: `paging-${key}-${suffix}@test.local`, passwordHash: hash, firstName: 'Paging', lastName: last, role, agencyId, status: 'ACTIVE' },
  });
  const owner = await mk('owner', 'AGENCY_OWNER', 'Owner');
  const producer = await mk('p1', 'PRODUCER', 'One');
  const producer2 = await mk('p2', 'PRODUCER', 'Two');
  ownerId = owner.id; producerId = producer.id; producer2Id = producer2.id;
  ownerCookie = `evenflow_session=${(await createSession(ownerId)).rawToken}`;
  producerCookie = `evenflow_session=${(await createSession(producerId)).rawToken}`;

  // 30 leads for producer 1 (20 WINBACK, 6 TRANSFER, 4 REFERRAL), 3 for producer 2.
  const plan = [
    ...Array(20).fill(['WINBACK', producerId]),
    ...Array(6).fill(['TRANSFER', producerId]),
    ...Array(4).fill(['REFERRAL', producerId]),
    ...Array(3).fill(['TRANSFER', producer2Id]),
  ];
  for (const [i, [leadType, assignedToId]] of plan.entries()) {
    const c = await prisma.customer.create({ data: { firstName: 'Page', lastName: `L${suffix}-${i}` } });
    customerIds.push(c.id);
    await prisma.lead.create({
      data: { agencyId, customerId: c.id, source: 'manual', status: 'NEW', product: 'Auto', leadType, createdById: ownerId, assignedToId },
    });
  }
  const saleCustomer = await prisma.customer.create({ data: { firstName: 'Other', lastName: `Sale${suffix}` } });
  customerIds.push(saleCustomer.id);
  const mkSale = (assignedToId) => prisma.sale.create({
    data: { agencyId, customerId: saleCustomer.id, assignedToId, firstName: 'Other', lastName: 'Sale', carrier: 'X', policyType: 'Auto', productFamily: 'AUTO', premiumCents: 1000, items: 1, saleDate: new Date(), createdById: ownerId },
  });
  await mkSale(producer2Id);
  await mkSale(producerId);

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await prisma.sale.deleteMany({ where: { agencyId } });
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, producerId, producer2Id] } } });
  await prisma.user.deleteMany({ where: { agencyId } });
  await prisma.agency.deleteMany({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

const get = async (path, cookie) => (await fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie } })).json();

test('producer sees total of only their own leads and can page through all of them', async () => {
  const p1 = await get('/api/leads?pageSize=25&page=1', producerCookie);
  assert.equal(p1.total, 30);
  assert.equal(p1.leads.length, 25);
  const p2 = await get('/api/leads?pageSize=25&page=2', producerCookie);
  assert.equal(p2.leads.length, 5);
  const ids = new Set([...p1.leads, ...p2.leads].map((l) => l.id));
  assert.equal(ids.size, 30, 'no overlap/gaps between pages');
  assert.ok([...p1.leads, ...p2.leads].every((l) => l.assignedToId === producerId));
});

test('leadType filter narrows total; unknown type is ignored, not injected', async () => {
  const t = await get('/api/leads?leadType=TRANSFER', producerCookie);
  assert.equal(t.total, 6);
  assert.ok(t.leads.every((l) => l.leadType === 'TRANSFER'));
  const bogus = await get('/api/leads?leadType=NOPE', producerCookie);
  assert.equal(bogus.total, 30);
});

test('sort=type groups by lead type; unknown sort falls back safely', async () => {
  const body = await get('/api/leads?sort=type&pageSize=100', producerCookie);
  const types = body.leads.map((l) => l.leadType);
  // Postgres orders enums by declaration order: TRANSFER, REFERRAL, ... WINBACK.
  assert.deepEqual([...new Set(types)], ['TRANSFER', 'REFERRAL', 'WINBACK']);
  const bogus = await get('/api/leads?sort=passwordHash&pageSize=100', producerCookie);
  assert.equal(bogus.total, 30);
});

test('owner sees whole agency count', async () => {
  const body = await get('/api/leads?pageSize=1', ownerCookie);
  assert.equal(body.total, 33);
});

test('a producer cannot widen sales scope with assignedToId', async () => {
  const body = await get(`/api/sales?assignedToId=${producer2Id}`, producerCookie);
  assert.equal(body.sales.length, 1);
  assert.ok(body.sales.every((s) => s.assignedToId === producerId));
  assert.equal(await prisma.sale.count({ where: { agencyId } }), 2, 'the other producer sale exists');
});
