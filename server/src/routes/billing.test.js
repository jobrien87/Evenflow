const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const billingRouter = require('./billing');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const { mapStripeStatus, processWebhookEventIdempotently } = billingRouter;

test('mapStripeStatus maps every real Stripe subscription status to our enum', () => {
  assert.equal(mapStripeStatus('active'), 'ACTIVE');
  assert.equal(mapStripeStatus('past_due'), 'PAST_DUE');
  assert.equal(mapStripeStatus('trialing'), 'TRIALING');
  assert.equal(mapStripeStatus('canceled'), 'CANCELED');
  assert.equal(mapStripeStatus('unpaid'), 'PAST_DUE');
  assert.equal(mapStripeStatus('incomplete_expired'), 'CANCELED');
});

test('mapStripeStatus returns null for an unrecognized status (never guesses)', () => {
  assert.equal(mapStripeStatus('some_future_stripe_status'), null);
});

const { isConfigured } = require('../lib/stripe');

test('stripe lib honestly reports not configured when no key is set', () => {
  const original = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(isConfigured(), false);
  if (original) process.env.STRIPE_SECRET_KEY = original;
});

// --- Webhook idempotency + ack-on-failure, and the seat-cap enforcement
// on producer invites — real-database tests exercising the actual
// business logic directly (processWebhookEventIdempotently), bypassing
// Stripe signature verification entirely since this environment carries
// no real Stripe key.

const suffix = Date.now();
let agencyId, ownerId, ownerCookie, server, baseUrl;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Billing Test Agency ${suffix}` } });
  agencyId = agency.id;
  const hash = await bcrypt.hash('TestPass123!', 12);
  const owner = await prisma.user.create({
    data: { email: `billing-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Billing', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const session = await createSession(ownerId);
  ownerCookie = `evenflow_session=${session.rawToken}`;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.agencySubscription.deleteMany({ where: { agencyId } });
  await prisma.user.deleteMany({ where: { agencyId, id: { not: ownerId } } });
  await prisma.session.deleteMany({ where: { userId: ownerId } });
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {});
  await prisma.agency.delete({ where: { id: agencyId } }).catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

function fakeCheckoutSessionEvent({ agencyId, subscriptionId, setupFeeIncluded }) {
  return {
    id: `evt_test_${crypto.randomUUID()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        client_reference_id: agencyId,
        subscription: subscriptionId,
        metadata: { agencyId, setupFeeIncluded: setupFeeIncluded ? 'true' : 'false' },
      },
    },
  };
}

function fakeSalesStudioEvent({ agencyId }) {
  return {
    id: `evt_test_${crypto.randomUUID()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        client_reference_id: agencyId,
        subscription: null,
        metadata: { agencyId, purpose: 'sales_studio_unlock' },
      },
    },
  };
}

test('a seat-subscription checkout.session.completed with the setup fee creates one subscription and charges the fee exactly once', async () => {
  const subId = `sub_test_${crypto.randomUUID()}`;
  const event = fakeCheckoutSessionEvent({ agencyId, subscriptionId: subId, setupFeeIncluded: true });

  await processWebhookEventIdempotently(event, 'test-correlation');

  const [subs, agency] = await Promise.all([
    prisma.agencySubscription.findMany({ where: { agencyId, stripeSubscriptionId: subId } }),
    prisma.agency.findUnique({ where: { id: agencyId } }),
  ]);
  assert.equal(subs.length, 1, 'exactly one subscription row created');
  assert.equal(subs[0].status, 'ACTIVE');
  assert.ok(agency.setupFeeChargedAt, 'setup fee must be recorded as charged');
  assert.ok(agency.crmEnabled, 'plan entitlements must be applied');

  await prisma.agencySubscription.deleteMany({ where: { agencyId, stripeSubscriptionId: subId } });
  await prisma.agency.update({ where: { id: agencyId }, data: { setupFeeChargedAt: null } });
});

test('replaying the exact same Stripe event id is a clean no-op (idempotent)', async () => {
  const subId = `sub_test_${crypto.randomUUID()}`;
  const event = fakeCheckoutSessionEvent({ agencyId, subscriptionId: subId, setupFeeIncluded: false });

  await processWebhookEventIdempotently(event, 'test-correlation');
  const afterFirst = await prisma.agencySubscription.count({ where: { agencyId, stripeSubscriptionId: subId } });
  assert.equal(afterFirst, 1);

  // Same event.id, delivered again (Stripe's own retry behavior) — must
  // not create a second subscription row.
  await processWebhookEventIdempotently(event, 'test-correlation');
  const afterReplay = await prisma.agencySubscription.count({ where: { agencyId, stripeSubscriptionId: subId } });
  assert.equal(afterReplay, 1, 'a replayed event must never double-provision');

  const stripeEventRows = await prisma.stripeEvent.count({ where: { id: event.id } });
  assert.equal(stripeEventRows, 1, 'the idempotency row itself is also never duplicated');

  await prisma.agencySubscription.deleteMany({ where: { agencyId, stripeSubscriptionId: subId } });
});

