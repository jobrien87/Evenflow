// Record Store — EvenFlow's self-service wholesale lead marketplace, built
// on top of lib/boberdoo.js and lib/recordStoreProvisioning.js. This route
// file is intentionally thin: every real Boberdoo interaction and every
// state transition lives in the provisioning orchestrator — nothing here
// scatters raw fetch calls or field-mapping logic (master spec §22).
//
// Access: Agency Owner/Manager manage their OWN agency's Record Store;
// Platform Owner (Super Admin) manages any agency plus the template
// catalog. Ordinary Producers/Telemarketers never reach this router at
// all (see navConfig.js — no Record Store nav item for those roles, and
// every mutation below re-derives agencyId from the session, never trusts
// a client-supplied one for a non-platform-owner).
const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const provisioning = require('../lib/recordStoreProvisioning');
const stripeLib = require('../lib/stripe');
const { notifyAgencyOwners, notifyPlatformOwners } = require('../lib/notifications');
const { computeSourcePerformance } = require('../lib/recordStoreSourcePerformance');
const { labelSources, decodeAcceptedSources } = require('../lib/recordStoreSourceLabels');

const APP_URL = process.env.APP_URL || 'http://localhost:5173';

const router = express.Router();
router.use(requireAuth);

const AGENCY_ROLES = ['AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'];

// A sensible, generous cap on the handful of real mutating actions here
// (order/provision/pause/resume/volume) — defense in depth against a
// scripted rapid-fire client, matching auth.js's loginLimiter shape.
const mutationLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

function scopedAgencyId(req) {
  return req.user.role === 'PLATFORM_OWNER' ? (req.query.agencyId || req.body.agencyId || req.params.agencyId) : req.user.agencyId;
}

// ---- Storefront ----------------------------------------------------

router.get('/templates', requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    const templates = await prisma.recordStoreTemplate.findMany({
      where: { active: true, customerVisible: true },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true, slug: true, displayName: true, description: true, productCategory: true,
        leadType: true, isIpr: true, isCustomBuilder: true, wholesalePriceCents: true, minimumDailyVolume: true,
        maximumDailyVolume: true, defaultDailyVolume: true, minimumDepositCents: true,
        // Never leak Boberdoo IDs/config to the storefront.
      },
    });
    return res.json({ success: true, templates });
  } catch (err) {
    next(err);
  }
});

// ---- Custom Builder (customer) -----------------------------------------
// The 3 lead types with a confirmed-real Boberdoo TYPE id (pulled from a
// live account via getPartnerSettings, 2026-10-22) — not a freeform field,
// never a customer-supplied raw TYPE id. The admin confirms/sets the real
// boberdooTypeId again at quote time (see admin quote route below), same
// "never fabricate a Boberdoo id" discipline as RecordStoreTemplate's own
// boberdooTypeId field.
const CUSTOM_LEAD_TYPES = [
  { label: 'Auto Insurance', boberdooTypeId: '23' },
  { label: 'Home Insurance', boberdooTypeId: '21' },
  { label: 'Life Insurance', boberdooTypeId: '19' },
];

router.get('/lead-types', requireRole(...AGENCY_ROLES), async (req, res) => {
  return res.json({ success: true, leadTypes: CUSTOM_LEAD_TYPES.map((t) => ({ label: t.label })) });
});

router.get('/sources', requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    const leadType = CUSTOM_LEAD_TYPES.find((t) => t.label === req.query.leadType);
    if (!leadType) return res.status(400).json({ success: false, error: 'INVALID_LEAD_TYPE' });
    const result = await provisioning.listSources(leadType.boberdooTypeId);
    return res.json({ success: true, sources: result.sources, live: result.live });
  } catch (err) {
    next(err);
  }
});

const createCustomRequestSchema = z.object({
  leadTypeLabel: z.enum(CUSTOM_LEAD_TYPES.map((t) => t.label)),
  sources: z.array(z.string().trim().min(1)).max(20).default([]),
  dailyLimit: z.number().int().positive().max(1000).optional(),
  weeklyLimit: z.number().int().positive().max(5000).optional(),
  monthlyLimit: z.number().int().positive().max(20000).optional(),
  notes: z.string().trim().max(2000).optional(),
});

