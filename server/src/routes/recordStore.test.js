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
const provisioning = require('../lib/recordStoreProvisioning');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, ownerCookie, platformOwnerId, platformOwnerCookie, templateId, fixedTemplateId, fixedTemplate2Id, server, baseUrl;

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

  const fixedTemplate = await prisma.recordStoreTemplate.create({
    data: {
      slug: `TEST_FIXED_ROUTE_${suffix}`, displayName: 'Test Fixed Product', productCategory: 'AUTO', leadType: 'INTERNET',
      wholesalePriceCents: 2500, minimumDailyVolume: 1, maximumDailyVolume: 100, defaultDailyVolume: 10, minimumDepositCents: 150000,
    },
  });
  fixedTemplateId = fixedTemplate.id;

  const fixedTemplate2 = await prisma.recordStoreTemplate.create({
    data: {
      slug: `TEST_FIXED2_ROUTE_${suffix}`, displayName: 'Test Fixed Product Two', productCategory: 'HOME', leadType: 'INTERNET',
      wholesalePriceCents: 3000, minimumDailyVolume: 1, maximumDailyVolume: 100, defaultDailyVolume: 10, minimumDepositCents: 150000,
    },
  });
  fixedTemplate2Id = fixedTemplate2.id;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => { resetBoberdoo(); });

after(async () => {
  await prisma.recordStoreSubscription.deleteMany({ where: { agencyId } });
  await prisma.recordStoreCustomRequest.deleteMany({ where: { agencyId } });
  await prisma.recordStoreTemplate.deleteMany({ where: { id: { in: [templateId, fixedTemplateId, fixedTemplate2Id] } } });
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

// ---- Low-balance gate (POST /orders + custom-request accept) -----------

test('an agency\'s first-ever order is never blocked by balance, even if the check would otherwise fail', async () => {
  boberdoo.getPartnerBalance = async () => ({ success: false, errorCode: 'PROVIDER_ERROR' });
  const res = await fetch(`${baseUrl}/api/record-store/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ templateSlug: (await prisma.recordStoreTemplate.findUnique({ where: { id: fixedTemplateId } })).slug, dailyVolume: 10 }),
  });
  assert.equal(res.status, 201);
  const subscription = (await res.json()).subscription;

  await prisma.recordStoreSubscription.delete({ where: { id: subscription.id } });
});

test('once funded, ordering a genuinely new product type is blocked below $250, but re-ordering an existing one is not', async () => {
  fakeHappyBoberdoo();
  await prisma.agency.update({ where: { id: agencyId }, data: { recordStoreDepositConfirmedAt: new Date(), boberdooPartnerId: `P-balance-test-${suffix}` } });
  const fixedTemplate = await prisma.recordStoreTemplate.findUnique({ where: { id: fixedTemplateId } });
  const fixedTemplate2 = await prisma.recordStoreTemplate.findUnique({ where: { id: fixedTemplate2Id } });

  // Create the first product directly (bypassing the route) so "re-order"
  // below is testing against something that already genuinely exists.
  const existing = await prisma.recordStoreSubscription.create({
    data: {
      agencyId, recordStoreTemplateId: fixedTemplateId, productNameSnapshot: fixedTemplate.displayName,
      leadType: fixedTemplate.leadType, filterSetType: fixedTemplate.filterSetType, isIpr: false,
      priceSnapshotCents: fixedTemplate.wholesalePriceCents, dailyVolume: 10, status: 'ACTIVE', provisioningStatus: 'ACTIVE',
    },
  });

  boberdoo.getPartnerBalance = async () => ({ success: true, balanceCents: 10000, totalBalanceCents: 10000 });

  const newProductRes = await fetch(`${baseUrl}/api/record-store/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ templateSlug: fixedTemplate2.slug, dailyVolume: 10 }),
  });
  assert.equal(newProductRes.status, 409, 'a genuinely new product type must be blocked below the threshold');
  const newProductBody = await newProductRes.json();
  assert.equal(newProductBody.error, 'LOW_BALANCE');

  const reorderRes = await fetch(`${baseUrl}/api/record-store/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ templateSlug: fixedTemplate.slug, dailyVolume: 15 }),
  });
  assert.equal(reorderRes.status, 200, 'returning the existing subscription for a product already held must never be blocked');
  const reordered = (await reorderRes.json()).subscription;
  assert.equal(reordered.id, existing.id);

  await prisma.recordStoreSubscription.delete({ where: { id: existing.id } });
});

test('accepting a custom-request quote is also blocked below $250 once the agency has funded before', async () => {
  await prisma.agency.update({ where: { id: agencyId }, data: { recordStoreDepositConfirmedAt: new Date(), boberdooPartnerId: `P-balance-test2-${suffix}` } });
  boberdoo.getPartnerBalance = async () => ({ success: true, balanceCents: 5000, totalBalanceCents: 5000 });

  const createRes = await fetch(`${baseUrl}/api/record-store/custom-requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ leadTypeLabel: 'Auto Insurance', sources: ['Fidadto'], dailyLimit: 5 }),
  });
  const request = (await createRes.json()).request;
  await fetch(`${baseUrl}/api/record-store/admin/custom-requests/${request.id}/quote`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
    body: JSON.stringify({ quotedPriceCents: 600, boberdooTypeId: '23' }),
  });

  const acceptRes2 = await fetch(`${baseUrl}/api/record-store/custom-requests/${request.id}/accept`, {
    method: 'POST', headers: { Cookie: ownerCookie },
  });
  assert.equal(acceptRes2.status, 409);
  const body = await acceptRes2.json();
  assert.equal(body.error, 'LOW_BALANCE');

  const stillQuoted = await prisma.recordStoreCustomRequest.findUnique({ where: { id: request.id } });
  assert.equal(stillQuoted.status, 'QUOTED', 'a blocked accept must never convert the request or create a subscription');
});

