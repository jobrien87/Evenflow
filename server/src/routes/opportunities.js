const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole, scopeAgencyId } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { canTransition } = require('../lib/opportunityStateMachine');
const { parseCrossSellFile, importCrossSellContacts } = require('../lib/crossSellBulkImport');

const router = express.Router();
router.use(requireAuth);

// Mirrors leads.js's bulk-import multer convention: memoryStorage, no
// fileFilter (real validation happens after upload, inside
// parseCrossSellFile), 10MB cap.
const uploadSpreadsheet = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const CROSS_SELL_PRODUCTS = ['Auto', 'Home', 'Life'];

// Opportunities/winbacks are an agency- and producer-side concept — a
// Telemarketer has no legitimate reason to list them, and (since TMs have
// no agencyId of their own) scopeAgencyId(req) returns null for a TM,
// which would otherwise omit the agencyId filter entirely rather than
// scope it. Excluding TELEMARKETER here is the real fix, not new scoping
// logic.
router.get('/', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PRODUCER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencyId = scopeAgencyId(req);
    const where = {
      ...(agencyId ? { agencyId } : {}),
      ...(req.query.type ? { type: req.query.type } : {}),
      ...(req.user.role === 'PRODUCER' ? { assignedToId: req.user.id } : {}),
      status: { notIn: ['WON', 'DECLINED', 'INELIGIBLE'] },
    };
    const opportunities = await prisma.opportunity.findMany({
      where,
      include: { customer: true, events: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
    return res.json({ success: true, opportunities });
  } catch (err) {
    next(err);
  }
});

// Agency Owner/Manager self-service: upload an externally-sourced
// cross-sell report (e.g. an AMS "Auto, no Home" book-of-business export)
// and turn it into real Customer + CROSS_SELL Opportunity rows, via the
// exact same lib/opportunityEvents.js code path a SOLD disposition
// already uses. Registered before any /:id route needs no special
// ordering here since it's its own literal path.
router.post('/bulk-import-cross-sell', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), uploadSpreadsheet.single('file'), async (req, res, next) => {
  try {
    const havesProduct = req.body.havesProduct;
    const needsProduct = req.body.needsProduct;
    if (!CROSS_SELL_PRODUCTS.includes(havesProduct) || !CROSS_SELL_PRODUCTS.includes(needsProduct)) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: `havesProduct/needsProduct must each be one of: ${CROSS_SELL_PRODUCTS.join(', ')}.` });
    }
    if (havesProduct === needsProduct) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'havesProduct and needsProduct must be different.' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'No file uploaded (expected multipart field "file").' });
    }

    const agencyId = req.user.role === 'PLATFORM_OWNER' ? req.body.agencyId : req.user.agencyId;
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const parsed = parseCrossSellFile(req.file.buffer);
    if (parsed.error) {
      return res.status(400).json({ success: false, error: parsed.error, message: parsed.message });
    }
    if (parsed.contacts.length === 0) {
      return res.status(400).json({ success: false, error: 'NO_VALID_ROWS', message: 'No usable rows found in this file.', skipped: parsed.skipped });
    }

    const result = await importCrossSellContacts({ contacts: parsed.contacts, agencyId, havesProduct, needsProduct });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId,
      action: 'opportunity.cross_sell_bulk_imported', entityType: 'Opportunity', entityId: null,
      after: { havesProduct, needsProduct, ...result }, correlationId: req.correlationId,
    });

    return res.status(201).json({
      success: true,
      totalRows: parsed.totalRows,
      truncated: parsed.truncated,
      skipped: parsed.skipped.length,
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

const createWinbackSchema = z.object({
  customerId: z.string().uuid(),
  product: z.string().min(1),
  previousProduct: z.string().optional(),
  previousPremiumCents: z.number().int().positive().optional(),
  lostAt: z.string().datetime().optional(),
  lostReason: z.string().optional(),
  assignedToId: z.string().uuid().optional(),
});

router.post('/winback', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = createWinbackSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const agencyId = req.user.role === 'PLATFORM_OWNER' ? req.body.agencyId : req.user.agencyId;
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const customer = await prisma.customer.findUnique({ where: { id: parsed.data.customerId } });
    if (!customer) return res.status(404).json({ success: false, error: 'CUSTOMER_NOT_FOUND' });

    const opportunity = await prisma.opportunity.create({
      data: {
        agencyId,
        customerId: parsed.data.customerId,
        type: 'WINBACK',
        product: parsed.data.product,
        previousProduct: parsed.data.previousProduct,
        previousPremiumCents: parsed.data.previousPremiumCents,
        lostAt: parsed.data.lostAt ? new Date(parsed.data.lostAt) : null,
        lostReason: parsed.data.lostReason,
        reason: parsed.data.lostReason || 'Manually recorded lapsed customer',
        assignedToId: parsed.data.assignedToId,
        status: parsed.data.assignedToId ? 'ASSIGNED' : 'OPEN',
        priorityScore: 50,
        createdById: req.user.id,
      },
    });

    await prisma.opportunityEvent.create({
      data: { opportunityId: opportunity.id, toStatus: opportunity.status, actorId: req.user.id, reason: 'Created' },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId,
      action: 'opportunity.winback_created', entityType: 'Opportunity', entityId: opportunity.id,
      after: { customerId: parsed.data.customerId, product: parsed.data.product }, correlationId: req.correlationId,
    });

    return res.status(201).json({ success: true, opportunity });
  } catch (err) {
    next(err);
  }
});

const dispositionSchema = z.object({
  status: z.enum(['ASSIGNED', 'ATTEMPTED', 'CONTACTED', 'QUOTED', 'WON', 'DECLINED', 'SNOOZED', 'INELIGIBLE']),
  reason: z.string().optional(),
  wonPremiumCents: z.number().int().positive().optional(),
  snoozeUntil: z.string().datetime().optional(),
  assignedToId: z.string().uuid().optional(),
});

router.post('/:id/disposition', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PRODUCER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = dispositionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const opportunity = await prisma.opportunity.findUnique({ where: { id: req.params.id }, include: { customer: true } });
    if (!opportunity) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && opportunity.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (!canTransition(opportunity.status, parsed.data.status)) {
      return res.status(409).json({ success: false, error: 'INVALID_TRANSITION', from: opportunity.status, to: parsed.data.status });
    }

    const patch = { status: parsed.data.status };
    if (parsed.data.assignedToId) patch.assignedToId = parsed.data.assignedToId;
    if (parsed.data.status === 'SNOOZED' && parsed.data.snoozeUntil) patch.snoozeUntil = new Date(parsed.data.snoozeUntil);
    if (parsed.data.status === 'WON') patch.wonPremiumCents = parsed.data.wonPremiumCents || null;

    const updated = await prisma.opportunity.update({ where: { id: opportunity.id }, data: patch });

    await prisma.opportunityEvent.create({
      data: {
        opportunityId: opportunity.id,
        fromStatus: opportunity.status,
        toStatus: parsed.data.status,
        actorId: req.user.id,
        reason: parsed.data.reason,
      },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: opportunity.agencyId,
      action: 'opportunity.dispositioned', entityType: 'Opportunity', entityId: opportunity.id,
      before: { status: opportunity.status }, after: { status: parsed.data.status }, correlationId: req.correlationId,
    });

    // WON is a pipeline disposition only, same as Lead SOLD — it never
    // posts revenue directly. wonPremiumCents is preserved on the row for
    // history; the one real production entry for an actually-closed sale
    // (including one originating from a won Winback/Cross-Sell
    // opportunity) is an explicit Add Closed Sale (routes/sales.js).

    return res.json({ success: true, opportunity: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