test('a Sales Studio one-time checkout unlocks coachingEnabled and is recorded as purchased', async () => {
  const freshAgency = await prisma.agency.create({ data: { name: `Sales Studio Test Agency ${suffix}` } });
  const event = fakeSalesStudioEvent({ agencyId: freshAgency.id });

  await processWebhookEventIdempotently(event, 'test-correlation');

  const updated = await prisma.agency.findUnique({ where: { id: freshAgency.id } });
  assert.equal(updated.coachingEnabled, true);
  assert.ok(updated.salesStudioPurchasedAt);

  // No AgencySubscription should ever be created for a one-time purchase.
  const subs = await prisma.agencySubscription.count({ where: { agencyId: freshAgency.id } });
  assert.equal(subs, 0);

  await prisma.agency.delete({ where: { id: freshAgency.id } });
});

test('a genuine processing failure is never acknowledged — the event stays unprocessed for retry', async () => {
  // An event referencing an agency that doesn't exist makes the real
  // Agency.update() throw (foreign key / record-not-found) inside the
  // transaction — this must propagate, not be swallowed.
  const event = fakeCheckoutSessionEvent({ agencyId: '00000000-0000-0000-0000-000000000000', subscriptionId: `sub_test_${crypto.randomUUID()}`, setupFeeIncluded: true });

  await assert.rejects(() => processWebhookEventIdempotently(event, 'test-correlation'));

  // The whole transaction (including the StripeEvent idempotency row)
  // must have rolled back — otherwise a real retry of this same event
  // would be silently skipped as "already processed" despite never
  // actually succeeding.
  const stripeEventRow = await prisma.stripeEvent.findUnique({ where: { id: event.id } });
  assert.equal(stripeEventRow, null, 'a failed event must leave no idempotency row behind');
});

test('inviting a Producer is blocked once the agency hits its paid seat limit', async () => {
  let plan = await prisma.plan.findFirst({ where: { perSeat: true } });
  if (!plan) plan = await prisma.plan.create({ data: { name: 'Seat test plan', priceCents: 3500, perSeat: true } });
  const sub = await prisma.agencySubscription.create({
    data: { agencyId, planId: plan.id, status: 'ACTIVE', stripeSubscriptionId: `sub_cap_${crypto.randomUUID()}`, seatCount: 2 },
  });

  // Seat 1 is already the owner (ACTIVE). One more PRODUCER invite should
  // succeed (fills seat 2 as INVITED); a third should be blocked.
  const first = await fetch(`${baseUrl}/api/users/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ email: `cap-producer-1-${suffix}@test.local`, firstName: 'Cap', lastName: 'One', role: 'PRODUCER' }),
  });
  assert.equal(first.status, 201, 'the first producer invite must succeed, filling the second seat');

  const second = await fetch(`${baseUrl}/api/users/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ email: `cap-producer-2-${suffix}@test.local`, firstName: 'Cap', lastName: 'Two', role: 'PRODUCER' }),
  });
  assert.equal(second.status, 409);
  const secondBody = await second.json();
  assert.equal(secondBody.error, 'SEAT_LIMIT_REACHED');

  // A Manager invite is explicitly NOT capped by this same rule.
  const managerInvite = await fetch(`${baseUrl}/api/users/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ email: `cap-manager-${suffix}@test.local`, firstName: 'Cap', lastName: 'Manager', role: 'AGENCY_MANAGER' }),
  });
  assert.equal(managerInvite.status, 201, 'a Manager invite must never be blocked by the Producer seat cap');

  await prisma.user.deleteMany({ where: { email: { in: [`cap-producer-1-${suffix}@test.local`, `cap-manager-${suffix}@test.local`] } } });
  await prisma.invitation.deleteMany({ where: { email: { in: [`cap-producer-1-${suffix}@test.local`, `cap-manager-${suffix}@test.local`] } } });
  await prisma.agencySubscription.delete({ where: { id: sub.id } });
});

test('an agency with no self-serve subscription is never seat-capped (existing manual-plan behavior preserved)', async () => {
  const res = await fetch(`${baseUrl}/api/users/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ email: `nocap-producer-${suffix}@test.local`, firstName: 'No', lastName: 'Cap', role: 'PRODUCER' }),
  });
  assert.equal(res.status, 201);
  await prisma.user.deleteMany({ where: { email: `nocap-producer-${suffix}@test.local` } });
  await prisma.invitation.deleteMany({ where: { email: `nocap-producer-${suffix}@test.local` } });
});
