const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const stripeLib = require('../lib/stripe');
const { countActiveSeats } = require('../lib/seatBilling');

const router = express.Router();
router.use(requireAuth);

function isPaymentProcessorConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

router.get('/status', (req, res) => {
  res.json({
    success: true,
    paymentProcessorConfigured: isPaymentProcessorConfigured(),
    mode: isPaymentProcessorConfigured() ? 'AUTOMATED' : 'MANUAL',
    note: isPaymentProcessorConfigured()
      ? undefined
      : 'No payment processor is configured. Billing operates in manual/admin mode, Platform Owner assigns plans directly; no payment is ever actually charged or simulated.',
  });
});

router.get('/plans', async (req, res, next) => {
  try {
    const plans = await prisma.plan.findMany({ where: { isActive: true }, orderBy: { priceCents: 'asc' } });
    return res.json({ success: true, plans });
  } catch (err) {
    next(err);
  }
});

const createPlanSchema = z.object({
  name: z.string().min(1),
  priceCents: z.number().int().min(0),
  interval: z.enum(['MONTHLY', 'ANNUAL']).default('MONTHLY'),
  crmEnabled: z.boolean().default(true),
  transfersEnabled: z.boolean().default(false),
  coachingEnabled: z.boolean().default(false),
});

router.post('/plans', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = createPlanSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const plan = await prisma.plan.create({ data: parsed.data });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role,
      action: 'plan.created', entityType: 'Plan', entityId: plan.id,
      after: parsed.data, correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, plan });
  } catch (err) {
    next(err);
  }
});

// NOT derived via createPlanSchema.partial(): under Zod 4, .partial() on a
// schema with .default() fields still fills in those defaults for omitted
// keys (Zod 3 left them genuinely absent). That would make a PATCH that
// only renames a plan silently reset crmEnabled/transfersEnabled/
// coachingEnabled back to their create-time defaults. Defined independently
// with plain .optional() (no .default()) so an omitted field stays omitted.
const updatePlanSchema = z.object({
  name: z.string().min(1).optional(),
  priceCents: z.number().int().min(0).optional(),
  interval: z.enum(['MONTHLY', 'ANNUAL']).optional(),
  crmEnabled: z.boolean().optional(),
  transfersEnabled: z.boolean().optional(),
  coachingEnabled: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

router.patch('/plans/:id', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = updatePlanSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    const before = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const plan = await prisma.plan.update({ where: { id: req.params.id }, data: parsed.data });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role,
      action: 'plan.updated', entityType: 'Plan', entityId: plan.id,
      before, after: parsed.data, correlationId: req.correlationId,
    });
    return res.json({ success: true, plan });
  } catch (err) {
    next(err);
  }
});