router.post('/custom-requests', mutationLimiter, requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    const parsed = createCustomRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    const agencyId = req.user.role === 'PLATFORM_OWNER' ? (req.body.agencyId || req.user.agencyId) : req.user.agencyId;
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const request = await prisma.recordStoreCustomRequest.create({
      data: { agencyId, requestedById: req.user.id, ...parsed.data },
    });

    await recordAudit({
      actorId: req.user.id, agencyId, action: 'RECORD_STORE_CUSTOM_REQUEST_SUBMITTED',
      entityType: 'RecordStoreCustomRequest', entityId: request.id,
      after: { leadTypeLabel: request.leadTypeLabel }, correlationId: req.correlationId,
    });
    await notifyPlatformOwners(agencyId, {
      type: 'record_store.custom_request_submitted',
      severity: 'ACTION',
      title: 'New Record Store custom request needs a quote',
      body: `${req.user.firstName} ${req.user.lastName} requested a custom ${request.leadTypeLabel} lead program.`,
      relatedEntityType: 'RecordStoreCustomRequest', relatedEntityId: request.id,
    });

    return res.status(201).json({ success: true, request });
  } catch (err) {
    next(err);
  }
});

router.get('/custom-requests', requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    const agencyId = scopedAgencyId(req);
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    const requests = await prisma.recordStoreCustomRequest.findMany({ where: { agencyId }, orderBy: { createdAt: 'desc' } });
    const withLabels = await Promise.all(requests.map(async (r) => ({ ...r, sourceLabels: (await labelSources(r.sources)).map((l) => l.label) })));
    return res.json({ success: true, requests: withLabels });
  } catch (err) {
    next(err);
  }
});

router.post('/custom-requests/:id/accept', mutationLimiter, requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    const request = await prisma.recordStoreCustomRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && request.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (request.status !== 'QUOTED') {
      return res.status(409).json({ success: false, error: 'NOT_QUOTED', message: 'This request has not been quoted yet.' });
    }

    // Accepting a quote always creates a genuinely new program (never a
    // re-order of something already held), so the balance gate always
    // applies here when the agency has funded before.
    const agency = await prisma.agency.findUnique({ where: { id: request.agencyId } });
    const balanceCheck = await provisioning.checkBalanceForAdditionalProduct(agency);
    if (!balanceCheck.ok) {
      return res.status(409).json({
        success: false, error: balanceCheck.errorCode, message: balanceCheck.errorMessage,
        currentBalanceCents: balanceCheck.currentBalanceCents, requiredBalanceCents: balanceCheck.requiredBalanceCents,
      });
    }

    const template = await prisma.recordStoreTemplate.findFirst({ where: { isCustomBuilder: true } });
    if (!template) return res.status(500).json({ success: false, error: 'NO_CUSTOM_TEMPLATE' });

    const { subscription } = await provisioning.createSubscriptionFromQuote(request, template, req.user.id);
    return res.status(201).json({ success: true, subscription });
  } catch (err) {
    next(err);
  }
});

// ---- My Lead Programs ------------------------------------------------

router.get('/subscriptions', requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    const agencyId = scopedAgencyId(req);
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    const subscriptions = await prisma.recordStoreSubscription.findMany({
      where: { agencyId, status: { not: 'CANCELLED' } },
      orderBy: { createdAt: 'desc' },
      include: { template: { select: { slug: true, displayName: true, isIpr: true, configurationJson: true } } },
    });
    // Never expose raw Boberdoo IDs to Agency Owners — only Platform Owner's
    // advanced/debug view does (master spec §16).
    const sanitized = await Promise.all(subscriptions.map(async (s) => {
      const { boberdooPartnerId, boberdooFilterSetId, ...rest } = s;
      const config = { ...(s.template?.configurationJson || {}), ...(s.customConfigurationJson || {}) };
      const acceptedSourceLabels = await decodeAcceptedSources(config.Accepted_Sources);
      const base = req.user.role === 'PLATFORM_OWNER' ? s : rest;
      return { ...base, acceptedSourceLabels };
    }));
    return res.json({ success: true, subscriptions: sanitized });
  } catch (err) {
    next(err);
  }
});

