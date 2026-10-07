// Stripe adapter for the Agency Owner self-serve, per-seat ($35/user)
// subscription. This is a genuine, non-negotiable exception to this
// codebase's "no SDK, plain fetch" convention (see aiProvider.js/email.js):
// webhook signature verification should never be hand-rolled.
//
// Same honest-degradation contract as every other integration in this app:
// isConfigured() gates every real call, and nothing here ever fabricates a
// Stripe id, a checkout URL, or a subscription status when the key is unset.
const { prisma } = require('./db');

const SEAT_PRICE_CENTS = 3495; // $34.95/user/month — the confirmed launch price.
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

async function createCheckoutSession({ agency, seatCount, successUrl, cancelUrl }) {
  const stripe = getClient();
  const plan = await ensureSeatPlan();
  const customerId = await getOrCreateCustomer(agency);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: plan.stripePriceId, quantity: Math.max(seatCount, 1) }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: agency.id,
    subscription_data: { metadata: { agencyId: agency.id } },
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
  createPortalSession,
  constructWebhookEvent,
  updateSubscriptionSeats,
  SEAT_PRICE_CENTS,
};
