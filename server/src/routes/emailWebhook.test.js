// Real-DB, real-HTTP tests for the inbound Brevo delivery-event webhook —
// covers: honest NOT_CONFIGURED/UNAUTHORIZED gating, real correlation to
// an Invitation by messageId, idempotency on (messageId, event), the
// out-of-order guard, an unmatched messageId still being logged, a batched
// array payload, and the 'request' event never being written as a real
// delivery status.
process.env.NODE_ENV = 'development';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const app = require('../app');

const suffix = Date.now();
let agencyId, userId, server, baseUrl;
let invitationIds = [];

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Email Webhook Test Agency ${suffix}` } });
  agencyId = agency.id;
  const hash = await bcrypt.hash('TestPass123!', 12);
  const user = await prisma.user.create({
    data: { email: `ewh-user-${suffix}@test.local`, passwordHash: hash, firstName: 'EW', lastName: 'Hook', role: 'PRODUCER', agencyId, status: 'INVITED' },
  });
  userId = user.id;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.emailDeliveryEvent.deleteMany({ where: { invitationId: { in: invitationIds } } });
  await prisma.invitation.deleteMany({ where: { id: { in: invitationIds } } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

let originalSecret;
beforeEach(() => { originalSecret = process.env.BREVO_WEBHOOK_SECRET; });
afterEach(() => { process.env.BREVO_WEBHOOK_SECRET = originalSecret; });

async function makeInvitation(messageId) {
  const inv = await prisma.invitation.create({
    data: {
      email: `ewh-inv-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
      role: 'PRODUCER', token: `tok-${Date.now()}-${Math.random()}`, agencyId, invitedById: userId, userId: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      lastEmailStatus: 'SENT', lastEmailSentAt: new Date(), lastEmailMessageId: messageId,
    },
  });
  invitationIds.push(inv.id);
  return inv;
}

test('POST /api/webhooks/brevo returns 503 NOT_CONFIGURED when BREVO_WEBHOOK_SECRET is unset', async () => {
  delete process.env.BREVO_WEBHOOK_SECRET;
  const res = await fetch(`${baseUrl}/api/webhooks/brevo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'delivered', email: 'x@y.com', 'message-id': '<nope>' }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'NOT_CONFIGURED');
});

test('POST /api/webhooks/brevo returns 401 UNAUTHORIZED with a wrong or missing secret', async () => {
  process.env.BREVO_WEBHOOK_SECRET = 'real-secret-value';
  const wrongRes = await fetch(`${baseUrl}/api/webhooks/brevo?secret=wrong`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'delivered', email: 'x@y.com', 'message-id': '<nope>' }),
  });
  assert.equal(wrongRes.status, 401);

  const missingRes = await fetch(`${baseUrl}/api/webhooks/brevo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'delivered', email: 'x@y.com', 'message-id': '<nope>' }),
  });
  assert.equal(missingRes.status, 401);
});

test('a delivered event correlates to the matching Invitation by messageId and sets a real delivery status', async () => {
  process.env.BREVO_WEBHOOK_SECRET = 'real-secret-value';
  const messageId = `<deliver-${Date.now()}@smtp-relay.mailin.fr>`;
  const inv = await makeInvitation(messageId);
  assert.equal(inv.lastEmailDeliveryStatus, null);

  const res = await fetch(`${baseUrl}/api/webhooks/brevo?secret=real-secret-value`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'delivered', email: inv.email, 'message-id': messageId, ts_event: Math.floor(Date.now() / 1000) }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.correlated, 1);

  const updated = await prisma.invitation.findUnique({ where: { id: inv.id } });
  assert.equal(updated.lastEmailDeliveryStatus, 'DELIVERED');
  assert.ok(updated.lastEmailDeliveryEventAt);

  const events = await prisma.emailDeliveryEvent.findMany({ where: { messageId } });
  assert.equal(events.length, 1);
  assert.equal(events[0].invitationId, inv.id);
  assert.equal(events[0].event, 'DELIVERED');
});

test('a hard_bounce event sets HARD_BOUNCE, distinct from a soft bounce', async () => {
  process.env.BREVO_WEBHOOK_SECRET = 'real-secret-value';
  const messageId = `<bounce-${Date.now()}@smtp-relay.mailin.fr>`;
  const inv = await makeInvitation(messageId);

  const res = await fetch(`${baseUrl}/api/webhooks/brevo?secret=real-secret-value`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'hard_bounce', email: inv.email, 'message-id': messageId, ts_event: Math.floor(Date.now() / 1000) }),
  });
  assert.equal(res.status, 200);
  const updated = await prisma.invitation.findUnique({ where: { id: inv.id } });
  assert.equal(updated.lastEmailDeliveryStatus, 'HARD_BOUNCE');
});