// ---- Source performance / 30-day auto-optimization routes --------------

test('GET /subscriptions/:id/source-performance and PATCH /auto-optimize are scoped to the owning agency and real data', async () => {
  const sub = await prisma.recordStoreSubscription.create({
    data: {
      agencyId, recordStoreTemplateId: fixedTemplateId, productNameSnapshot: 'Perf Route Test',
      leadType: 'INTERNET', filterSetType: 'STANDARD', priceSnapshotCents: 500, dailyVolume: 20,
      status: 'ACTIVE', boberdooFilterSetId: `FS-PERF-ROUTE-${suffix}`,
    },
  });

  const forbiddenOwner = await prisma.user.create({
    data: { email: `cb-other-owner-${suffix}@test.local`, passwordHash: await bcrypt.hash('TestPass123!', 12), firstName: 'Other', lastName: 'Owner', role: 'AGENCY_OWNER', status: 'ACTIVE' },
  });
  const forbiddenOtherAgency = await prisma.agency.create({ data: { name: `Other Agency ${suffix}` } });
  await prisma.user.update({ where: { id: forbiddenOwner.id }, data: { agencyId: forbiddenOtherAgency.id } });
  const forbiddenCookie = `evenflow_session=${(await createSession(forbiddenOwner.id)).rawToken}`;

  const forbiddenRes = await fetch(`${baseUrl}/api/record-store/subscriptions/${sub.id}/source-performance`, { headers: { Cookie: forbiddenCookie } });
  assert.equal(forbiddenRes.status, 403, 'a different agency must never see this subscription\'s performance');

  const perfRes = await fetch(`${baseUrl}/api/record-store/subscriptions/${sub.id}/source-performance`, { headers: { Cookie: ownerCookie } });
  assert.equal(perfRes.status, 200);
  const perfBody = await perfRes.json();
  assert.equal(perfBody.performance.subscription.id, sub.id);
  assert.equal(perfBody.autoOptimizeSources, true, 'on by default');
  assert.deepEqual(perfBody.history, []);

  const toggleRes = await fetch(`${baseUrl}/api/record-store/subscriptions/${sub.id}/auto-optimize`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ autoOptimizeSources: false }),
  });
  assert.equal(toggleRes.status, 200);
  assert.equal((await toggleRes.json()).subscription.autoOptimizeSources, false);

  const forbiddenToggle = await fetch(`${baseUrl}/api/record-store/subscriptions/${sub.id}/auto-optimize`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: forbiddenCookie },
    body: JSON.stringify({ autoOptimizeSources: true }),
  });
  assert.equal(forbiddenToggle.status, 403);

  await prisma.recordStoreSubscription.delete({ where: { id: sub.id } });
  await prisma.session.deleteMany({ where: { userId: forbiddenOwner.id } });
  await prisma.user.delete({ where: { id: forbiddenOwner.id } });
  await prisma.agency.delete({ where: { id: forbiddenOtherAgency.id } });
});

