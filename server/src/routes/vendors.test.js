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

// Covers the "After Hours Appts" source-setup requirement: the source
// classification/routing record can be created and is immediately real
// and usable, with zero VendorCredential row ever created — credential
// generation is a separate, explicitly-gated call.
test('deferCredential:true creates only the Vendor row — zero credentials, no email, and the record is immediately usable', async () => {
  const res = await fetch(`${baseUrl}/api/vendors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({
      name: 'After Hours Appts', email: 'josh@yield-marketing.com', product: 'General', category: 'OTHER',
      distributionMode: 'SELECTED_AGENTS', integrationType: 'APPOINTMENT_WEBHOOK',
      highLevelLocationId: 'QeKX5JBMkzbS89a21NNp', highLevelCalendarId: 'dMUoqFqTICQSgdTlWixO',
      deferCredential: true,
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.apiKey, null, 'no raw key may ever be returned for a deferred vendor');
  assert.equal(body.instructions, null);
  assert.equal(body.credentialDeferred, true);
  assert.equal(body.emailStatus, 'DEFERRED');
  assert.equal(body.vendor.integrationType, 'APPOINTMENT_WEBHOOK');
  assert.equal(body.vendor.highLevelLocationId, 'QeKX5JBMkzbS89a21NNp');

  const credCount = await prisma.vendorCredential.count({ where: { vendorId: body.vendor.id } });
  assert.equal(credCount, 0, 'deferCredential must create zero VendorCredential rows');

  // The source record is immediately real/usable regardless of the
  // missing credential — visible via GET /vendors/:id.
  const getRes = await fetch(`${baseUrl}/api/vendors/${body.vendor.id}`, { headers: { Cookie: ownerCookie } });
  assert.equal(getRes.status, 200);
  const getBody = await getRes.json();
  assert.equal(getBody.vendor.id, body.vendor.id);
  assert.equal(getBody.instructions.integrationType, 'APPOINTMENT_WEBHOOK', 'instructions must describe the appointment-webhook contract, not the lead-POST one, for this vendor');

  const auditRow = await prisma.auditEvent.findFirst({ where: { entityId: body.vendor.id, action: 'vendor.created' } });
  assert.ok(auditRow, 'vendor.created must still be audited even when credential issuance is deferred');
  const credentialAudit = await prisma.auditEvent.findFirst({ where: { entityId: body.vendor.id, action: 'vendor.credential_generated' } });
  assert.equal(credentialAudit, null, 'no credential_generated audit entry may exist until the separate generate-credential call');
});

test('POST /:id/generate-credential is the one place a credential is ever issued for a deferred vendor; a second call 409s', async () => {
  const createRes = await fetch(`${baseUrl}/api/vendors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ name: 'Deferred Cred Vendor', email: `dcv-${suffix}@test.local`, product: 'General', deferCredential: true }),
  });
  const created = await createRes.json();
  assert.equal(await prisma.vendorCredential.count({ where: { vendorId: created.vendor.id } }), 0);

  const genRes = await fetch(`${baseUrl}/api/vendors/${created.vendor.id}/generate-credential`, {
    method: 'POST', headers: { Cookie: ownerCookie },
  });
  assert.equal(genRes.status, 201);
  const genBody = await genRes.json();
  assert.ok(genBody.apiKey, 'a real raw key must be returned exactly once, here');
  assert.equal(await prisma.vendorCredential.count({ where: { vendorId: created.vendor.id } }), 1);

  const secondRes = await fetch(`${baseUrl}/api/vendors/${created.vendor.id}/generate-credential`, {
    method: 'POST', headers: { Cookie: ownerCookie },
  });
  assert.equal(secondRes.status, 409);
  assert.equal((await secondRes.json()).error, 'CREDENTIAL_ALREADY_EXISTS');
  assert.equal(await prisma.vendorCredential.count({ where: { vendorId: created.vendor.id } }), 1, 'the 409 must not create a second credential');
});
