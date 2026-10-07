// Stripe adapter for EvenFlow's real billing: a one-time $250 setup fee
// (charged once, on an agency's first self-serve subscription only), a
// recurring $35/seat/month subscription, and a separate one-time $950
// Sales Studio unlock. This is a genuine, non-negotiable exception to this
// codebase's "no SDK, plain fetch" convention (see aiProvider.js/email.js):
// webhook signature verification should never be hand-rolled.
//
// Same honest-degradation contract as every other integration in this app:
// isConfigured() gates every real call, and nothing here ever fabricates a
// Stripe id, a checkout URL, or a subscription status when the key is unset.
const { prisma } = require('./db');

const SEAT_PRICE_CENTS = 3500; // $35/user/month — the confirmed price.
const SETUP_FEE_CENTS = 25000; // $250 one-time, charged once per agency ever.
const SALES_STUDIO_PRICE_CENTS = 95000; // $950 one-time Sales Studio unlock.
const SEAT_PLAN_NAME = 'Standard (self-serve)';

let stripeClient = null;
function isConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

function getClient() {
  if (!isConfigured()) return null;
  if (!stripeClient) {
    // eslint-disable-next-line global-require
    const Stripe = require('stripe');
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

// Finds (or creates, locally) the one Plan row backing self-serve seat
// billing, then makes sure it has a real Stripe Price attached — created
// once via the API the first time this runs with a real key, so nobody
// has to hand-create a Price in the Stripe dashboard first.
async function ensureSeatPlan() {
  let plan = await prisma.plan.findFirst({ where: { perSeat: true } });
  if (!plan) {
    plan = await prisma.plan.create({
      data: {
        name: SEAT_PLAN_NAME,
        priceCents: SEAT_PRICE_CENTS,
        setupFeeCents: SETUP_FEE_CENTS,
        interval: 'MONTHLY',
        crmEnabled: true,
        transfersEnabled: true,
        coachingEnabled: true,
        perSeat: true,
      },
    });
  }
  if (!plan.stripePriceId && isConfigured()) {
    const stripe = getClient();
    const price = await stripe.prices.create({
      unit_amount: plan.priceCents,
      currency: 'usd',
      recurring: { interval: 'month' },
      product_data: { name: 'EvenFlow — per seat' },
    });
    plan = await prisma.plan.update({ where: { id: plan.id }, data: { stripePriceId: price.id } });
  }
  return plan;
}

async function getOrCreateCustomer(agency) {
  const stripe = getClient();
  if (agency.stripeCustomerId) return agency.stripeCustomerId;
  const customer = await stripe.customers.create({
    name: agency.name,
    metadata: { agencyId: agency.id },
  });
  await prisma.agency.update({ where: { id: agency.id }, data: { stripeCustomerId: customer.id } });
  return customer.id;
}

// seatCount is the TARGET number of seats the Agency Owner is choosing to
// buy — the caller validates it's at least their current active+invited
// headcount (see routes/billing.js); this function never derives or
// second-guesses that number itself. The $250 setup fee is included as a
// one-time, non-recurring line item only when the agency has never been
// charged it before (agency.setupFeeChargedAt is null) — Stripe bills a
// non-recurring price exactly once, on the first invoice, in subscription-
// mode Checkout, never again on renewal.
async function createCheckoutSession({ agency, seatCount, successUrl, cancelUrl }) {
  const stripe = getClient();
  const plan = await ensureSeatPlan();
  const customerId = await getOrCreateCustomer(agency);
  const includeSetupFee = !agency.setupFeeChargedAt;

  const lineItems = [{ price: plan.stripePriceId, quantity: Math.max(seatCount, 1) }];
  if (includeSetupFee) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        unit_amount: SETUP_FEE_CENTS,
        product_data: { name: 'EvenFlow — one-time setup fee' },
      },
      quantity: 1,
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: lineItems,
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: agency.id,
    metadata: { agencyId: agency.id, setupFeeIncluded: includeSetupFee ? 'true' : 'false' },
    subscription_data: { metadata: { agencyId: agency.id } },
  });
  return session;
}

// The $950 Sales Studio unlock — a real one-time payment, never a
// recurring charge and never bundled with the seat subscription (an
// agency without any seat subscription yet can still buy this on its
// own). Uses price_data inline rather than a stored Plan/Price row since
// it's a flat, agency-level purchase, not a per-seat recurring price.
async function createSalesStudioCheckoutSession({ agency, successUrl, cancelUrl }) {
  const stripe = getClient();
  const customerId = await getOrCreateCustomer(agency);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    line_items: [{
      price_data: {
        currency: 'usd',
        unit_amount: SALES_STUDIO_PRICE_CENTS,
        product_data: { name: 'EvenFlow — Sales Studio unlock' },
      },
      quantity: 1,
    }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: agency.id,
    metadata: { agencyId: agency.id, purpose: 'sales_studio_unlock' },
  });
  return session;
}

async function createPortalSession({ customerId, returnUrl }) {
  const stripe = getClient();
  return stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
}

function constructWebhookEvent(rawBody, signature) {
  const stripe = getClient();
  return stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

async function updateSubscriptionSeats(stripeSubscriptionId, seatCount) {
  const stripe = getClient();
  const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  const item = subscription.items.data[0];
  if (!item) return;
  await stripe.subscriptions.update(stripeSubscriptionId, {
    items: [{ id: item.id, quantity: Math.max(seatCount, 1) }],
  });
}

module.exports = {
  isConfigured,
  getClient,
  ensureSeatPlan,
  getOrCreateCustomer,
  createCheckoutSession,
  createSalesStudioCheckoutSession,
  createPortalSession,
  constructWebhookEvent,
  updateSubscriptionSeats,
  SEAT_PRICE_CENTS,
  SETUP_FEE_CENTS,
  SALES_STUDIO_PRICE_CENTS,
};
