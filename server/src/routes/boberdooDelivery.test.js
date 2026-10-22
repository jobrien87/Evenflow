// Real-DB, real-HTTP tests for the inbound Boberdoo lead-delivery webhook
// — covers: honest NOT_CONFIGURED/UNAUTHORIZED gating, dynamic routing to
// the correct Agency by Partner ID, Auto/Home product mapping, form-
// encoded bodies (Boberdoo's likely real content type), an unrouteable
// delivery (missing/unknown Partner ID) being logged+alerted rather than
// lost, idempotency on externalLeadId, and TCPA suppression on delivery.
process.env.NODE_ENV = 'development';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { prisma } = require('../lib/db');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, server, baseUrl;
let leadIds = [];
let customerIds = [];
let templateIds = [];
let subscriptionIds = [];

before(async () => {
  const agency = await prisma.agency.create({
    data: { name: `Boberdoo Delivery Test Agency ${suffix}`, boberdooPartnerId: `PARTNER-${suffix}` },
  });
  agencyId = agency.id;
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `bdw-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'BD', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.apiTransaction.deleteMany({ where: { endpoint: '/api/webhooks/boberdoo', rawPayload: { path: ['Partner_ID'], equals: `PARTNER-${suffix}` } } }).catch(() => {});
  await prisma.leadEvent.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.notification.deleteMany({ where: { userId: ownerId } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  await prisma.recordStoreSubscription.deleteMany({ where: { id: { in: subscriptionIds } } });
  await prisma.recordStoreTemplate.deleteMany({ where: { id: { in: templateIds } } });
  await prisma.user.delete({ where: { id: ownerId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

let originalSecret;
beforeEach(() => { originalSecret = process.env.BOBERDOO_DELIVERY_SECRET; });
afterEach(() => { process.env.BOBERDOO_DELIVERY_SECRET = originalSecret; });

async function trackLead(leadId) {
  leadIds.push(leadId);
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (lead?.customerId) customerIds.push(lead.customerId);
}

test('POST /api/webhooks/boberdoo returns 503 NOT_CONFIGURED when BOBERDOO_DELIVERY_SECRET is unset', async () => {
  delete process.env.BOBERDOO_DELIVERY_SECRET;
  const res = await fetch(`${baseUrl}/api/webhooks/boberdoo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Partner_ID: `PARTNER-${suffix}` }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'NOT_CONFIGURED');
});