test('a repeated/retried identical event leaves exactly one EmailDeliveryEvent row (idempotent)', async () => {
  process.env.BREVO_WEBHOOK_SECRET = 'real-secret-value';
  const messageId = `<retry-${Date.now()}@smtp-relay.mailin.fr>`;
  const inv = await makeInvitation(messageId);
  const payload = { event: 'delivered', email: inv.email, 'message-id': messageId, ts_event: Math.floor(Date.now() / 1000) };

  await fetch(`${baseUrl}/api/webhooks/brevo?secret=real-secret-value`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  await fetch(`${baseUrl}/api/webhooks/brevo?secret=real-secret-value`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

  const events = await prisma.emailDeliveryEvent.findMany({ where: { messageId } });
  assert.equal(events.length, 1, 'a retried identical event must never create a second row');
});

test('an earlier-timestamped event arriving after a later one never regresses the stored delivery status (out-of-order guard)', async () => {
  process.env.BREVO_WEBHOOK_SECRET = 'real-secret-value';
  const messageId = `<order-${Date.now()}@smtp-relay.mailin.fr>`;
  const inv = await makeInvitation(messageId);
  const now = Math.floor(Date.now() / 1000);

  // Later event first (e.g. a real bounce after an earlier deferred retry).
  await fetch(`${baseUrl}/api/webhooks/brevo?secret=real-secret-value`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'hard_bounce', email: inv.email, 'message-id': messageId, ts_event: now }),
  });
  let updated = await prisma.invitation.findUnique({ where: { id: inv.id } });
  assert.equal(updated.lastEmailDeliveryStatus, 'HARD_BOUNCE');

  // An earlier-timestamped 'delivered' event (e.g. a delayed webhook
  // delivery) arrives second — must not overwrite the real, later HARD_BOUNCE.
  const res = await fetch(`${baseUrl}/api/webhooks/brevo?secret=real-secret-value`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'delivered', email: inv.email, 'message-id': messageId, ts_event: now - 3600 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ignoredOutOfOrder, 1);

  updated = await prisma.invitation.findUnique({ where: { id: inv.id } });
  assert.equal(updated.lastEmailDeliveryStatus, 'HARD_BOUNCE', 'the stale event must never regress the real status');
});

test('an event with no matching Invitation is still logged, never errors', async () => {
  process.env.BREVO_WEBHOOK_SECRET = 'real-secret-value';
  const messageId = `<unmatched-${Date.now()}@smtp-relay.mailin.fr>`;

  const res = await fetch(`${baseUrl}/api/webhooks/brevo?secret=real-secret-value`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'delivered', email: 'nobody@test.local', 'message-id': messageId, ts_event: Math.floor(Date.now() / 1000) }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.logged, 1);
  assert.equal(body.correlated, 0);

  const events = await prisma.emailDeliveryEvent.findMany({ where: { messageId } });
  assert.equal(events.length, 1);
  assert.equal(events[0].invitationId, null);
});

test('a batched array payload processes every event in the batch', async () => {
  process.env.BREVO_WEBHOOK_SECRET = 'real-secret-value';
  const messageId1 = `<batch1-${Date.now()}@smtp-relay.mailin.fr>`;
  const messageId2 = `<batch2-${Date.now()}@smtp-relay.mailin.fr>`;
  const inv1 = await makeInvitation(messageId1);
  const inv2 = await makeInvitation(messageId2);
  const now = Math.floor(Date.now() / 1000);

  const res = await fetch(`${baseUrl}/api/webhooks/brevo?secret=real-secret-value`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      { event: 'delivered', email: inv1.email, 'message-id': messageId1, ts_event: now },
      { event: 'opened', email: inv2.email, 'message-id': messageId2, ts_event: now },
    ]),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.logged, 2);
  assert.equal(body.correlated, 2);

  const updated1 = await prisma.invitation.findUnique({ where: { id: inv1.id } });
  const updated2 = await prisma.invitation.findUnique({ where: { id: inv2.id } });
  assert.equal(updated1.lastEmailDeliveryStatus, 'DELIVERED');
  assert.equal(updated2.lastEmailDeliveryStatus, 'OPENED');
});

test('a plain "request" event (Brevo accepted the send) is logged but never written as a real delivery status', async () => {
  process.env.BREVO_WEBHOOK_SECRET = 'real-secret-value';
  const messageId = `<request-${Date.now()}@smtp-relay.mailin.fr>`;
  const inv = await makeInvitation(messageId);

  const res = await fetch(`${baseUrl}/api/webhooks/brevo?secret=real-secret-value`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'request', email: inv.email, 'message-id': messageId, ts_event: Math.floor(Date.now() / 1000) }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.logged, 1);
  assert.equal(body.correlated, 0, 'request must never itself count as a correlated delivery-status update');

  const updated = await prisma.invitation.findUnique({ where: { id: inv.id } });
  assert.equal(updated.lastEmailDeliveryStatus, null, '"request" (queued-for-send) is not a real delivery outcome');
});
