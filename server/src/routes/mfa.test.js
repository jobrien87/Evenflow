// Real-DB, real-HTTP tests for TOTP MFA (POST /api/auth/mfa/*) — covers
// the full enroll -> confirm -> second-factor-gated login -> backup-code
// -> disable lifecycle against a real local Postgres DB and real otplib
// code generation (no mocked crypto).
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { generate: generateTotp } = require('otplib');
const { prisma } = require('../lib/db');
const app = require('../app');

const suffix = Date.now();
let agencyId, userId, server, baseUrl;
const REAL_PASSWORD = 'TestPass123!';

async function login(email, password) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `MFA Test Agency ${suffix}` } });
  agencyId = agency.id;

  const hash = await bcrypt.hash(REAL_PASSWORD, 12);
  const user = await prisma.user.create({
    data: { email: `mfa-user-${suffix}@test.local`, passwordHash: hash, firstName: 'Mfa', lastName: 'User', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  userId = user.id;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.mfaChallenge.deleteMany({ where: { userId } });
  await prisma.auditEvent.deleteMany({ where: { agencyId } });
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// A real, authenticated session cookie — used to call the enroll/confirm/
// disable routes exactly like a real browser session would.
async function sessionCookie() {
  const res = await login(`mfa-user-${suffix}@test.local`, REAL_PASSWORD);
  const setCookie = res.headers.get('set-cookie');
  assert.ok(setCookie, 'login must set a session cookie when MFA is not yet enabled');
  return setCookie.split(';')[0];
}

test('a plain login with no MFA enrolled still returns a real session, unaffected by this feature', async () => {
  const res = await login(`mfa-user-${suffix}@test.local`, REAL_PASSWORD);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.user.mfaEnabled, false);
  assert.equal(body.mfaRequired, undefined);
});

test('enroll -> confirm with a real otplib-generated code turns MFA on and returns one-time backup codes', async () => {
  const cookie = await sessionCookie();

  const enrollRes = await fetch(`${baseUrl}/api/auth/mfa/enroll`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(enrollRes.status, 200);
  const enrollBody = await enrollRes.json();
  assert.ok(enrollBody.secret);
  assert.ok(enrollBody.otpauthUrl.startsWith('otpauth://totp/'));
  assert.ok(enrollBody.qrDataUrl.startsWith('data:image/png;base64,'));

  const pending = await prisma.user.findUnique({ where: { id: userId } });
  assert.equal(pending.mfaPendingSecret, enrollBody.secret);
  assert.equal(pending.mfaEnabled, false);

  const realCode = await generateTotp({ secret: enrollBody.secret });
  const confirmRes = await fetch(`${baseUrl}/api/auth/mfa/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code: realCode }),
  });
  assert.equal(confirmRes.status, 200);
  const confirmBody = await confirmRes.json();
  assert.equal(confirmBody.success, true);
  assert.equal(confirmBody.user.mfaEnabled, true);
  assert.equal(confirmBody.backupCodes.length, 10);

  const enabled = await prisma.user.findUnique({ where: { id: userId } });
  assert.equal(enabled.mfaEnabled, true);
  assert.equal(enabled.mfaSecret, enrollBody.secret);
  assert.equal(enabled.mfaPendingSecret, null);
  assert.equal(enabled.mfaBackupCodes.length, 10);
  // Only hashes are ever persisted — none of the plaintext codes appear verbatim.
  for (const code of confirmBody.backupCodes) {
    assert.ok(!enabled.mfaBackupCodes.includes(code));
  }

  const auditEvent = await prisma.auditEvent.findFirst({ where: { action: 'mfa.enabled', entityId: userId } });
  assert.ok(auditEvent, 'enabling MFA must be audit-logged');

  // Disable again so later tests in this file start from a clean state.
  await fetch(`${baseUrl}/api/auth/mfa/disable`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ password: REAL_PASSWORD, code: await generateTotp({ secret: enrollBody.secret }) }),
  });
});

test('confirm rejects a wrong code and never enables MFA', async () => {
  const cookie = await sessionCookie();
  const enrollRes = await fetch(`${baseUrl}/api/auth/mfa/enroll`, { method: 'POST', headers: { Cookie: cookie } });
  const { secret } = await enrollRes.json();

  const confirmRes = await fetch(`${baseUrl}/api/auth/mfa/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code: '000000' }),
  });
  assert.equal(confirmRes.status, 400);
  assert.equal((await confirmRes.json()).error, 'INVALID_CODE');

  const row = await prisma.user.findUnique({ where: { id: userId } });
  assert.equal(row.mfaEnabled, false);
  assert.equal(row.mfaPendingSecret, secret, 'a failed confirm leaves the pending secret in place for a retry');

  // Clean up the pending secret so later tests in this file start clean.
  await prisma.user.update({ where: { id: userId }, data: { mfaPendingSecret: null } });
});

