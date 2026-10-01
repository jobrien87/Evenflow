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
const boberdoo = require('../lib/boberdoo');
const provisioning = require('../lib/recordStoreProvisioning');

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
        leadType: true, isIpr: true, wholesalePriceCents: true, minimumDailyVolume: true,
        maximumDailyVolume: true, defaultDailyVolume: true, minimumDepositCents: true,
        // Never leak Boberdoo IDs/config to the storefront.
      },
    });
    return res.json({ success: true, templates });
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
      include: { template: { select: { slug: true, displayName: true, isIpr: true } } },
    });
    // Never expose raw Boberdoo IDs to Agency Owners — only Platform Owner's
    // advanced/debug view does (master spec §16).
    const sanitized = subscriptions.map((s) => {
      const { boberdooPartnerId, boberdooFilterSetId, ...rest } = s;
      return req.user.role === 'PLATFORM_OWNER' ? s : rest;
    });
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
    return res.json({ success: true, ...result, paymentPageUrl: boberdoo.getPaymentPageUrl() });
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
    return res.json({ success: true, subscription: result.subscription, paymentPageUrl: result.paymentPageUrl || boberdoo.getPaymentPageUrl() });
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

router.post('/admin/agencies/:agencyId/resume-account', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const result = await provisioning.resumeAccount(req.params.agencyId, req.user.id, req.correlationId);
    if (!result.success) return res.status(409).json({ success: false, error: result.errorCode, message: result.errorMessage });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
