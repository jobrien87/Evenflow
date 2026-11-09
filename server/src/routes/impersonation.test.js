// Real-database, real-HTTP test for Platform Owner "Log in as" / support
// impersonation (routes/impersonation.js, middleware/auth.js's attachUser,
// lib/requestContext.js + lib/audit.js's recordAudit) —
//   DATABASE_URL=postgresql://... node --test src/routes/impersonation.test.js
//
// Covers: only a Platform Owner may search/start/end a view-as session; a
// Platform Owner cannot impersonate another Platform Owner or a deactivated
// user; GET /agencies/status reflects isImpersonating + viewingAs correctly;
// an ordinary mutation performed WHILE impersonating is audited under the
// target's own identity (so every existing audit reader is unaffected) but
// is also tagged metadata.impersonatedBy with the real Platform Owner's
// identity — the "Admin Activity" tracking guarantee — with zero changes
// needed at the mutation route itself; impersonating locks the Platform
// Owner OUT of Platform-Owner-only routes, since the effective role is the
// target's; and ending the view clears the impersonation cookie without
// touching the Platform Owner's own real session.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, ownerCookie, platformOwnerId, platformOwnerCookie, otherPlatformOwnerId, deactivatedUserId;
let server, baseUrl;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Impersonation Test Agency ${suffix}` } });
  agencyId = agency.id;
  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `imp-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Imp', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  ownerCookie = `evenflow_session=${(await createSession(ownerId)).rawToken}`;

  const platformOwner = await prisma.user.create({
    data: { email: `imp-po-${suffix}@test.local`, passwordHash: hash, firstName: 'Imp', lastName: 'Platform', role: 'PLATFORM_OWNER', status: 'ACTIVE' },
  });
  platformOwnerId = platformOwner.id;
  platformOwnerCookie = `evenflow_session=${(await createSession(platformOwnerId)).rawToken}`;

  const otherPlatformOwner = await prisma.user.create({
    data: { email: `imp-po2-${suffix}@test.local`, passwordHash: hash, firstName: 'Other', lastName: 'Platform', role: 'PLATFORM_OWNER', status: 'ACTIVE' },
  });
  otherPlatformOwnerId = otherPlatformOwner.id;

  const deactivatedUser = await prisma.user.create({
    data: { email: `imp-deactivated-${suffix}@test.local`, passwordHash: hash, firstName: 'Gone', lastName: 'User', role: 'PRODUCER', agencyId, status: 'DEACTIVATED' },
  });
  deactivatedUserId = deactivatedUser.id;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await prisma.auditEvent.deleteMany({ where: { agencyId } });
  await prisma.impersonationLog.deleteMany({ where: { platformOwnerId: { in: [platformOwnerId, otherPlatformOwnerId] } } });
  await prisma.sale.deleteMany({ where: { agencyId } });
  await prisma.revenueEvent.deleteMany({ where: { agencyId } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, platformOwnerId, otherPlatformOwnerId, deactivatedUserId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, platformOwnerId, otherPlatformOwnerId, deactivatedUserId] } } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function startImpersonation(targetUserId) {
  const res = await fetch(`${baseUrl}/api/impersonation/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
    body: JSON.stringify({ targetUserId }),
  });
  const data = await res.json();
  if (res.status !== 201) return { status: res.status, data, cookie: null };
  const log = await prisma.impersonationLog.findFirst({ where: { platformOwnerId, targetUserId }, orderBy: { startedAt: 'desc' } });
  return { status: res.status, data, cookie: `${platformOwnerCookie}; evenflow_impersonation=${log.id}`, logId: log.id };
}

test('only a Platform Owner can search for or start a view-as session', async () => {
  const searchRes = await fetch(`${baseUrl}/api/impersonation/search-users?q=Imp`, { headers: { Cookie: ownerCookie } });
  assert.equal(searchRes.status, 403);

  const startRes = await fetch(`${baseUrl}/api/impersonation/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ targetUserId: ownerId }),
  });
  assert.equal(startRes.status, 403);
});

test('a Platform Owner cannot impersonate another Platform Owner or a deactivated user', async () => {
  const poRes = await startImpersonation(otherPlatformOwnerId);
  assert.equal(poRes.status, 400);
  assert.equal(poRes.data.error, 'CANNOT_IMPERSONATE_PLATFORM_OWNER');

  const deactivatedRes = await startImpersonation(deactivatedUserId);
  assert.equal(deactivatedRes.status, 400);
  assert.equal(deactivatedRes.data.error, 'TARGET_NOT_ACTIVE');
});