router.get('/balance', requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    const agencyId = scopedAgencyId(req);
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    const result = await provisioning.refreshAgencyBalance(agencyId);
    if (!result.success) return res.status(502).json({ success: false, error: result.errorCode, message: result.errorMessage });
    return res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// ---- Orders / provisioning --------------------------------------------

const createOrderSchema = z.object({
  templateSlug: z.string().min(1),
  dailyVolume: z.number().int().positive(),
  agencyId: z.string().uuid().optional(),
  // Live Call (IPR) only — the one business-level delivery field a
  // customer sets themselves (master spec §7).
  ringToPhone: z.string().trim().min(7).max(20).optional(),
  maxConcurrentCalls: z.number().int().positive().max(50).optional(),
});

router.post('/orders', mutationLimiter, requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    const agencyId = req.user.role === 'PLATFORM_OWNER' ? (parsed.data.agencyId || req.user.agencyId) : req.user.agencyId;
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const template = await prisma.recordStoreTemplate.findUnique({ where: { slug: parsed.data.templateSlug } });
    if (!template || !template.active) return res.status(404).json({ success: false, error: 'TEMPLATE_NOT_FOUND' });
    if (!template.wholesalePriceCents) {
      return res.status(409).json({ success: false, error: 'TEMPLATE_NOT_PRICED', message: 'This product is not yet available for purchase.' });
    }

    // Only a genuinely NEW product (no existing non-cancelled/non-error
    // subscription for this exact template — the same predicate
    // createOrder's own dedup check uses) is gated on balance. Re-ordering
    // something already DRAFT/PENDING/ACTIVE/PAUSED just returns that
    // existing row below, same as always — no fresh financial commitment,
    // so nothing to gate.
    const existingForTemplate = await prisma.recordStoreSubscription.findFirst({
      where: { agencyId, recordStoreTemplateId: template.id, status: { notIn: ['CANCELLED', 'ERROR'] } },
    });
    if (!existingForTemplate) {
      const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
      const balanceCheck = await provisioning.checkBalanceForAdditionalProduct(agency);
      if (!balanceCheck.ok) {
        return res.status(409).json({
          success: false, error: balanceCheck.errorCode, message: balanceCheck.errorMessage,
          currentBalanceCents: balanceCheck.currentBalanceCents, requiredBalanceCents: balanceCheck.requiredBalanceCents,
        });
      }
    }

    const { subscription, created } = await provisioning.createOrder({
      agencyId, template, dailyVolume: parsed.data.dailyVolume, userId: req.user.id,
      ringToPhone: parsed.data.ringToPhone, maxConcurrentCalls: parsed.data.maxConcurrentCalls,
    });
    return res.status(created ? 201 : 200).json({ success: true, subscription, created });
  } catch (err) {
    next(err);
  }
});

async function loadOwnedSubscription(req) {
  const subscription = await prisma.recordStoreSubscription.findUnique({ where: { id: req.params.id } });
  if (!subscription) return { error: { status: 404, body: { success: false, error: 'NOT_FOUND' } } };
  if (req.user.role !== 'PLATFORM_OWNER' && subscription.agencyId !== req.user.agencyId) {
    return { error: { status: 403, body: { success: false, error: 'FORBIDDEN' } } };
  }
  return { subscription };
}

router.post('/orders/:id/provision', mutationLimiter, requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    const { subscription, error } = await loadOwnedSubscription(req);
    if (error) return res.status(error.status).json(error.body);
    const result = await provisioning.provisionSubscription(subscription.id, req.correlationId);
    if (!result.success) return res.status(502).json({ success: false, error: result.errorCode, message: result.errorMessage });
    return res.json({ success: true, subscription: result.subscription });
  } catch (err) {
    next(err);
  }
});

