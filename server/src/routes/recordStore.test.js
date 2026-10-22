// Real-DB, real-HTTP tests for the Custom Builder ("Build Your Own")
// customer + admin routes — same harness as vendors.test.js, with
// lib/boberdoo.js monkey-patched per scenario like
// recordStoreProvisioning.test.js does, since the accept+provision path
// makes real external calls otherwise.
process.env.NODE_ENV = 'development';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const boberdoo = require('../lib/boberdoo');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, ownerCookie, platformOwnerId, platformOwnerCookie, templateId, server, baseUrl;

const originalBoberdoo = { ...boberdoo };
function resetBoberdoo() { Object.assign(boberdoo, originalBoberdoo); }
function fakeHappyBoberdoo() {
  boberdoo.isConfigured = () => true;
  boberdoo.createPartner = async () => ({ success: true, partnerId: `P-${Date.now()}` });
  boberdoo.setPartnerStatus = async () => ({ success: true });
  boberdoo.createFilterSet = async () => ({ success: true, filterSetId: `F-${Date.now()}` });
  boberdoo.setFilterSetStatus = async () => ({ success: true });
}

before(async () => {
  const agency = await prisma.agency.create({
    data: { name: `Custom Builder Test Agency ${suffix}`, address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' },
  });
  agencyId = agency.id;
  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `cb-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Custom', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE', phone: '5125551234' },
  });
  ownerId = owner.id;
  ownerCookie = `evenflow_session=${(await createSession(ownerId)).rawToken}`;

  const platformOwner = await prisma.user.create({
    data: { email: `cb-platform-${suffix}@test.local`, passwordHash: hash, firstName: 'Platform', lastName: 'Owner', role: 'PLATFORM_OWNER', status: 'ACTIVE' },
  });
  platformOwnerId = platformOwner.id;
  platformOwnerCookie = `evenflow_session=${(await createSession(platformOwnerId)).rawToken}`;

  const template = await prisma.recordStoreTemplate.create({
    data: { slug: `TEST_CUSTOM_BUILDER_ROUTE_${suffix}`, displayName: 'Build Your Own', productCategory: 'CUSTOM', leadType: 'INTERNET', isCustomBuilder: true },
  });
  templateId = template.id;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => { resetBoberdoo(); });

after(async () => {
  await prisma.recordStoreSubscription.deleteMany({ where: { agencyId } });
  await prisma.recordStoreCustomRequest.deleteMany({ where: { agencyId } });
  await prisma.recordStoreTemplate.delete({ where: { id: templateId } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, platformOwnerId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, platformOwnerId] } } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('GET /lead-types returns the curated 3-type list, no raw Boberdoo ids leaked', async () => {
  const res = await fetch(`${baseUrl}/api/record-store/lead-types`, { headers: { Cookie: ownerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  const labels = body.leadTypes.map((t) => t.label);
  assert.deepEqual(labels.sort(), ['Auto Insurance', 'Home Insurance', 'Life Insurance']);
  assert.ok(!('boberdooTypeId' in body.leadTypes[0]), 'the real TYPE id is never sent to the customer');
});

test('GET /sources falls back honestly (live: false) when Boberdoo is unreachable/unscoped', async () => {
  boberdoo.getVendorsAndSources = async () => ({ success: false, errorCode: 'PROVIDER_ERROR' });
  const res = await fetch(`${baseUrl}/api/record-store/sources?leadType=${encodeURIComponent('Auto Insurance')}`, { headers: { Cookie: ownerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.live, false);
  assert.ok(body.sources.length > 0);
});

test('POST /custom-requests validates leadTypeLabel against the curated list and rejects an invalid one', async () => {
  const res = await fetch(`${baseUrl}/api/record-store/custom-requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ leadTypeLabel: 'Mortgage', sources: ['Fidadto'], dailyLimit: 10 }),
  });
  assert.equal(res.status, 400);
});