test('starting a view-as session, checking status, an ordinary mutation made while viewing as the target is tagged Admin Activity, and ending the session cleanly', async () => {
  const start = await startImpersonation(ownerId);
  assert.equal(start.status, 201);
  assert.equal(start.data.viewingAs.id, ownerId);

  const statusRes = await fetch(`${baseUrl}/api/impersonation/status`, { headers: { Cookie: start.cookie } });
  const statusBody = await statusRes.json();
  assert.equal(statusBody.isImpersonating, true);
  assert.equal(statusBody.viewingAs.id, ownerId);
  assert.equal(statusBody.realUser.id, platformOwnerId);

  // An ordinary mutation (nothing impersonation-aware about this route at
  // all) performed through the impersonated session.
  const saleRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: start.cookie },
    body: JSON.stringify({
      clientRequestId: crypto.randomUUID(),
      firstName: 'Admin', lastName: 'Activity',
      saleDate: new Date().toISOString(),
      carrier: 'Allstate', policyType: 'Auto-Standard', productFamily: 'AUTO',
      premiumCents: 50000, assignedToId: ownerId,
    }),
  });
  assert.equal(saleRes.status, 201);
  const { sale } = await saleRes.json();

  const audit = await prisma.auditEvent.findFirst({ where: { entityType: 'Sale', entityId: sale.id, action: 'sale.created' } });
  assert.ok(audit, 'the ordinary mutation must still be audited');
  assert.equal(audit.actorId, ownerId, 'the audit\'s own actor stays the effective identity (the agency owner), unchanged for every existing audit reader');
  assert.equal(audit.actorRole, 'AGENCY_OWNER');
  assert.ok(audit.metadata?.impersonatedBy, 'an action performed while impersonating must be tagged as Admin Activity');
  assert.equal(audit.metadata.impersonatedBy.id, platformOwnerId, 'the tag must name the real Platform Owner who was actually driving');

  // Impersonating locks the Platform Owner OUT of Platform-Owner-only
  // routes, since the effective role (req.user.role) is now the target's.
  const lockedOutRes = await fetch(`${baseUrl}/api/sales/items-mismatch`, { headers: { Cookie: start.cookie } });
  assert.equal(lockedOutRes.status, 403, 'a Platform-Owner-only route must stay locked out while viewing as a non-platform-owner');

  const endRes = await fetch(`${baseUrl}/api/impersonation/end`, { method: 'POST', headers: { Cookie: start.cookie } });
  assert.equal(endRes.status, 200);
  const endBody = await endRes.json();
  assert.equal(endBody.realUser.id, platformOwnerId);

  const log = await prisma.impersonationLog.findUnique({ where: { id: start.logId } });
  assert.ok(log.endedAt, 'the impersonation log must be marked ended');

  // The Platform Owner's OWN real session is untouched throughout — it
  // still works for an ordinary Platform-Owner-only route, with no
  // impersonation cookie at all.
  const afterEndRes = await fetch(`${baseUrl}/api/sales/items-mismatch`, { headers: { Cookie: platformOwnerCookie } });
  assert.equal(afterEndRes.status, 200, 'the real Platform Owner session must still work normally, never invalidated by ending a view-as session');

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.revenueEvent.deleteMany({ where: { notes: { contains: sale.id } } });
});

test('a second start while already impersonating is rejected, and a normal (non-impersonated) mutation is never tagged Admin Activity', async () => {
  const start = await startImpersonation(ownerId);
  assert.equal(start.status, 201);

  const secondStartRes = await fetch(`${baseUrl}/api/impersonation/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: start.cookie },
    body: JSON.stringify({ targetUserId: ownerId }),
  });
  assert.equal(secondStartRes.status, 409);

  await fetch(`${baseUrl}/api/impersonation/end`, { method: 'POST', headers: { Cookie: start.cookie } });

  // Control case — the agency owner's OWN ordinary session, no
  // impersonation involved at all.
  const saleRes = await fetch(`${baseUrl}/api/sales`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({
      clientRequestId: crypto.randomUUID(),
      firstName: 'Normal', lastName: 'NotImpersonated',
      saleDate: new Date().toISOString(),
      carrier: 'Allstate', policyType: 'Auto-Standard', productFamily: 'AUTO',
      premiumCents: 20000, assignedToId: ownerId,
    }),
  });
  assert.equal(saleRes.status, 201);
  const { sale } = await saleRes.json();
  const audit = await prisma.auditEvent.findFirst({ where: { entityType: 'Sale', entityId: sale.id, action: 'sale.created' } });
  assert.ok(audit);
  assert.equal(audit.metadata, null, 'an ordinary, non-impersonated action must never be tagged as Admin Activity');

  await prisma.sale.delete({ where: { id: sale.id } });
  await prisma.revenueEvent.deleteMany({ where: { notes: { contains: sale.id } } });
});
