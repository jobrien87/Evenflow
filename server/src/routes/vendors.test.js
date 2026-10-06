// Real-DB, real-HTTP test: PAID_AD/META_AD vendors can never be saved in
// MOSHPIT distribution mode — those leads must always be directly
// assigned, never left to sit unclaimed.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, ownerCookie, server, baseUrl;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Vendor Moshpit Test Agency ${suffix}` } });
  agencyId = agency.id;
  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `vm-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Vendor', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const session = await createSession(ownerId);
  ownerCookie = `evenflow_session=${session.rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.vendorCredential.deleteMany({ where: { vendor: { agencyId } } });
  await prisma.vendor.deleteMany({ where: { agencyId } });
  await prisma.session.deleteMany({ where: { userId: ownerId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('a PAID_AD vendor cannot be created with MOSHPIT distribution mode', async () => {
  const res = await fetch(`${baseUrl}/api/vendors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ name: 'Paid Ad Vendor', email: `pav-${suffix}@test.local`, product: 'Auto', category: 'PAID_AD', distributionMode: 'MOSHPIT' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'VALIDATION');

  const count = await prisma.vendor.count({ where: { agencyId, name: 'Paid Ad Vendor' } });
  assert.equal(count, 0, 'no vendor row should have been created');
});

test('a META_AD vendor cannot be created with MOSHPIT distribution mode', async () => {
  const res = await fetch(`${baseUrl}/api/vendors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ name: 'Meta Ad Vendor', email: `mav-${suffix}@test.local`, product: 'Auto', category: 'META_AD', distributionMode: 'MOSHPIT' }),
  });
  assert.equal(res.status, 400);
});

test('a PAID_AD vendor CAN be created with ROUND_ROBIN, and an existing OTHER vendor cannot be PATCHed to PAID_AD+MOSHPIT', async () => {
  const createRes = await fetch(`${baseUrl}/api/vendors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ name: 'Real Paid Ad Vendor', email: `realpav-${suffix}@test.local`, product: 'Auto', category: 'PAID_AD', distributionMode: 'ROUND_ROBIN' }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();

  // Now flip just distributionMode to MOSHPIT via PATCH, with category
  // already PAID_AD on the existing row (not in this PATCH body) — the
  // merged-value check must still catch it.
  const patchRes = await fetch(`${baseUrl}/api/vendors/${created.vendor.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ distributionMode: 'MOSHPIT' }),
  });
  assert.equal(patchRes.status, 400);
  const patchBody = await patchRes.json();
  assert.equal(patchBody.error, 'VALIDATION');

  const unchanged = await prisma.vendor.findUnique({ where: { id: created.vendor.id } });
  assert.equal(unchanged.distributionMode, 'ROUND_ROBIN', 'the rejected PATCH must not have taken effect');
});

test('a MOSHPIT vendor cannot be PATCHed to category PAID_AD while staying MOSHPIT', async () => {
  const createRes = await fetch(`${baseUrl}/api/vendors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ name: 'Internet Moshpit Vendor', email: `imv-${suffix}@test.local`, product: 'Auto', category: 'INTERNET', distributionMode: 'MOSHPIT' }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();

  const patchRes = await fetch(`${baseUrl}/api/vendors/${created.vendor.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ category: 'PAID_AD' }),
  });
  assert.equal(patchRes.status, 400);
});