router.post('/orders/:id/confirm-funding', mutationLimiter, requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    const { subscription, error } = await loadOwnedSubscription(req);
    if (error) return res.status(error.status).json(error.body);
    const result = await provisioning.refreshFundingStatus(subscription.id, req.correlationId);
    if (!result.success) return res.status(502).json({ success: false, error: result.errorCode, message: result.errorMessage });
    return res.json({ success: true, satisfied: result.satisfied, subscription: result.subscription });
  } catch (err) {
    next(err);
  }
});

// A sane range for a deposit/top-up: at least $1, no more than $50,000 in
// one payment (fat-finger/abuse guard, not a real product limit).
const fundingCheckoutSchema = z.object({
  amountCents: z.number().int().min(100).max(5_000_000),
});

// Funds (or tops up) a specific lead program's order — used from the
// wizard's "Fund Account" step. Real money is collected via Stripe
// Checkout here; crediting Boberdoo's own balance happens only once the
// webhook confirms the charge (routes/billing.js).
router.post('/orders/:id/funding-checkout', mutationLimiter, requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    if (!stripeLib.isConfigured()) {
      return res.status(501).json({ success: false, error: 'NOT_CONFIGURED', message: 'Payment processor is not configured yet.' });
    }
    const parsed = fundingCheckoutSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const { subscription, error } = await loadOwnedSubscription(req);
    if (error) return res.status(error.status).json(error.body);

    const agency = await prisma.agency.findUnique({ where: { id: subscription.agencyId } });
    if (!agency.boberdooPartnerId) {
      return res.status(409).json({ success: false, error: 'NOT_PROVISIONED', message: 'This lead program has not finished setup yet — provision it first.' });
    }

    const session = await stripeLib.createRecordStoreFundingCheckoutSession({
      agency,
      amountCents: parsed.data.amountCents,
      recordStoreSubscriptionId: subscription.id,
      successUrl: `${APP_URL}/agency/record-store?funding=success&subscriptionId=${subscription.id}`,
      cancelUrl: `${APP_URL}/agency/record-store?funding=canceled`,
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: subscription.agencyId,
      action: 'record_store.funding_checkout_started', entityType: 'RecordStoreSubscription', entityId: subscription.id,
      after: { amountCents: parsed.data.amountCents }, correlationId: req.correlationId,
    });

    return res.json({ success: true, url: session.url });
  } catch (err) {
    next(err);
  }
});

// A generic top-up, not tied to any one order — used from the "ADD FUNDS"
// button on the account-wide balance card.
router.post('/funding-checkout', mutationLimiter, requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    if (!stripeLib.isConfigured()) {
      return res.status(501).json({ success: false, error: 'NOT_CONFIGURED', message: 'Payment processor is not configured yet.' });
    }
    const parsed = fundingCheckoutSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const agencyId = scopedAgencyId(req);
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
    if (!agency?.boberdooPartnerId) {
      return res.status(409).json({ success: false, error: 'NOT_PROVISIONED', message: 'Set up a lead program first.' });
    }

    const session = await stripeLib.createRecordStoreFundingCheckoutSession({
      agency,
      amountCents: parsed.data.amountCents,
      successUrl: `${APP_URL}/agency/record-store?funding=success`,
      cancelUrl: `${APP_URL}/agency/record-store?funding=canceled`,
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId,
      action: 'record_store.funding_checkout_started', entityType: 'Agency', entityId: agencyId,
      after: { amountCents: parsed.data.amountCents }, correlationId: req.correlationId,
    });

    return res.json({ success: true, url: session.url });
  } catch (err) {
    next(err);
  }
});

// ---- Pause / resume / volume (single product) --------------------------

router.post('/subscriptions/:id/pause', mutationLimiter, requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    const { subscription, error } = await loadOwnedSubscription(req);
    if (error) return res.status(error.status).json(error.body);
    const result = await provisioning.pauseSubscription(subscription.id, req.user.id, req.correlationId);
    if (!result.success) return res.status(409).json({ success: false, error: result.errorCode, message: result.errorMessage });
    return res.json({ success: true, subscription: result.subscription });
  } catch (err) {
    next(err);
  }
});