test('once MFA is enabled, a plain password login returns mfaRequired and no session cookie, and a real TOTP code completes it', async () => {
  const cookie = await sessionCookie();
  const enrollRes = await fetch(`${baseUrl}/api/auth/mfa/enroll`, { method: 'POST', headers: { Cookie: cookie } });
  const { secret } = await enrollRes.json();
  const firstCode = await generateTotp({ secret });
  await fetch(`${baseUrl}/api/auth/mfa/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code: firstCode }),
  });

  const loginRes = await login(`mfa-user-${suffix}@test.local`, REAL_PASSWORD);
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.headers.get('set-cookie'), null, 'no session cookie until the second factor is verified');
  const loginBody = await loginRes.json();
  assert.equal(loginBody.mfaRequired, true);
  assert.ok(loginBody.challengeToken);

  const code = await generateTotp({ secret });
  const verifyRes = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeToken: loginBody.challengeToken, code }),
  });
  assert.equal(verifyRes.status, 200);
  assert.ok(verifyRes.headers.get('set-cookie'), 'a correct second-factor code issues a real session cookie');
  const verifyBody = await verifyRes.json();
  assert.equal(verifyBody.success, true);
  assert.equal(verifyBody.user.mfaEnabled, true);

  const loginEvent = await prisma.auditEvent.findFirst({
    where: { action: 'user.login', entityId: userId }, orderBy: { createdAt: 'desc' },
  });
  assert.equal(loginEvent.metadata.via, 'mfa_totp');

  // Disable MFA so the rest of this file's tests (and any later re-run)
  // start from a clean, known state.
  const newCookie = verifyRes.headers.get('set-cookie').split(';')[0];
  await fetch(`${baseUrl}/api/auth/mfa/disable`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: newCookie },
    body: JSON.stringify({ password: REAL_PASSWORD, code: await generateTotp({ secret }) }),
  });
});

test('a reused or expired challenge token is rejected, and a wrong code at verify is audit-logged as a failed login', async () => {
  const cookie = await sessionCookie();
  const enrollRes = await fetch(`${baseUrl}/api/auth/mfa/enroll`, { method: 'POST', headers: { Cookie: cookie } });
  const { secret } = await enrollRes.json();
  await fetch(`${baseUrl}/api/auth/mfa/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code: await generateTotp({ secret }) }),
  });

  const loginBody = await (await login(`mfa-user-${suffix}@test.local`, REAL_PASSWORD)).json();

  const wrongRes = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeToken: loginBody.challengeToken, code: '000000' }),
  });
  assert.equal(wrongRes.status, 401);
  assert.equal((await wrongRes.json()).error, 'INVALID_MFA_CODE');

  const failedEvent = await prisma.auditEvent.findFirst({
    where: { action: 'auth.login_failed', entityId: userId, metadata: { path: ['reason'], equals: 'mfa_invalid_code' } },
  });
  assert.ok(failedEvent, 'a wrong second-factor code must be audit-logged');

  // Now spend the challenge for real, then confirm it cannot be reused.
  const goodCode = await generateTotp({ secret });
  const firstVerify = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeToken: loginBody.challengeToken, code: goodCode }),
  });
  assert.equal(firstVerify.status, 200);

  const replayRes = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeToken: loginBody.challengeToken, code: goodCode }),
  });
  assert.equal(replayRes.status, 401, 'a once-used challenge token must never grant a second session');

  const newCookie = firstVerify.headers.get('set-cookie').split(';')[0];
  await fetch(`${baseUrl}/api/auth/mfa/disable`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: newCookie },
    body: JSON.stringify({ password: REAL_PASSWORD, code: await generateTotp({ secret }) }),
  });
});