router.get('/agencies/:agencyId/subscription', async (req, res, next) => {
  try {
    if (req.user.role !== 'PLATFORM_OWNER' && req.user.agencyId !== req.params.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const subscription = await prisma.agencySubscription.findFirst({
      where: { agencyId: req.params.agencyId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, subscription: subscription || null });
  } catch (err) {
    next(err);
  }
});

const assignSchema = z.object({
  planId: z.string().uuid(),
  status: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE']).default('ACTIVE'),
  trialEndsAt: z.string().datetime().optional(),
});

router.post('/agencies/:agencyId/subscription', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const [agency, plan] = await Promise.all([
      prisma.agency.findUnique({ where: { id: req.params.agencyId } }),
      prisma.plan.findUnique({ where: { id: parsed.data.planId } }),
    ]);
    if (!agency) return res.status(404).json({ success: false, error: 'AGENCY_NOT_FOUND' });
    if (!plan) return res.status(404).json({ success: false, error: 'PLAN_NOT_FOUND' });

    const result = await prisma.$transaction(async (tx) => {
      await tx.agencySubscription.updateMany({
        where: { agencyId: agency.id, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
        data: { status: 'CANCELED', canceledAt: new Date() },
      });

      const subscription = await tx.agencySubscription.create({
        data: {
          agencyId: agency.id,
          planId: plan.id,
          status: parsed.data.status,
          trialEndsAt: parsed.data.trialEndsAt ? new Date(parsed.data.trialEndsAt) : null,
          assignedById: req.user.id,
        },
      });

      const updatedAgency = await tx.agency.update({
        where: { id: agency.id },
        data: {
          crmEnabled: plan.crmEnabled,
          transfersEnabled: plan.transfersEnabled,
          coachingEnabled: plan.coachingEnabled,
        },
      });

      return { subscription, updatedAgency };
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: agency.id,
      action: 'subscription.assigned', entityType: 'AgencySubscription', entityId: result.subscription.id,
      after: { planId: plan.id, planName: plan.name, status: parsed.data.status }, correlationId: req.correlationId,
    });

    return res.status(201).json({ success: true, subscription: result.subscription, agency: result.updatedAgency });
  } catch (err) {
    next(err);
  }
});

router.post('/agencies/:agencyId/subscription/cancel', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const active = await prisma.agencySubscription.findFirst({
      where: { agencyId: req.params.agencyId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
    });
    if (!active) return res.status(404).json({ success: false, error: 'NO_ACTIVE_SUBSCRIPTION' });

    await prisma.$transaction([
      prisma.agencySubscription.update({ where: { id: active.id }, data: { status: 'CANCELED', canceledAt: new Date() } }),
      prisma.agency.update({ where: { id: req.params.agencyId }, data: { transfersEnabled: false, coachingEnabled: false } }),
    ]);

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.params.agencyId,
      action: 'subscription.canceled', entityType: 'AgencySubscription', entityId: active.id, correlationId: req.correlationId,
    });

    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- Self-serve, per-seat ($35/user) Stripe billing ------------------------
// A separate path from the manual flat-plan flow above: the Agency Owner
// manages their own subscription/card via real Stripe Checkout + a real
// Customer Portal, no Platform Owner involved. Shares the same Plan/
// AgencySubscription tables (see schema comments) but is distinguished by
// stripeSubscriptionId being set.

const APP_URL = process.env.APP_URL || 'http://localhost:5173';

function mapStripeStatus(stripeStatus) {
  const map = { active: 'ACTIVE', past_due: 'PAST_DUE', trialing: 'TRIALING', canceled: 'CANCELED', unpaid: 'PAST_DUE', incomplete_expired: 'CANCELED' };
  return map[stripeStatus] || null;
}

router.get('/self-serve/status', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER'), async (req, res, next) => {
  try {
    const agencyId = req.user.agencyId;
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const [seatCount, invitedCount, subscription, agency] = await Promise.all([
      countActiveSeats(agencyId),
      prisma.user.count({ where: { agencyId, status: 'INVITED' } }),
      prisma.agencySubscription.findFirst({
        where: { agencyId, stripeSubscriptionId: { not: null } },
        include: { plan: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.agency.findUnique({ where: { id: agencyId }, select: { setupFeeChargedAt: true, salesStudioPurchasedAt: true, coachingEnabled: true } }),
    ]);

    return res.json({
      success: true,
      configured: stripeLib.isConfigured(),
      seatCount,
      occupiedSeats: seatCount + invitedCount,
      seatLimit: subscription?.status !== 'CANCELED' ? subscription?.seatCount ?? null : null,
      pricePerSeatCents: stripeLib.SEAT_PRICE_CENTS,
      setupFeeCents: stripeLib.SETUP_FEE_CENTS,
      setupFeeCharged: !!agency?.setupFeeChargedAt,
      salesStudioPriceCents: stripeLib.SALES_STUDIO_PRICE_CENTS,
      salesStudioPurchased: !!agency?.salesStudioPurchasedAt,
      coachingEnabled: !!agency?.coachingEnabled,
      subscription,
    });
  } catch (err) {
    next(err);
  }
});

const selfServeCheckoutSchema = z.object({
  seatCount: z.number().int().min(1).optional(),
});

router.post('/self-serve/checkout', requireRole('AGENCY_OWNER'), async (req, res, next) => {
  try {
    if (!stripeLib.isConfigured()) {
      return res.status(501).json({ success: false, error: 'NOT_CONFIGURED', message: 'Payment processor is not configured yet.' });
    }
    const parsed = selfServeCheckoutSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const agency = await prisma.agency.findUnique({ where: { id: req.user.agencyId } });
    if (!agency) return res.status(404).json({ success: false, error: 'AGENCY_NOT_FOUND' });

    const activeSeats = await countActiveSeats(agency.id);
    // The chosen quantity can never undercut the agency's real current
    // headcount — you can buy ahead of your roster, never behind it.
    const seatCount = parsed.data.seatCount ?? activeSeats;
    if (seatCount < activeSeats) {
      return res.status(400).json({ success: false, error: 'SEAT_COUNT_TOO_LOW', message: `You currently have ${activeSeats} active user(s) — you can't buy fewer seats than that.` });
    }

    const session = await stripeLib.createCheckoutSession({
      agency,
      seatCount,
      successUrl: `${APP_URL}/agency/billing?checkout=success`,
      cancelUrl: `${APP_URL}/agency/billing?checkout=canceled`,
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: agency.id,
      action: 'billing.self_serve_checkout_started', entityType: 'Agency', entityId: agency.id,
      after: { seatCount }, correlationId: req.correlationId,
    });

    return res.json({ success: true, url: session.url });
  } catch (err) {
    next(err);
  }
});

const updateSeatsSchema = z.object({
  seatCount: z.number().int().min(1),
});

// Buy more seats on an already-active self-serve subscription (raising the
// producer-invite cap below) — Stripe prorates the difference onto the
// next invoice automatically. Never lets seatCount drop below the agency's
// real current headcount (that's a cancel/downgrade decision for the
// Stripe customer portal, not this route).
router.post('/self-serve/seats', requireRole('AGENCY_OWNER'), async (req, res, next) => {
  try {
    if (!stripeLib.isConfigured()) {
      return res.status(501).json({ success: false, error: 'NOT_CONFIGURED', message: 'Payment processor is not configured yet.' });
    }
    const parsed = updateSeatsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const agencyId = req.user.agencyId;
    const subscription = await prisma.agencySubscription.findFirst({
      where: { agencyId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] }, stripeSubscriptionId: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    if (!subscription) {
      return res.status(404).json({ success: false, error: 'NO_ACTIVE_SUBSCRIPTION', message: 'Start a subscription first.' });
    }

    const activeSeats = await countActiveSeats(agencyId);
    if (parsed.data.seatCount < activeSeats) {
      return res.status(400).json({ success: false, error: 'SEAT_COUNT_TOO_LOW', message: `You currently have ${activeSeats} active user(s) — you can't buy fewer seats than that.` });
    }

    await stripeLib.updateSubscriptionSeats(subscription.stripeSubscriptionId, parsed.data.seatCount);
    const updated = await prisma.agencySubscription.update({
      where: { id: subscription.id },
      data: { seatCount: parsed.data.seatCount },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId,
      action: 'billing.seats_updated', entityType: 'AgencySubscription', entityId: subscription.id,
      before: { seatCount: subscription.seatCount }, after: { seatCount: parsed.data.seatCount }, correlationId: req.correlationId,
    });

    return res.json({ success: true, subscription: updated });
  } catch (err) {
    next(err);
  }
});

// The $950 one-time Sales Studio unlock — a real Stripe Checkout payment,
// separate from the seat subscription (an agency can buy this with or
// without an active seat subscription). coachingEnabled only ever flips on
// webhook confirmation, never here — this route just starts the payment.
router.post('/self-serve/sales-studio-checkout', requireRole('AGENCY_OWNER'), async (req, res, next) => {
  try {
    if (!stripeLib.isConfigured()) {
      return res.status(501).json({ success: false, error: 'NOT_CONFIGURED', message: 'Payment processor is not configured yet.' });
    }
    const agency = await prisma.agency.findUnique({ where: { id: req.user.agencyId } });
    if (!agency) return res.status(404).json({ success: false, error: 'AGENCY_NOT_FOUND' });
    if (agency.salesStudioPurchasedAt) {
      return res.status(409).json({ success: false, error: 'ALREADY_PURCHASED', message: 'Sales Studio is already unlocked for this agency.' });
    }

    const session = await stripeLib.createSalesStudioCheckoutSession({
      agency,
      successUrl: `${APP_URL}/agency/billing?salesStudio=success`,
      cancelUrl: `${APP_URL}/agency/billing?salesStudio=canceled`,
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: agency.id,
      action: 'billing.sales_studio_checkout_started', entityType: 'Agency', entityId: agency.id,
      correlationId: req.correlationId,
    });

    return res.json({ success: true, url: session.url });
  } catch (err) {
    next(err);
  }
});

router.post('/self-serve/portal', requireRole('AGENCY_OWNER'), async (req, res, next) => {
  try {
    if (!stripeLib.isConfigured()) {
      return res.status(501).json({ success: false, error: 'NOT_CONFIGURED', message: 'Payment processor is not configured yet.' });
    }
    const agency = await prisma.agency.findUnique({ where: { id: req.user.agencyId } });
    if (!agency?.stripeCustomerId) {
      return res.status(404).json({ success: false, error: 'NO_CUSTOMER', message: 'Start a subscription first.' });
    }
    const session = await stripeLib.createPortalSession({
      customerId: agency.stripeCustomerId,
      returnUrl: `${APP_URL}/agency/billing`,
    });
    return res.json({ success: true, url: session.url });
  } catch (err) {
    next(err);
  }
});

// Real event-processing logic for one already-dedup-checked Stripe event,
// run inside the same transaction as the StripeEvent idempotency row (see
// handleStripeWebhook below) — every write here uses `tx`, never the bare
// `prisma` client, so a failure partway through rolls back everything
// including the StripeEvent row itself, leaving the event genuinely
// unprocessed for Stripe's retry to pick back up.
async function processStripeEvent(tx, event, correlationId) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const agencyId = session.client_reference_id || session.metadata?.agencyId;
      if (!agencyId) break;

      if (session.metadata?.purpose === 'sales_studio_unlock') {
        await tx.agency.update({
          where: { id: agencyId },
          data: { coachingEnabled: true, salesStudioPurchasedAt: new Date() },
        });
        await recordAudit({ agencyId, action: 'billing.sales_studio_unlocked', entityType: 'Agency', entityId: agencyId, correlationId });
        break;
      }

      if (!session.subscription) break;
      const plan = await stripeLib.ensureSeatPlan();
      const seatCount = await countActiveSeats(agencyId);

      await tx.agencySubscription.updateMany({
        where: { agencyId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
        data: { status: 'CANCELED', canceledAt: new Date() },
      });
      await tx.agencySubscription.create({
        data: {
          agencyId,
          planId: plan.id,
          status: 'ACTIVE',
          stripeSubscriptionId: session.subscription,
          seatCount,
        },
      });
      const agencyUpdate = { crmEnabled: plan.crmEnabled, transfersEnabled: plan.transfersEnabled, coachingEnabled: plan.coachingEnabled };
      if (session.metadata?.setupFeeIncluded === 'true') {
        agencyUpdate.setupFeeChargedAt = new Date();
      }
      await tx.agency.update({ where: { id: agencyId }, data: agencyUpdate });
      await recordAudit({ agencyId, action: 'billing.self_serve_subscription_started', entityType: 'AgencySubscription', entityId: session.subscription, correlationId });
      break;
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const existing = await tx.agencySubscription.findFirst({ where: { stripeSubscriptionId: sub.id } });
      if (!existing) break;
      await tx.agencySubscription.update({
        where: { id: existing.id },
        data: {
          status: mapStripeStatus(sub.status) || existing.status,
          currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : existing.currentPeriodEnd,
          seatCount: sub.items?.data?.[0]?.quantity ?? existing.seatCount,
        },
      });
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const existing = await tx.agencySubscription.findFirst({ where: { stripeSubscriptionId: sub.id } });
      if (!existing) break;
      await tx.agencySubscription.update({ where: { id: existing.id }, data: { status: 'CANCELED', canceledAt: new Date() } });
      await tx.agency.update({ where: { id: existing.agencyId }, data: { transfersEnabled: false, coachingEnabled: false } });
      await recordAudit({ agencyId: existing.agencyId, action: 'billing.self_serve_subscription_canceled', entityType: 'AgencySubscription', entityId: existing.id, correlationId });
      break;
    }
    default:
      break;
  }
}

// Idempotency gate + dispatch for one real Stripe event — exported
// separately from handleStripeWebhook (which also does signature
// verification, requiring a real Stripe client) so this, the actual
// business logic, is directly unit-testable with a hand-built event
// object even with no Stripe key configured. A Stripe event id is
// recorded exactly once; a retried delivery of an event already fully
// processed hits the unique constraint on StripeEvent.id and is treated
// as a clean no-op success — never reprocessed, never double-charged or
// double-provisioned. Throws (never swallows) on a genuine processing
// failure, so the caller can refuse to acknowledge receipt.
async function processWebhookEventIdempotently(event, correlationId) {
  await prisma.$transaction(async (tx) => {
    try {
      await tx.stripeEvent.create({ data: { id: event.id, type: event.type } });
    } catch (err) {
      if (err.code === 'P2002') return; // already processed — no-op
      throw err;
    }
    await processStripeEvent(tx, event, correlationId);
  });
}

// Called from app.js with the raw request body (Stripe signature
// verification requires the exact bytes, not re-serialized JSON) — this
// route is mounted there directly, not via this router, but the handler
// lives here alongside the rest of the self-serve billing logic.
async function handleStripeWebhook(req, res) {
  if (!stripeLib.isConfigured()) {
    return res.status(501).send('Payment processor not configured');
  }
  let event;
  try {
    event = stripeLib.constructWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (err) {
    console.error('[stripe webhook] signature verification failed', err.message);
    return res.status(400).send('Invalid signature');
  }

  try {
    await processWebhookEventIdempotently(event, req.correlationId);
  } catch (err) {
    // A genuine processing failure (a DB write failed, Stripe's seat-sync
    // call threw, etc.) must NOT be acknowledged as received — the whole
    // transaction above (including the StripeEvent row) rolled back, so
    // the event is still genuinely unprocessed. Returning a non-2xx here
    // is what makes Stripe retry it instead of silently losing the
    // provisioning/charge-fulfillment this event represents.
    console.error('[stripe webhook] handler error — NOT acknowledged, Stripe will retry', err);
    return res.status(500).send('Webhook processing failed');
  }

  return res.json({ received: true });
}

module.exports = router;
module.exports.handleStripeWebhook = handleStripeWebhook;
module.exports.processWebhookEventIdempotently = processWebhookEventIdempotently;
module.exports.mapStripeStatus = mapStripeStatus;