router.post('/subscriptions/:id/resume', mutationLimiter, requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    const { subscription, error } = await loadOwnedSubscription(req);
    if (error) return res.status(error.status).json(error.body);
    const result = await provisioning.resumeSubscription(subscription.id, req.user.id, req.correlationId);
    if (!result.success) return res.status(409).json({ success: false, error: result.errorCode, message: result.errorMessage });
    return res.json({ success: true, subscription: result.subscription });
  } catch (err) {
    next(err);
  }
});

const volumeSchema = z.object({ dailyVolume: z.number().int().positive() });

router.post('/subscriptions/:id/volume', mutationLimiter, requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    const parsed = volumeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    const { subscription, error } = await loadOwnedSubscription(req);
    if (error) return res.status(error.status).json(error.body);
    const result = await provisioning.changeDailyVolume(subscription.id, parsed.data.dailyVolume, req.user.id, req.correlationId);
    if (!result.success) return res.status(409).json({ success: false, error: result.errorCode, message: result.errorMessage });
    return res.json({ success: true, subscription: result.subscription });
  } catch (err) {
    next(err);
  }
});

// ---- Source performance / 30-day auto-optimization --------------------
// Real, continuously-refreshed per-source numbers (lead count, quote
// rate, close rate, revenue) for one lead program — see
// lib/recordStoreSourcePerformance.js. Defaults to the same 30-day
// rolling window the automatic optimizer itself evaluates, so what an
// agency sees here always matches the reasoning behind its last
// automatic change.
router.get('/subscriptions/:id/source-performance', requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    const { subscription, error } = await loadOwnedSubscription(req);
    if (error) return res.status(error.status).json(error.body);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const performance = await computeSourcePerformance({ subscriptionId: subscription.id, from, to });
    const history = await prisma.recordStoreSourceOptimization.findMany({
      where: { recordStoreSubscriptionId: subscription.id },
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: { id: true, windowStart: true, windowEnd: true, droppedSources: true, reasoning: true, status: true, createdAt: true },
    });
    const historyLabeled = await Promise.all(history.map(async (h) => ({ ...h, droppedSourceLabels: (await labelSources(h.droppedSources)).map((l) => l.label) })));
    return res.json({ success: true, performance, history: historyLabeled, autoOptimizeSources: subscription.autoOptimizeSources });
  } catch (err) {
    next(err);
  }
});

const autoOptimizeSchema = z.object({ autoOptimizeSources: z.boolean() });

router.patch('/subscriptions/:id/auto-optimize', mutationLimiter, requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    const parsed = autoOptimizeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    const { subscription, error } = await loadOwnedSubscription(req);
    if (error) return res.status(error.status).json(error.body);
    const updated = await prisma.recordStoreSubscription.update({
      where: { id: subscription.id },
      data: { autoOptimizeSources: parsed.data.autoOptimizeSources },
    });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: subscription.agencyId,
      action: 'RECORD_STORE_AUTO_OPTIMIZE_TOGGLED', entityType: 'RecordStoreSubscription', entityId: subscription.id,
      after: { autoOptimizeSources: parsed.data.autoOptimizeSources }, correlationId: req.correlationId,
    });
    return res.json({ success: true, subscription: updated });
  } catch (err) {
    next(err);
  }
});

// ---- Pause / resume (whole account) --------------------------------------