test('GET /admin/source-optimizations is Platform-Owner-only and returns decoded source labels', async () => {
  const sub = await prisma.recordStoreSubscription.create({
    data: {
      agencyId, recordStoreTemplateId: fixedTemplateId, productNameSnapshot: 'Admin Opt Route Test',
      leadType: 'INTERNET', filterSetType: 'STANDARD', priceSnapshotCents: 500, dailyVolume: 20,
      status: 'ACTIVE', boberdooFilterSetId: `FS-ADMIN-OPT-${suffix}`,
    },
  });
  const run = await prisma.recordStoreSourceOptimization.create({
    data: {
      recordStoreSubscriptionId: sub.id, windowStart: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), windowEnd: new Date(),
      previousSources: ['Fidadto', 'Quoting_Fast'], newSources: ['Fidadto'], droppedSources: ['Quoting_Fast'],
      reasoning: 'test reasoning', performanceSnapshot: [], status: 'APPLIED',
    },
  });

  const forbiddenRes = await fetch(`${baseUrl}/api/record-store/admin/source-optimizations`, { headers: { Cookie: ownerCookie } });
  assert.equal(forbiddenRes.status, 403);

  const res = await fetch(`${baseUrl}/api/record-store/admin/source-optimizations`, { headers: { Cookie: platformOwnerCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  const found = body.runs.find((r) => r.id === run.id);
  assert.ok(found);
  assert.deepEqual(found.droppedSourceLabels, ['EvenFlow B']);
  assert.equal(found.subscription.agencyId, agencyId);

  await prisma.recordStoreSourceOptimization.delete({ where: { id: run.id } });
  await prisma.recordStoreSubscription.delete({ where: { id: sub.id } });
});

// ---- Import an existing (pre-EvenFlow) Boberdoo filter set --------------

test('POST /admin/agencies/:id/import-filter-set is Platform-Owner-only and pulls the real filter set config', async () => {
  const importAgency = await prisma.agency.create({ data: { name: `Import Route Test Agency ${suffix}`, boberdooPartnerId: `P-route-import-${suffix}` } });
  try {
    const forbiddenRes = await fetch(`${baseUrl}/api/record-store/admin/agencies/${importAgency.id}/import-filter-set`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ boberdooFilterSetId: `FS-route-${suffix}` }),
    });
    assert.equal(forbiddenRes.status, 403);

    boberdoo.getFilterSet = async (filterSetId) => ({
      success: true,
      data: { Filter_Set_ID: filterSetId, Filter_Set_Name: 'Route Test Filter', Filter_Set_Price: 6, Daily_Limit: 20, TYPE: 21, Accepted_Sources: 'Fidadto' },
    });

    const res = await fetch(`${baseUrl}/api/record-store/admin/agencies/${importAgency.id}/import-filter-set`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
      body: JSON.stringify({ boberdooFilterSetId: `FS-route-${suffix}` }),
    });
    assert.equal(res.status, 201);
    const created = (await res.json()).subscription;
    assert.equal(created.priceSnapshotCents, 600);
    assert.equal(created.status, 'ACTIVE');

    const dupRes = await fetch(`${baseUrl}/api/record-store/admin/agencies/${importAgency.id}/import-filter-set`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
      body: JSON.stringify({ boberdooFilterSetId: `FS-route-${suffix}` }),
    });
    assert.equal(dupRes.status, 409);
    assert.equal((await dupRes.json()).error, 'ALREADY_IMPORTED');

    await prisma.recordStoreSubscription.delete({ where: { id: created.id } });
  } finally {
    await prisma.agency.delete({ where: { id: importAgency.id } });
  }
});