test('a full custom request lifecycle: submit -> admin quote -> customer accepts -> provisions a real subscription', async () => {
  fakeHappyBoberdoo();

  const createRes = await fetch(`${baseUrl}/api/record-store/custom-requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ leadTypeLabel: 'Home Insurance', sources: ['Fidadto'], dailyLimit: 8 }),
  });
  assert.equal(createRes.status, 201);
  const request = (await createRes.json()).request;
  assert.equal(request.status, 'PENDING_REVIEW');

  // Not visible to another agency's owner.
  const listRes = await fetch(`${baseUrl}/api/record-store/custom-requests`, { headers: { Cookie: ownerCookie } });
  const owned = (await listRes.json()).requests;
  assert.ok(owned.some((r) => r.id === request.id));

  // A non-Platform-Owner cannot reach the admin surface at all.
  const adminAsOwnerRes = await fetch(`${baseUrl}/api/record-store/admin/custom-requests`, { headers: { Cookie: ownerCookie } });
  assert.equal(adminAsOwnerRes.status, 403);

  const quoteRes = await fetch(`${baseUrl}/api/record-store/admin/custom-requests/${request.id}/quote`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
    body: JSON.stringify({ quotedPriceCents: 800, boberdooTypeId: '21', decisionNotes: 'Approved' }),
  });
  assert.equal(quoteRes.status, 200);
  const quoted = (await quoteRes.json()).request;
  assert.equal(quoted.status, 'QUOTED');

  // A second quote attempt on an already-decided request is rejected.
  const reQuoteRes = await fetch(`${baseUrl}/api/record-store/admin/custom-requests/${request.id}/quote`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
    body: JSON.stringify({ quotedPriceCents: 900, boberdooTypeId: '21' }),
  });
  assert.equal(reQuoteRes.status, 409);

  const acceptRes = await fetch(`${baseUrl}/api/record-store/custom-requests/${request.id}/accept`, {
    method: 'POST', headers: { Cookie: ownerCookie },
  });
  assert.equal(acceptRes.status, 201);
  const subscription = (await acceptRes.json()).subscription;
  assert.equal(subscription.priceSnapshotCents, 800);
  assert.equal(subscription.dailyVolume, 8);

  const provisionRes = await fetch(`${baseUrl}/api/record-store/orders/${subscription.id}/provision`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: '{}',
  });
  assert.equal(provisionRes.status, 200);
  const provisioned = (await provisionRes.json()).subscription;
  assert.equal(provisioned.status, 'PENDING_FUNDING');
  assert.ok(provisioned.boberdooFilterSetId);

  const finalRequest = await prisma.recordStoreCustomRequest.findUnique({ where: { id: request.id } });
  assert.equal(finalRequest.status, 'CONVERTED');
  assert.equal(finalRequest.recordStoreSubscriptionId, subscription.id);
});

test('accepting a request that has not been quoted yet is rejected', async () => {
  const createRes = await fetch(`${baseUrl}/api/record-store/custom-requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ leadTypeLabel: 'Auto Insurance', sources: ['Fidadto'], dailyLimit: 5 }),
  });
  const request = (await createRes.json()).request;

  const acceptRes = await fetch(`${baseUrl}/api/record-store/custom-requests/${request.id}/accept`, {
    method: 'POST', headers: { Cookie: ownerCookie },
  });
  assert.equal(acceptRes.status, 409);
});

test('a custom request can be declined, and a declined request cannot later be accepted', async () => {
  const createRes = await fetch(`${baseUrl}/api/record-store/custom-requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ leadTypeLabel: 'Life Insurance', sources: ['Fidadto'], dailyLimit: 5 }),
  });
  const request = (await createRes.json()).request;

  const declineRes = await fetch(`${baseUrl}/api/record-store/admin/custom-requests/${request.id}/decline`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
    body: JSON.stringify({ decisionNotes: 'Not a fit right now' }),
  });
  assert.equal(declineRes.status, 200);
  const declined = (await declineRes.json()).request;
  assert.equal(declined.status, 'DECLINED');

  const acceptRes = await fetch(`${baseUrl}/api/record-store/custom-requests/${request.id}/accept`, {
    method: 'POST', headers: { Cookie: ownerCookie },
  });
  assert.equal(acceptRes.status, 409);
});