router.post('/account/pause-all', mutationLimiter, requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    const agencyId = scopedAgencyId(req);
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    const result = await provisioning.pauseAccount(agencyId, req.user.id, req.correlationId);
    if (!result.success) return res.status(409).json({ success: false, error: result.errorCode, message: result.errorMessage });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/account/resume-all', mutationLimiter, requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    const agencyId = scopedAgencyId(req);
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    const result = await provisioning.resumeAccount(agencyId, req.user.id, req.correlationId);
    if (!result.success) return res.status(409).json({ success: false, error: result.errorCode, message: result.errorMessage });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ---- Activity feed -------------------------------------------------------
// Reuses AuditEvent exactly like agencies.js's own activity route — a
// simplified view for Agency Owner/Manager, the full technical trail
// (before/after/metadata/correlationId) for Platform Owner only.
const RECORD_STORE_ACTIONS = [
  'RECORD_STORE_ORDER_CREATED', 'BOBERDOO_PARTNER_CREATED', 'BOBERDOO_PARTNER_LINKED', 'FILTER_SET_CREATED',
  'DEPOSIT_CONFIRMED', 'FILTER_SET_ACTIVATED', 'FILTER_SET_PAUSED', 'FILTER_SET_RESUMED',
  'DAILY_VOLUME_CHANGED', 'PARTNER_PAUSED', 'PARTNER_RESUMED',
];

router.get('/activity', requireRole(...AGENCY_ROLES), async (req, res, next) => {
  try {
    const agencyId = scopedAgencyId(req);
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    const events = await prisma.auditEvent.findMany({
      where: { agencyId, action: { in: RECORD_STORE_ACTIONS } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const isAdmin = req.user.role === 'PLATFORM_OWNER';
    const simplified = events.map((e) => (isAdmin ? e : { id: e.id, action: e.action, entityType: e.entityType, createdAt: e.createdAt }));
    return res.json({ success: true, events: simplified });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// SUPER ADMIN — Record Store control center
// ============================================================================

// Low-balance gate thresholds — same singleton-settings pattern as
// routes/breakRoom.js's GET/PATCH /admin/platform-settings.
router.get('/admin/platform-settings', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const settings = await prisma.recordStorePlatformSettings.findUnique({ where: { id: 'singleton' } });
    return res.json({ success: true, settings: settings || { id: 'singleton', lowBalanceThresholdCents: 25000, topUpTargetCents: 50000 } });
  } catch (err) {
    next(err);
  }
});

const platformSettingsSchema = z.object({
  lowBalanceThresholdCents: z.number().int().positive(),
  topUpTargetCents: z.number().int().positive(),
}).refine((data) => data.topUpTargetCents > data.lowBalanceThresholdCents, {
  message: 'The top-up target must be higher than the low-balance threshold.',
});

router.patch('/admin/platform-settings', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = platformSettingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    const settings = await prisma.recordStorePlatformSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...parsed.data },
      update: parsed.data,
    });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, action: 'RECORD_STORE_PLATFORM_SETTINGS_UPDATED',
      entityType: 'RecordStorePlatformSettings', entityId: 'singleton', after: parsed.data, correlationId: req.correlationId,
    });
    return res.json({ success: true, settings });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/templates', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const templates = await prisma.recordStoreTemplate.findMany({ orderBy: { sortOrder: 'asc' } });
    return res.json({ success: true, templates });
  } catch (err) {
    next(err);
  }
});

const templatePatchSchema = z.object({
  displayName: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  productCategory: z.string().min(1).optional(),
  leadType: z.string().min(1).optional(),
  boberdooTypeId: z.string().optional().nullable(),
  boberdooTemplateReference: z.string().optional().nullable(),
  filterSetType: z.enum(['STANDARD', 'IPR']).optional(),
  isIpr: z.boolean().optional(),
  wholesalePriceCents: z.number().int().positive().optional().nullable(),
  minimumDailyVolume: z.number().int().positive().optional(),
  maximumDailyVolume: z.number().int().positive().optional(),
  defaultDailyVolume: z.number().int().positive().optional(),
  minimumDepositCents: z.number().int().positive().optional(),
  active: z.boolean().optional(),
  customerVisible: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  configurationJson: z.record(z.any()).optional().nullable(),
});

