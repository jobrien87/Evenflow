const { test } = require('node:test');
const assert = require('node:assert/strict');
const billingRouter = require('./billing');

const { mapStripeStatus } = billingRouter;

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
