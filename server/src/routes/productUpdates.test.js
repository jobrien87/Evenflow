// Real-DB, real-HTTP tests for Platform-Owner CRUD on ED's "what's new"
// feed (ProductUpdate), same harness as recordStore.test.js.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let ownerId, ownerCookie, platformOwnerId, platformOwnerCookie, server, baseUrl;
const createdUpdateIds = [];

before(async () => {
  const hash = await bcrypt.hash('TestPass123!', 12);
  const agency = await prisma.agency.create({ data: { name: `Product Updates Test Agency ${suffix}` } });

  const owner = await prisma.user.create({
    data: { email: `pu-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'PU', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId: agency.id, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  ownerCookie = `evenflow_session=${(await createSession(ownerId)).rawToken}`;

  const platformOwner = await prisma.user.create({
    data: { email: `pu-platform-${suffix}@test.local`, passwordHash: hash, firstName: 'PU', lastName: 'Platform', role: 'PLATFORM_OWNER', status: 'ACTIVE' },
  });
  platformOwnerId = platformOwner.id;
  platformOwnerCookie = `evenflow_session=${(await createSession(platformOwnerId)).rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await prisma.productUpdate.deleteMany({ where: { id: { in: createdUpdateIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, platformOwnerId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, platformOwnerId] } } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('every route is Platform-Owner-only', async () => {
  const getRes = await fetch(`${baseUrl}/api/product-updates`, { headers: { Cookie: ownerCookie } });
  assert.equal(getRes.status, 403);

  const postRes = await fetch(`${baseUrl}/api/product-updates`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ title: 'x', body: 'y' }),
  });
  assert.equal(postRes.status, 403);
});

test('POST creates a real update visible via GET, PATCH edits it, DELETE removes it', async () => {
  const createRes = await fetch(`${baseUrl}/api/product-updates`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
    body: JSON.stringify({ title: 'Record Store launched', body: 'Buy wholesale leads right from EvenFlow.', audienceRoles: ['AGENCY_OWNER'] }),
  });
  assert.equal(createRes.status, 201);
  const created = (await createRes.json()).update;
  createdUpdateIds.push(created.id);
  assert.equal(created.title, 'Record Store launched');
  assert.deepEqual(created.audienceRoles, ['AGENCY_OWNER']);

  const listRes = await fetch(`${baseUrl}/api/product-updates`, { headers: { Cookie: platformOwnerCookie } });
  const list = (await listRes.json()).updates;
  assert.ok(list.some((u) => u.id === created.id));

  const patchRes = await fetch(`${baseUrl}/api/product-updates/${created.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
    body: JSON.stringify({ title: 'Record Store is live' }),
  });
  assert.equal(patchRes.status, 200);
  assert.equal((await patchRes.json()).update.title, 'Record Store is live');

  const deleteRes = await fetch(`${baseUrl}/api/product-updates/${created.id}`, { method: 'DELETE', headers: { Cookie: platformOwnerCookie } });
  assert.equal(deleteRes.status, 200);

  const afterDelete = await prisma.productUpdate.findUnique({ where: { id: created.id } });
  assert.equal(afterDelete, null);
  createdUpdateIds.splice(createdUpdateIds.indexOf(created.id), 1);
});

test('POST rejects an invalid audienceRoles value (never a freeform string)', async () => {
  const res = await fetch(`${baseUrl}/api/product-updates`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
    body: JSON.stringify({ title: 'x', body: 'y', audienceRoles: ['NOT_A_REAL_ROLE'] }),
  });
  assert.equal(res.status, 400);
});

test('PATCH/DELETE on a nonexistent update return 404', async () => {
  const fakeId = '00000000-0000-0000-0000-000000000000';
  const patchRes = await fetch(`${baseUrl}/api/product-updates/${fakeId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
    body: JSON.stringify({ title: 'x' }),
  });
  assert.equal(patchRes.status, 404);

  const deleteRes = await fetch(`${baseUrl}/api/product-updates/${fakeId}`, { method: 'DELETE', headers: { Cookie: platformOwnerCookie } });
  assert.equal(deleteRes.status, 404);
});