router.patch('/admin/templates/:id', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = templatePatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    const before = await prisma.recordStoreTemplate.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    const template = await prisma.recordStoreTemplate.update({ where: { id: req.params.id }, data: parsed.data });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, action: 'RECORD_STORE_TEMPLATE_UPDATED',
      entityType: 'RecordStoreTemplate', entityId: template.id, before: parsed.data && Object.fromEntries(Object.keys(parsed.data).map((k) => [k, before[k]])), after: parsed.data,
      correlationId: req.correlationId,
    });
    return res.json({ success: true, template });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/customers', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencies = await prisma.agency.findMany({
      where: { recordStoreSubscriptions: { some: {} } },
      select: {
        id: true, name: true, boberdooPartnerId: true, boberdooPartnerStatus: true,
        boberdooSyncStatus: true, boberdooSyncError: true, boberdooLastSyncAt: true,
        recordStoreDepositConfirmedAt: true, recordStoreBalanceCents: true, recordStoreBalanceCheckedAt: true,
        users: { where: { role: 'AGENCY_OWNER' }, select: { firstName: true, lastName: true, email: true }, take: 1 },
        recordStoreSubscriptions: {
          where: { status: { not: 'CANCELLED' } },
          select: { id: true, productNameSnapshot: true, status: true, dailyVolume: true, priceSnapshotCents: true, boberdooFilterSetId: true },
        },
      },
    });
    return res.json({ success: true, agencies });
  } catch (err) {
    next(err);
  }
});

const linkPartnerSchema = z.object({ partnerId: z.string().min(1) });

router.post('/admin/agencies/:agencyId/link-partner', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = linkPartnerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    const result = await provisioning.linkExistingPartner(req.params.agencyId, parsed.data.partnerId, req.user.id, req.correlationId);
    if (!result.success) return res.status(409).json({ success: false, error: result.errorCode, message: result.errorMessage });
    return res.json({ success: true, partnerInfo: result.partnerInfo });
  } catch (err) {
    next(err);
  }
});

const importFilterSetSchema = z.object({ boberdooFilterSetId: z.string().min(1) });

// For a Partner who was already live in Boberdoo before being linked into
// EvenFlow (see link-partner above) — mirrors one of their real, existing
// Filter Sets into a real RecordStoreSubscription, pulling price/caps/
// sources straight from Boberdoo's own getFilterSet response.
router.post('/admin/agencies/:agencyId/import-filter-set', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = importFilterSetSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    const result = await provisioning.importExistingFilterSet(req.params.agencyId, parsed.data.boberdooFilterSetId, req.user.id, req.correlationId);
    if (!result.success) return res.status(409).json({ success: false, error: result.errorCode, message: result.errorMessage });
    return res.status(201).json({ success: true, subscription: result.subscription });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/agencies/:agencyId/sync', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const result = await provisioning.refreshAgencyBalance(req.params.agencyId);
    if (!result.success) return res.status(502).json({ success: false, error: result.errorCode, message: result.errorMessage });
    return res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/subscriptions/:id/retry', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const result = await provisioning.provisionSubscription(req.params.id, req.correlationId);
    if (!result.success) return res.status(502).json({ success: false, error: result.errorCode, message: result.errorMessage });
    return res.json({ success: true, subscription: result.subscription });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/agencies/:agencyId/pause-account', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const result = await provisioning.pauseAccount(req.params.agencyId, req.user.id, req.correlationId);
    if (!result.success) return res.status(409).json({ success: false, error: result.errorCode, message: result.errorMessage });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Cross-agency oversight of the automatic optimizer — every run it has
// ever made (or attempted), newest first, so a Platform Owner can audit
// "what has EvenFlow actually been changing" across the whole book of
// business, not just trust that it's working.
router.get('/admin/source-optimizations', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const where = req.query.status ? { status: req.query.status } : {};
    const runs = await prisma.recordStoreSourceOptimization.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { subscription: { select: { agencyId: true, productNameSnapshot: true, agency: { select: { name: true } } } } },
    });
    const withLabels = await Promise.all(runs.map(async (r) => ({
      ...r,
      droppedSourceLabels: (await labelSources(r.droppedSources)).map((l) => l.label),
    })));
    return res.json({ success: true, runs: withLabels });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/agencies/:agencyId/resume-account', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const result = await provisioning.resumeAccount(req.params.agencyId, req.user.id, req.correlationId);
    if (!result.success) return res.status(409).json({ success: false, error: result.errorCode, message: result.errorMessage });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ---- Custom Builder (admin) ---------------------------------------------

