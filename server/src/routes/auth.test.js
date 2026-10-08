// Real-DB, real-HTTP tests for POST /api/auth/login — covers the Tier 1
// compliance addition: every failed-login reason (no such user, inactive
// account, wrong password) now records a real auth.login_failed
// AuditEvent, and a real successful login still works unchanged.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const app = require('../app');

const suffix = Date.now();
let agencyId, activeUserId, inactiveUserId, server, baseUrl;
const REAL_PASSWORD = 'TestPass123!';

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Auth Test Agency ${suffix}` } });
  agencyId = agency.id;

  const hash = await bcrypt.hash(REAL_PASSWORD, 12);
  const active = await prisma.user.create({
    data: { email: `auth-active-${suffix}@test.local`, passwordHash: hash, firstName: 'Active', lastName: 'User', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  activeUserId = active.id;
  const inactive = await prisma.user.create({
    data: { email: `auth-inactive-${suffix}@test.local`, passwordHash: hash, firstName: 'Inactive', lastName: 'User', role: 'PRODUCER', agencyId, status: 'DEACTIVATED' },
  });
  inactiveUserId = inactive.id;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.auditEvent.deleteMany({ where: { agencyId } });
  await prisma.session.deleteMany({ where: { userId: { in: [activeUserId, inactiveUserId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [activeUserId, inactiveUserId] } } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('a real successful login still works, unaffected by the audit-logging addition', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `auth-active-${suffix}@test.local`, password: REAL_PASSWORD }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
});

test('a login attempt for a non-existent email is rejected and audit-logged with reason no_such_user', async () => {
  const unknownEmail = `auth-nobody-${suffix}@test.local`;
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: unknownEmail, password: 'whatever' }),
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'INVALID_CREDENTIALS');

  const event = await prisma.auditEvent.findFirst({ where: { action: 'auth.login_failed', metadata: { path: ['email'], equals: unknownEmail } } });
  assert.ok(event, 'a real auth.login_failed AuditEvent must be recorded even when the user does not exist');
  assert.equal(event.metadata.reason, 'no_such_user');
  assert.equal(event.actorId, null, 'no real user to attribute — actorId stays null, same as the AuditEvent.actorId nullable precedent');
});

test('a login attempt against a deactivated account is rejected (403) and audit-logged with reason account_not_active', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `auth-inactive-${suffix}@test.local`, password: REAL_PASSWORD }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'ACCOUNT_NOT_ACTIVE');

  const event = await prisma.auditEvent.findFirst({ where: { action: 'auth.login_failed', entityId: inactiveUserId } });
  assert.ok(event);
  assert.equal(event.metadata.reason, 'account_not_active');
  assert.equal(event.actorId, inactiveUserId, 'a real user was identified, even though the account is inactive');
});

test('a login attempt with the wrong password is rejected (401) and audit-logged with reason wrong_password', async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `auth-active-${suffix}@test.local`, password: 'DefinitelyWrongPassword!' }),
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'INVALID_CREDENTIALS');

  const event = await prisma.auditEvent.findFirst({
    where: { action: 'auth.login_failed', entityId: activeUserId },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(event);
  assert.equal(event.metadata.reason, 'wrong_password');
});
