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

    const [seatCount, subscription] = await Promise.all([
      countActiveSeats(agencyId),
      prisma.agencySubscription.findFirst({
        where: { agencyId, stripeSubscriptionId: { not: null } },
        include: { plan: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return res.json({
      success: true,
      configured: stripeLib.isConfigured(),
      seatCount,
      pricePerSeatCents: stripeLib.SEAT_PRICE_CENTS,
      subscription,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/self-serve/checkout', requireRole('AGENCY_OWNER'), async (req, res, next) => {
  try {
    if (!stripeLib.isConfigured()) {
      return res.status(501).json({ success: false, error: 'NOT_CONFIGURED', message: 'Payment processor is not configured yet.' });
    }
    const agency = await prisma.agency.findUnique({ where: { id: req.user.agencyId } });
    if (!agency) return res.status(404).json({ success: false, error: 'AGENCY_NOT_FOUND' });

    const seatCount = await countActiveSeats(agency.id);
    const session = await stripeLib.createCheckoutSession({
      agency,
      seatCount,
      successUrl: `${APP_URL}/agency/billing?checkout=success`,
      cancelUrl: `${APP_URL}/agency/billing?checkout=canceled`,
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: agency.id,
      action: 'billing.self_serve_checkout_started', entityType: 'Agency', entityId: agency.id,
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
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const agencyId = session.client_reference_id;
        if (!agencyId || !session.subscription) break;
        const plan = await stripeLib.ensureSeatPlan();
        const seatCount = await countActiveSeats(agencyId);

        await prisma.$transaction(async (tx) => {
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
          await tx.agency.update({
            where: { id: agencyId },
            data: { crmEnabled: plan.crmEnabled, transfersEnabled: plan.transfersEnabled, coachingEnabled: plan.coachingEnabled },
          });
        });
        await recordAudit({ agencyId, action: 'billing.self_serve_subscription_started', entityType: 'AgencySubscription', entityId: session.subscription, correlationId: req.correlationId });
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const existing = await prisma.agencySubscription.findFirst({ where: { stripeSubscriptionId: sub.id } });
        if (!existing) break;
        await prisma.agencySubscription.update({
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
        const existing = await prisma.agencySubscription.findFirst({ where: { stripeSubscriptionId: sub.id } });
        if (!existing) break;
        await prisma.$transaction([
          prisma.agencySubscription.update({ where: { id: existing.id }, data: { status: 'CANCELED', canceledAt: new Date() } }),
          prisma.agency.update({ where: { id: existing.agencyId }, data: { transfersEnabled: false, coachingEnabled: false } }),
        ]);
        await recordAudit({ agencyId: existing.agencyId, action: 'billing.self_serve_subscription_canceled', entityType: 'AgencySubscription', entityId: existing.id, correlationId: req.correlationId });
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('[stripe webhook] handler error', err);
    // Stripe retries on non-2xx, so still ack receipt of a well-signed
    // event we simply failed to process — same idea as this app's other
    // fire-and-forget async paths (never blocks/loops the caller).
  }

  return res.json({ received: true });
}

module.exports = router;
module.exports.handleStripeWebhook = handleStripeWebhook;
module.exports.mapStripeStatus = mapStripeStatus;
