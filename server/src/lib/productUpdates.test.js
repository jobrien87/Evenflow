// Real-DB tests for ED's "what's new" feed role-scoping (lib/productUpdates.js).
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { getRecentForRole } = require('./productUpdates');

const suffix = Date.now();
const createdIds = [];

async function makeUpdate({ title, audienceRoles = [], publishedAt }) {
  const row = await prisma.productUpdate.create({
    data: { title, body: `Body for ${title}`, audienceRoles, createdById: 'test', ...(publishedAt ? { publishedAt } : {}) },
  });
  createdIds.push(row.id);
  return row;
}

after(async () => {
  await prisma.productUpdate.deleteMany({ where: { id: { in: createdIds } } });
  await prisma.$disconnect();
});

test('an update with no audienceRoles is visible to every role', async () => {
  const update = await makeUpdate({ title: `Universal ${suffix}` });
  const forOwner = await getRecentForRole('AGENCY_OWNER', { limit: 50 });
  const forProducer = await getRecentForRole('PRODUCER', { limit: 50 });
  assert.ok(forOwner.some((u) => u.id === update.id));
  assert.ok(forProducer.some((u) => u.id === update.id));
});

test('an update scoped to specific roles is only visible to those roles', async () => {
  const update = await makeUpdate({ title: `Owners Only ${suffix}`, audienceRoles: ['AGENCY_OWNER', 'AGENCY_MANAGER'] });
  const forOwner = await getRecentForRole('AGENCY_OWNER', { limit: 50 });
  const forProducer = await getRecentForRole('PRODUCER', { limit: 50 });
  assert.ok(forOwner.some((u) => u.id === update.id));
  assert.ok(!forProducer.some((u) => u.id === update.id));
});

test('sinceDate narrows to updates published at or after that date', async () => {
  const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  const recent = new Date();
  const oldUpdate = await makeUpdate({ title: `Old ${suffix}`, publishedAt: past });
  const newUpdate = await makeUpdate({ title: `New ${suffix}`, publishedAt: recent });

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const results = await getRecentForRole('PLATFORM_OWNER', { sinceDate: since, limit: 50 });
  assert.ok(results.some((u) => u.id === newUpdate.id));
  assert.ok(!results.some((u) => u.id === oldUpdate.id));
});

test('results are newest-first and respect limit', async () => {
  const a = await makeUpdate({ title: `Order A ${suffix}`, publishedAt: new Date(Date.now() - 2000) });
  const b = await makeUpdate({ title: `Order B ${suffix}`, publishedAt: new Date(Date.now() - 1000) });
  const results = await getRecentForRole('PLATFORM_OWNER', { limit: 1 });
  assert.equal(results.length, 1);
  assert.notEqual(results[0].id, a.id, 'the older of the two must not win when limit=1');
  void b;
});