// ---- Reset an agency's Record Store data to a never-purchased state -----

test('GET/POST .../reset-record-store are Platform-Owner-only, require an exact agency-name confirm, and succeed with real counts', async () => {
  const resetAgency = await prisma.agency.create({ data: { name: `Reset Route Test Agency ${suffix}`, address: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' } });
  const resetOwner = await prisma.user.create({
    data: { email: `reset-owner-${suffix}@test.local`, passwordHash: await bcrypt.hash('TestPass123!', 12), firstName: 'Reset', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId: resetAgency.id, status: 'ACTIVE', phone: '5125551234' },
  });
  try {
    fakeHappyBoberdoo();
    const template = await prisma.recordStoreTemplate.findUnique({ where: { id: fixedTemplateId } });
    const { subscription } = await provisioning.createOrder({ agencyId: resetAgency.id, template, dailyVolume: 10, userId: resetOwner.id });
    await provisioning.provisionSubscription(subscription.id);

    const forbiddenPreview = await fetch(`${baseUrl}/api/record-store/admin/agencies/${resetAgency.id}/reset-record-store-preview`, { headers: { Cookie: ownerCookie } });
    assert.equal(forbiddenPreview.status, 403);

    const previewRes = await fetch(`${baseUrl}/api/record-store/admin/agencies/${resetAgency.id}/reset-record-store-preview`, { headers: { Cookie: platformOwnerCookie } });
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json();
    assert.equal(preview.agency.name, resetAgency.name);
    assert.equal(preview.ownerEmail, resetOwner.email);
    assert.equal(preview.counts.subscriptions, 1);

    const forbiddenReset = await fetch(`${baseUrl}/api/record-store/admin/agencies/${resetAgency.id}/reset-record-store`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({ confirmText: resetAgency.name }),
    });
    assert.equal(forbiddenReset.status, 403);

    const wrongNameRes = await fetch(`${baseUrl}/api/record-store/admin/agencies/${resetAgency.id}/reset-record-store`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
      body: JSON.stringify({ confirmText: 'not the right name' }),
    });
    assert.equal(wrongNameRes.status, 400);
    assert.equal((await wrongNameRes.json()).error, 'CONFIRMATION_MISMATCH');
    assert.ok(await prisma.recordStoreSubscription.findUnique({ where: { id: subscription.id } }), 'a failed confirm must make zero changes');

    const resetRes = await fetch(`${baseUrl}/api/record-store/admin/agencies/${resetAgency.id}/reset-record-store`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
      body: JSON.stringify({ confirmText: resetAgency.name }),
    });
    assert.equal(resetRes.status, 200);
    const resetBody = await resetRes.json();
    assert.equal(resetBody.wipedCounts.subscriptions, 1);
    assert.equal(await prisma.recordStoreSubscription.findUnique({ where: { id: subscription.id } }), null);

    const customersRes = await fetch(`${baseUrl}/api/record-store/admin/customers`, { headers: { Cookie: platformOwnerCookie } });
    const customers = (await customersRes.json()).agencies;
    assert.equal(customers.some((a) => a.id === resetAgency.id), false, 'an agency with zero subscriptions after reset drops out of the customers list');
  } finally {
    await prisma.recordStoreSubscription.deleteMany({ where: { agencyId: resetAgency.id } });
    await prisma.user.delete({ where: { id: resetOwner.id } });
    await prisma.agency.delete({ where: { id: resetAgency.id } });
  }
});