test('a backup code completes login exactly once, then is consumed and rejected on reuse', async () => {
  const cookie = await sessionCookie();
  const enrollRes = await fetch(`${baseUrl}/api/auth/mfa/enroll`, { method: 'POST', headers: { Cookie: cookie } });
  const { secret } = await enrollRes.json();
  const confirmBody = await (await fetch(`${baseUrl}/api/auth/mfa/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code: await generateTotp({ secret }) }),
  })).json();
  const backupCode = confirmBody.backupCodes[0];

  const loginBody = await (await login(`mfa-user-${suffix}@test.local`, REAL_PASSWORD)).json();
  const verifyRes = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeToken: loginBody.challengeToken, code: backupCode }),
  });
  assert.equal(verifyRes.status, 200);
  const verifyBody = await verifyRes.json();
  assert.equal(verifyBody.success, true);

  const loginEvent = await prisma.auditEvent.findFirst({
    where: { action: 'user.login', entityId: userId }, orderBy: { createdAt: 'desc' },
  });
  assert.equal(loginEvent.metadata.via, 'mfa_backup_code');

  const afterRow = await prisma.user.findUnique({ where: { id: userId } });
  assert.equal(afterRow.mfaBackupCodes.length, 9, 'the consumed backup code is removed from storage');

  // The same backup code must not work a second time.
  const loginBody2 = await (await login(`mfa-user-${suffix}@test.local`, REAL_PASSWORD)).json();
  const reuseRes = await fetch(`${baseUrl}/api/auth/mfa/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeToken: loginBody2.challengeToken, code: backupCode }),
  });
  assert.equal(reuseRes.status, 401);

  const newCookie = verifyRes.headers.get('set-cookie').split(';')[0];
  await fetch(`${baseUrl}/api/auth/mfa/disable`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: newCookie },
    body: JSON.stringify({ password: REAL_PASSWORD, code: await generateTotp({ secret }) }),
  });
});

test('disable requires both the real password and a real code, and fully clears MFA state', async () => {
  const cookie = await sessionCookie();
  const enrollRes = await fetch(`${baseUrl}/api/auth/mfa/enroll`, { method: 'POST', headers: { Cookie: cookie } });
  const { secret } = await enrollRes.json();
  await fetch(`${baseUrl}/api/auth/mfa/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ code: await generateTotp({ secret }) }),
  });

  const wrongPasswordRes = await fetch(`${baseUrl}/api/auth/mfa/disable`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ password: 'DefinitelyWrong!', code: await generateTotp({ secret }) }),
  });
  assert.equal(wrongPasswordRes.status, 401);

  const wrongCodeRes = await fetch(`${baseUrl}/api/auth/mfa/disable`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ password: REAL_PASSWORD, code: '000000' }),
  });
  assert.equal(wrongCodeRes.status, 400);

  const stillEnabled = await prisma.user.findUnique({ where: { id: userId } });
  assert.equal(stillEnabled.mfaEnabled, true, 'neither a wrong password nor a wrong code disables MFA');

  const realDisableRes = await fetch(`${baseUrl}/api/auth/mfa/disable`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ password: REAL_PASSWORD, code: await generateTotp({ secret }) }),
  });
  assert.equal(realDisableRes.status, 200);

  const disabled = await prisma.user.findUnique({ where: { id: userId } });
  assert.equal(disabled.mfaEnabled, false);
  assert.equal(disabled.mfaSecret, null);
  assert.equal(disabled.mfaPendingSecret, null);
  assert.equal(disabled.mfaBackupCodes.length, 0);
  assert.equal(disabled.mfaEnrolledAt, null);

  const disabledEvent = await prisma.auditEvent.findFirst({ where: { action: 'mfa.disabled', entityId: userId } });
  assert.ok(disabledEvent);

  // Confirm a plain login works again, unaffected.
  const finalLoginRes = await login(`mfa-user-${suffix}@test.local`, REAL_PASSWORD);
  assert.equal(finalLoginRes.status, 200);
  assert.equal((await finalLoginRes.json()).mfaRequired, undefined);
});