router.get('/admin/custom-requests', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const where = req.query.status ? { status: req.query.status } : {};
    const requests = await prisma.recordStoreCustomRequest.findMany({ where, orderBy: { createdAt: 'desc' } });
    // agencyId is a plain scalar FK on this model (no Prisma relation, by
    // design — matches CreditRequest's minimal style), so the agency name
    // is resolved with a separate batch lookup rather than an include.
    const agencies = await prisma.agency.findMany({
      where: { id: { in: [...new Set(requests.map((r) => r.agencyId))] } },
      select: { id: true, name: true },
    });
    const agencyNameById = new Map(agencies.map((a) => [a.id, a.name]));
    const withAgency = await Promise.all(requests.map(async (r) => ({
      ...r,
      agency: { name: agencyNameById.get(r.agencyId) || '—' },
      sourceLabels: (await labelSources(r.sources)).map((l) => l.label),
    })));
    return res.json({ success: true, requests: withAgency });
  } catch (err) {
    next(err);
  }
});

const quoteCustomRequestSchema = z.object({
  quotedPriceCents: z.number().int().positive(),
  boberdooTypeId: z.string().min(1),
  decisionNotes: z.string().trim().max(2000).optional(),
});

router.patch('/admin/custom-requests/:id/quote', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = quoteCustomRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    const request = await prisma.recordStoreCustomRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (request.status !== 'PENDING_REVIEW') {
      return res.status(409).json({ success: false, error: 'ALREADY_DECIDED', message: 'This request has already been quoted or declined.' });
    }

    const updated = await prisma.recordStoreCustomRequest.update({
      where: { id: request.id },
      data: {
        status: 'QUOTED',
        quotedPriceCents: parsed.data.quotedPriceCents,
        boberdooTypeId: parsed.data.boberdooTypeId,
        decisionNotes: parsed.data.decisionNotes,
        decidedById: req.user.id,
        decidedAt: new Date(),
      },
    });

    await recordAudit({
      actorId: req.user.id, agencyId: request.agencyId, action: 'RECORD_STORE_CUSTOM_REQUEST_QUOTED',
      entityType: 'RecordStoreCustomRequest', entityId: request.id,
      after: { quotedPriceCents: parsed.data.quotedPriceCents }, correlationId: req.correlationId,
    });
    await notifyAgencyOwners(request.agencyId, {
      type: 'record_store.custom_request_quoted',
      severity: 'ACTION',
      title: 'Your custom Record Store quote is ready',
      body: `Your ${request.leadTypeLabel} lead program was quoted at $${(parsed.data.quotedPriceCents / 100).toFixed(2)}/lead — review and accept to continue.`,
      relatedEntityType: 'RecordStoreCustomRequest', relatedEntityId: request.id,
    });

    return res.json({ success: true, request: updated });
  } catch (err) {
    next(err);
  }
});

const declineCustomRequestSchema = z.object({ decisionNotes: z.string().trim().min(1).max(2000) });

router.patch('/admin/custom-requests/:id/decline', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = declineCustomRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    const request = await prisma.recordStoreCustomRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (request.status !== 'PENDING_REVIEW') {
      return res.status(409).json({ success: false, error: 'ALREADY_DECIDED', message: 'This request has already been quoted or declined.' });
    }

    const updated = await prisma.recordStoreCustomRequest.update({
      where: { id: request.id },
      data: { status: 'DECLINED', decisionNotes: parsed.data.decisionNotes, decidedById: req.user.id, decidedAt: new Date() },
    });

    await recordAudit({
      actorId: req.user.id, agencyId: request.agencyId, action: 'RECORD_STORE_CUSTOM_REQUEST_DECLINED',
      entityType: 'RecordStoreCustomRequest', entityId: request.id,
      after: { decisionNotes: parsed.data.decisionNotes }, correlationId: req.correlationId,
    });
    await notifyAgencyOwners(request.agencyId, {
      type: 'record_store.custom_request_declined',
      severity: 'INFO',
      title: 'Your custom Record Store request was declined',
      body: parsed.data.decisionNotes,
      relatedEntityType: 'RecordStoreCustomRequest', relatedEntityId: request.id,
    });

    return res.json({ success: true, request: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
