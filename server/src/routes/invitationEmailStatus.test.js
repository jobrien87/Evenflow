// Real-DB, real-HTTP test for the Invitation.lastEmailStatus tracking
// added so an invite/resend's email outcome is visible in the app
// afterward, not just a one-time toast at click time. Mirrors
// vendors.test.js's conventions (real http server, createSession cookie).
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const realFetch = global.fetch;

const suffix = Date.now();
let platformOwnerId, platformOwnerCookie;
let agencyId, agencyOwnerId, agencyOwnerCookie;
let server, baseUrl;

before(async () => {
  const platformOwner = await prisma.user.create({
    data: {
      email: `invemail-po-${suffix}@test.local`, passwordHash: await bcrypt.hash('TestPass123!', 12),
      firstName: 'Platform', lastName: 'Owner', role: 'PLATFORM_OWNER', status: 'ACTIVE',
    },
  });
  platformOwnerId = platformOwner.id;
  platformOwnerCookie = `evenflow_session=${(await createSession(platformOwnerId)).rawToken}`;

  const agency = await prisma.agency.create({ data: { name: `Invite Email Status Test Agency ${suffix}` } });
  agencyId = agency.id;
  const agencyOwner = await prisma.user.create({
    data: {
      email: `invemail-owner-${suffix}@test.local`, passwordHash: await bcrypt.hash('TestPass123!', 12),
      firstName: 'Agency', lastName: 'Owner', role: 'AGENCY_OWNER', status: 'ACTIVE', agencyId,
    },
  });
  agencyOwnerId = agencyOwner.id;
  agencyOwnerCookie = `evenflow_session=${(await createSession(agencyOwnerId)).rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  // Wrapped in try/finally so a cleanup-ordering mistake (e.g. an FK
  // violation) can never leave the HTTP server/Prisma connection open and
  // hang the whole test run indefinitely.
  try {
    await prisma.invitation.deleteMany({ where: { agencyId } });
    await prisma.invitation.deleteMany({ where: { invitedById: { in: [platformOwnerId, agencyOwnerId] } } });
    // Sessions must be removed before their owning Users (FK), including
    // the test-created TM/producer rows below, none of which ever logged in.
    await prisma.session.deleteMany({ where: { userId: { in: [platformOwnerId, agencyOwnerId] } } });
    await prisma.user.deleteMany({ where: { agencyId } });
    await prisma.user.deleteMany({ where: { email: { contains: `invemail-tm-${suffix}` } } });
    await prisma.user.deleteMany({ where: { id: { in: [platformOwnerId, agencyOwnerId] } } });
    await prisma.agency.delete({ where: { id: agencyId } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await prisma.$disconnect();
  }
});

// No BREVO_API_KEY is set in this test environment, so every real send
// attempt below genuinely exercises the honest NOT_CONFIGURED path — no
// mocking needed for this case.

test('inviting a telemarketer persists the real email outcome onto Invitation, visible via GET /telemarketers', async () => {
  const email = `invemail-tm-${suffix}@test.local`;
  const createRes = await fetch(`${baseUrl}/api/telemarketers/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
    body: JSON.stringify({ email, firstName: 'Test', lastName: 'TM' }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.equal(created.emailStatus, 'NOT_CONFIGURED');

  const listRes = await fetch(`${baseUrl}/api/telemarketers`, { headers: { Cookie: platformOwnerCookie } });
  const list = await listRes.json();
  const row = list.telemarketers.find((t) => t.id === created.telemarketer.id);
  assert.ok(row, 'the new telemarketer must appear in the list');
  assert.ok(row.ownInvitation, 'ownInvitation must be included on the list response');
  assert.equal(row.ownInvitation.lastEmailStatus, 'NOT_CONFIGURED');
  assert.ok(row.ownInvitation.lastEmailSentAt, 'a timestamp must be recorded for the send attempt');
  assert.equal(row.ownInvitation.lastEmailError, null);

  // Resending updates the SAME Invitation row (never a second one) with a
  // fresh timestamp.
  const firstSentAt = row.ownInvitation.lastEmailSentAt;
  await new Promise((resolve) => setTimeout(resolve, 10));
  const resendRes = await fetch(`${baseUrl}/api/telemarketers/${created.telemarketer.id}/resend-invite`, {
    method: 'POST', headers: { Cookie: platformOwnerCookie },
  });
  assert.equal(resendRes.status, 200);
  assert.equal((await resendRes.json()).emailStatus, 'NOT_CONFIGURED');

  const invitationCount = await prisma.invitation.count({ where: { userId: created.telemarketer.id } });
  assert.equal(invitationCount, 1, 'a resend must update the existing Invitation row, never create a second one');

  const afterResend = await prisma.invitation.findUnique({ where: { userId: created.telemarketer.id } });
  assert.equal(afterResend.lastEmailStatus, 'NOT_CONFIGURED');
  assert.ok(new Date(afterResend.lastEmailSentAt).getTime() > new Date(firstSentAt).getTime(), 'resend must record a newer timestamp');
});

test('a FAILED send is persisted with a short error message, never the raw accept URL or a token', async (t) => {
  const originalKey = process.env.BREVO_API_KEY;
  process.env.BREVO_API_KEY = 'test-key-for-failure-path';
  t.mock.method(global, 'fetch', async (url, ...rest) => {
    if (typeof url === 'string' && url.includes('api.brevo.com')) {
      return { ok: false, status: 400, text: async () => 'simulated Brevo rejection' };
    }
    return realFetch(url, ...rest);
  });

  try {
    const email = `invemail-tm-fail-${suffix}@test.local`;
    const createRes = await fetch(`${baseUrl}/api/telemarketers/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
      body: JSON.stringify({ email, firstName: 'Fail', lastName: 'Case' }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.emailStatus, 'FAILED');

    const invitation = await prisma.invitation.findUnique({ where: { userId: created.telemarketer.id } });
    assert.equal(invitation.lastEmailStatus, 'FAILED');
    assert.match(invitation.lastEmailError, /simulated Brevo rejection/);
    assert.doesNotMatch(invitation.lastEmailError, /accept-invitation\?token=/, 'the raw accept URL/token must never be persisted');
  } finally {
    if (originalKey === undefined) delete process.env.BREVO_API_KEY;
    else process.env.BREVO_API_KEY = originalKey;
  }
});

test('inviting a regular agency user also persists the email outcome, visible via GET /users', async () => {
  const email = `invemail-producer-${suffix}@test.local`;
  const inviteRes = await fetch(`${baseUrl}/api/users/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: agencyOwnerCookie },
    body: JSON.stringify({ email, firstName: 'Test', lastName: 'Producer', role: 'PRODUCER' }),
  });
  assert.equal(inviteRes.status, 201);
  const invited = await inviteRes.json();
  assert.equal(invited.emailStatus, 'NOT_CONFIGURED');

  const listRes = await fetch(`${baseUrl}/api/users`, { headers: { Cookie: agencyOwnerCookie } });
  const list = await listRes.json();
  const row = list.users.find((u) => u.id === invited.user.id);
  assert.ok(row.ownInvitation);
  assert.equal(row.ownInvitation.lastEmailStatus, 'NOT_CONFIGURED');
});