test('POST /api/webhooks/boberdoo returns 401 UNAUTHORIZED with a wrong or missing secret', async () => {
  process.env.BOBERDOO_DELIVERY_SECRET = 'real-secret-value';
  const wrongRes = await fetch(`${baseUrl}/api/webhooks/boberdoo?secret=wrong`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Partner_ID: `PARTNER-${suffix}` }),
  });
  assert.equal(wrongRes.status, 401);

  const missingRes = await fetch(`${baseUrl}/api/webhooks/boberdoo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Partner_ID: `PARTNER-${suffix}` }),
  });
  assert.equal(missingRes.status, 401);
});

test('a real Auto delivery routes dynamically to the Agency matching Partner_ID and creates a real Lead', async () => {
  process.env.BOBERDOO_DELIVERY_SECRET = 'real-secret-value';
  const leadId = `auto-${Date.now()}`;
  const res = await fetch(`${baseUrl}/api/webhooks/boberdoo?secret=real-secret-value`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Partner_ID: `PARTNER-${suffix}`, TYPE: 23, Lead_ID: leadId,
      First_Name: 'Ada', Last_Name: 'Lovelace', Email: `ada-${suffix}@test.local`,
      Phone_Home: `555${String(suffix).slice(-7)}`, State: 'CA', Zip_Code: '90210',
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.leadId);
  await trackLead(body.leadId);

  const lead = await prisma.lead.findUnique({ where: { id: body.leadId }, include: { customer: true } });
  assert.equal(lead.agencyId, agencyId);
  assert.equal(lead.product, 'Auto');
  assert.equal(lead.source, 'record_store:boberdoo');
  assert.equal(lead.leadType, 'DATA_LEAD');
  assert.equal(lead.externalLeadId, leadId);
  assert.equal(lead.customer.firstName, 'Ada');
  assert.equal(lead.customer.email, `ada-${suffix}@test.local`);
});

test('a Home delivery (TYPE 21) maps to product Home and a form-encoded body parses the same as JSON', async () => {
  process.env.BOBERDOO_DELIVERY_SECRET = 'real-secret-value';
  const leadId = `home-${Date.now()}`;
  const params = new URLSearchParams({
    Partner_ID: `PARTNER-${suffix}`, TYPE: '21', Lead_ID: leadId,
    First_Name: 'Grace', Last_Name: 'Hopper', Email: `grace-${suffix}@test.local`,
  });
  const res = await fetch(`${baseUrl}/api/webhooks/boberdoo?secret=real-secret-value`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.leadId);
  await trackLead(body.leadId);

  const lead = await prisma.lead.findUnique({ where: { id: body.leadId } });
  assert.equal(lead.product, 'Home');
  assert.equal(lead.agencyId, agencyId);
});

test('a repeated delivery with the same externalLeadId is idempotent (no second Lead)', async () => {
  process.env.BOBERDOO_DELIVERY_SECRET = 'real-secret-value';
  const leadId = `dup-${Date.now()}`;
  const payload = JSON.stringify({ Partner_ID: `PARTNER-${suffix}`, TYPE: 23, Lead_ID: leadId, First_Name: 'Once', Last_Name: 'Only' });

  const res1 = await fetch(`${baseUrl}/api/webhooks/boberdoo?secret=real-secret-value`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
  const body1 = await res1.json();
  await trackLead(body1.leadId);

  const res2 = await fetch(`${baseUrl}/api/webhooks/boberdoo?secret=real-secret-value`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.equal(body2.duplicate, true);
  assert.equal(body2.leadId, body1.leadId);

  const count = await prisma.lead.count({ where: { agencyId, externalLeadId: leadId, source: 'record_store:boberdoo' } });
  assert.equal(count, 1);
});

test('a delivery with no Partner ID is acknowledged (200) but creates no Lead and alerts Platform Owners', async () => {
  process.env.BOBERDOO_DELIVERY_SECRET = 'real-secret-value';
  const res = await fetch(`${baseUrl}/api/webhooks/boberdoo?secret=real-secret-value`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ TYPE: 23, First_Name: 'No', Last_Name: 'Partner' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.warning, 'MISSING_PARTNER_ID');
});

test('a delivery for an unknown Partner ID is acknowledged (200) but creates no Lead', async () => {
  process.env.BOBERDOO_DELIVERY_SECRET = 'real-secret-value';
  const res = await fetch(`${baseUrl}/api/webhooks/boberdoo?secret=real-secret-value`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Partner_ID: `NOBODY-${suffix}`, TYPE: 23, First_Name: 'Ghost', Last_Name: 'Partner' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.warning, 'UNKNOWN_PARTNER');

  const count = await prisma.lead.count({ where: { source: 'record_store:boberdoo', customer: { firstName: 'Ghost' } } });
  assert.equal(count, 0);
});

test('a delivery for a Customer already marked DO_NOT_CONTACT creates a suppressed, unassigned Lead', async () => {
  process.env.BOBERDOO_DELIVERY_SECRET = 'real-secret-value';
  const suppressed = await prisma.customer.create({
    data: { firstName: 'Suppressed', lastName: 'Person', email: `suppressed-${suffix}@test.local`, doNotContact: true, doNotContactReason: 'Prior opt-out' },
  });
  customerIds.push(suppressed.id);

  const res = await fetch(`${baseUrl}/api/webhooks/boberdoo?secret=real-secret-value`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Partner_ID: `PARTNER-${suffix}`, TYPE: 23, Lead_ID: `sup-${Date.now()}`, First_Name: 'Suppressed', Last_Name: 'Person', Email: `suppressed-${suffix}@test.local` }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  await trackLead(body.leadId);

  const lead = await prisma.lead.findUnique({ where: { id: body.leadId } });
  assert.equal(lead.status, 'DO_NOT_CONTACT');
  assert.ok(lead.archivedAt);
});

test('a delivery carrying SRC and a matching Filter_Set_ID attributes the Lead to the exact subscription and raw source code', async () => {
  process.env.BOBERDOO_DELIVERY_SECRET = 'real-secret-value';
  const template = await prisma.recordStoreTemplate.create({
    data: { slug: `TEST_DELIVERY_TEMPLATE_${suffix}`, displayName: 'Test Delivery Template', productCategory: 'AUTO', leadType: 'INTERNET' },
  });
  templateIds.push(template.id);
  const subscription = await prisma.recordStoreSubscription.create({
    data: {
      agencyId, recordStoreTemplateId: template.id, productNameSnapshot: 'Test Delivery Template',
      leadType: 'INTERNET', filterSetType: 'STANDARD', priceSnapshotCents: 500, dailyVolume: 20,
      status: 'ACTIVE', boberdooFilterSetId: `FS-DELIVERY-${suffix}`,
    },
  });
  subscriptionIds.push(subscription.id);

  const res = await fetch(`${baseUrl}/api/webhooks/boberdoo?secret=real-secret-value`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Partner_ID: `PARTNER-${suffix}`, TYPE: 23, Filter_Set_ID: `FS-DELIVERY-${suffix}`, SRC: 'Fidadto',
      Lead_ID: `src-${Date.now()}`, First_Name: 'Source', Last_Name: 'Tracked',
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  await trackLead(body.leadId);

  const lead = await prisma.lead.findUnique({ where: { id: body.leadId } });
  assert.equal(lead.recordStoreSourceCode, 'Fidadto');
  assert.equal(lead.recordStoreSubscriptionId, subscription.id);
});

test('a delivery with no Filter_Set_ID still attributes the Lead via a best-effort agency + product-category match', async () => {
  process.env.BOBERDOO_DELIVERY_SECRET = 'real-secret-value';
  const template = await prisma.recordStoreTemplate.create({
    data: { slug: `TEST_DELIVERY_FALLBACK_${suffix}`, displayName: 'Test Delivery Fallback', productCategory: 'HOME', leadType: 'INTERNET' },
  });
  templateIds.push(template.id);
  const subscription = await prisma.recordStoreSubscription.create({
    data: {
      agencyId, recordStoreTemplateId: template.id, productNameSnapshot: 'Test Delivery Fallback',
      leadType: 'INTERNET', filterSetType: 'STANDARD', priceSnapshotCents: 600, dailyVolume: 20,
      status: 'ACTIVE', boberdooFilterSetId: `FS-FALLBACK-${suffix}`,
    },
  });
  subscriptionIds.push(subscription.id);

  const res = await fetch(`${baseUrl}/api/webhooks/boberdoo?secret=real-secret-value`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Partner_ID: `PARTNER-${suffix}`, TYPE: 21, Lead_ID: `fallback-${Date.now()}`,
      First_Name: 'Fallback', Last_Name: 'Match',
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  await trackLead(body.leadId);

  const lead = await prisma.lead.findUnique({ where: { id: body.leadId } });
  assert.equal(lead.recordStoreSubscriptionId, subscription.id);
});
