const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { generateCredential } = require('../lib/vendorAuth');
const { buildPostingInstructions } = require('../lib/postingInstructions');
const { sendVendorPostingEmail } = require('../lib/email');
const { notifyAgencyOwners } = require('../lib/notifications');

const router = express.Router();
router.use(requireAuth);

function scopedAgencyId(req) {
  return req.user.role === 'PLATFORM_OWNER' ? req.query.agencyId || req.body.agencyId : req.user.agencyId;
}

function maskPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const masked = { ...payload };
  if (masked.phone) masked.phone = maskString(masked.phone);
  if (masked.email) masked.email = maskString(masked.email);
  if (masked.last_name) masked.last_name = maskString(masked.last_name);
  return masked;
}
function maskString(s) {
  if (!s || s.length < 3) return '***';
  return s.slice(0, 2) + '*'.repeat(Math.max(s.length - 2, 1));
}

// Never trust client-supplied agent ids blindly — confirm every one is a
// real ACTIVE producer in this exact agency before letting a vendor route
// leads to them.
async function validateSelectedAgentIds(agencyId, ids) {
  if (!ids || ids.length === 0) return { valid: true, invalid: [] };
  const found = await prisma.user.findMany({
    where: { id: { in: ids }, agencyId, role: 'PRODUCER', status: 'ACTIVE' },
    select: { id: true },
  });
  const foundIds = new Set(found.map((u) => u.id));
  const invalid = ids.filter((id) => !foundIds.has(id));
  return { valid: invalid.length === 0, invalid };
}

router.get('/', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencyId = scopedAgencyId(req);
    const vendors = await prisma.vendor.findMany({
      where: agencyId ? { agencyId } : {},
      include: { credentials: { select: { id: true, keyPrefix: true, status: true, lastUsedAt: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, vendors });
  } catch (err) {
    next(err);
  }
});

const VENDOR_CATEGORIES = ['PAID_AD', 'DIRECT_MAIL', 'META_AD', 'INTERNET', 'OTHER'];

const createVendorSchema = z.object({
  agencyId: z.string().uuid().optional(),
  name: z.string().min(1),
  email: z.string().email(),
  product: z.string().min(1),
  costPerLeadCents: z.number().int().positive().nullable().optional(),
  distributionMode: z.enum(['ROUND_ROBIN', 'SELECTED_AGENTS', 'MOSHPIT', 'ALPHA_SPLIT', 'OFFICE_SPLIT']).optional(),
  selectedAgentIds: z.array(z.string().uuid()).optional(),
  // What kind of leads this vendor supplies — every lead sourced from it
  // inherits this as its Lead.leadType (see lib/leadType.js), which drives
  // the configurable priority queue (Agency.priorityRules).
  category: z.enum(VENDOR_CATEGORIES).optional(),
});

router.post('/', requireRole('AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = createVendorSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const agencyId = req.user.role === 'PLATFORM_OWNER' ? parsed.data.agencyId : req.user.agencyId;
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const distributionMode = parsed.data.distributionMode || 'ROUND_ROBIN';
    const category = parsed.data.category || 'OTHER';
    if (distributionMode === 'MOSHPIT' && ['PAID_AD', 'META_AD'].includes(category)) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Paid Ad and Meta Ad vendors cannot use Moshpit distribution — these leads must always be directly assigned, never left to sit unclaimed.' });
    }
    const selectedAgentIds = distributionMode === 'SELECTED_AGENTS' ? (parsed.data.selectedAgentIds || []) : [];
    if (selectedAgentIds.length > 0) {
      const { valid } = await validateSelectedAgentIds(agencyId, selectedAgentIds);
      if (!valid) return res.status(400).json({ success: false, error: 'INVALID_AGENTS', message: 'One or more selected agents are not active producers in this agency.' });
    }

    const { prefix, rawKey, secretHash } = generateCredential();

    const { vendor, credential } = await prisma.$transaction(async (tx) => {
      const vendor = await tx.vendor.create({
        data: {
          name: parsed.data.name,
          email: parsed.data.email,
          agencyId,
          product: parsed.data.product,
          status: 'PENDING',
          createdById: req.user.id,
          costPerLeadCents: parsed.data.costPerLeadCents ?? null,
          distributionMode,
          selectedAgentIds,
          category,
        },
      });
      const credential = await tx.vendorCredential.create({
        data: { vendorId: vendor.id, keyPrefix: prefix, secretHash },
      });
      return { vendor, credential };
    });

    const instructions = buildPostingInstructions({
      vendor,
      credential: { rawKey },
      appApiUrl: process.env.SERVER_URL || 'http://localhost:4000',
    });

    const emailResult = await sendVendorPostingEmail({ to: parsed.data.email, instructions });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId,
      action: 'vendor.created', entityType: 'Vendor', entityId: vendor.id,
      after: { name: vendor.name, product: vendor.product }, correlationId: req.correlationId,
    });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId,
      action: 'vendor.credential_generated', entityType: 'VendorCredential', entityId: credential.id,
      correlationId: req.correlationId,
    });

    return res.status(201).json({
      success: true,
      vendor,
      apiKey: rawKey,
      instructions,
      emailStatus: emailResult.status,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const vendor = await prisma.vendor.findUnique({
      where: { id: req.params.id },
      include: { credentials: { select: { id: true, keyPrefix: true, status: true, lastUsedAt: true, createdAt: true } } },
    });
    if (!vendor) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && vendor.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const instructions = buildPostingInstructions({ vendor, credential: null, appApiUrl: process.env.SERVER_URL || 'http://localhost:4000' });
    return res.json({ success: true, vendor, instructions });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/rotate-credential', requireRole('AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const vendor = await prisma.vendor.findUnique({ where: { id: req.params.id } });
    if (!vendor) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && vendor.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    const { prefix, rawKey, secretHash } = generateCredential();
    const [, credential] = await prisma.$transaction([
      prisma.vendorCredential.updateMany({ where: { vendorId: vendor.id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } }),
      prisma.vendorCredential.create({ data: { vendorId: vendor.id, keyPrefix: prefix, secretHash } }),
    ]);

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: vendor.agencyId,
      action: 'vendor.credential_rotated', entityType: 'Vendor', entityId: vendor.id, correlationId: req.correlationId,
    });

    return res.json({ success: true, apiKey: rawKey, credentialId: credential.id });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/revoke-credential', requireRole('AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const vendor = await prisma.vendor.findUnique({ where: { id: req.params.id } });
    if (!vendor) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && vendor.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    await prisma.vendorCredential.updateMany({ where: { vendorId: vendor.id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: vendor.agencyId,
      action: 'vendor.credential_revoked', entityType: 'Vendor', entityId: vendor.id, correlationId: req.correlationId,
    });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

const updateVendorSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  product: z.string().min(1).optional(),
  costPerLeadCents: z.number().int().positive().nullable().optional(),
  distributionMode: z.enum(['ROUND_ROBIN', 'SELECTED_AGENTS', 'MOSHPIT', 'ALPHA_SPLIT', 'OFFICE_SPLIT']).optional(),
  selectedAgentIds: z.array(z.string().uuid()).optional(),
  category: z.enum(VENDOR_CATEGORIES).optional(),
});

// General field edit — separate from /status below, since a status
// change has its own real side effects (notifications) that a plain
// field edit shouldn't trigger. Vendors were permanently fixed after
// creation except for status before this.
router.patch('/:id', requireRole('AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = updateVendorSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    const vendor = await prisma.vendor.findUnique({ where: { id: req.params.id } });
    if (!vendor) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && vendor.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    const data = { ...parsed.data };
    const nextMode = data.distributionMode || vendor.distributionMode;
    const nextCategory = data.category || vendor.category;
    if (nextMode === 'MOSHPIT' && ['PAID_AD', 'META_AD'].includes(nextCategory)) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Paid Ad and Meta Ad vendors cannot use Moshpit distribution — these leads must always be directly assigned, never left to sit unclaimed.' });
    }
    if (nextMode === 'SELECTED_AGENTS' && data.selectedAgentIds) {
      const { valid } = await validateSelectedAgentIds(vendor.agencyId, data.selectedAgentIds);
      if (!valid) return res.status(400).json({ success: false, error: 'INVALID_AGENTS', message: 'One or more selected agents are not active producers in this agency.' });
    }
    // Switching away from SELECTED_AGENTS with no explicit new list clears
    // the stale selection rather than leaving it silently unused.
    if (data.distributionMode && data.distributionMode !== 'SELECTED_AGENTS' && !data.selectedAgentIds) {
      data.selectedAgentIds = [];
    }

    const updated = await prisma.vendor.update({ where: { id: vendor.id }, data });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: vendor.agencyId,
      action: 'vendor.updated', entityType: 'Vendor', entityId: vendor.id,
      before: { name: vendor.name, email: vendor.email, product: vendor.product, costPerLeadCents: vendor.costPerLeadCents, distributionMode: vendor.distributionMode, selectedAgentIds: vendor.selectedAgentIds },
      after: data, correlationId: req.correlationId,
    });
    return res.json({ success: true, vendor: updated });
  } catch (err) {
    next(err);
  }
});

const statusSchema = z.object({ status: z.enum(['PENDING', 'TESTING', 'VERIFIED', 'LIVE', 'PAUSED']) });

router.patch('/:id/status', requireRole('AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION' });
    const vendor = await prisma.vendor.findUnique({ where: { id: req.params.id } });
    if (!vendor) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && vendor.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const updated = await prisma.vendor.update({ where: { id: vendor.id }, data: { status: parsed.data.status } });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: vendor.agencyId,
      action: 'vendor.status_changed', entityType: 'Vendor', entityId: vendor.id,
      before: { status: vendor.status }, after: { status: updated.status }, correlationId: req.correlationId,
    });

    if (['PAUSED', 'FAILED'].includes(parsed.data.status)) {
      await notifyAgencyOwners(vendor.agencyId, {
        type: 'vendor.status_changed',
        severity: 'WARNING',
        title: `Vendor ${updated.name} is now ${parsed.data.status}`,
        body: parsed.data.status === 'PAUSED' ? 'This vendor connection will not accept new leads until reactivated.' : 'This vendor connection has failed and needs attention.',
        relatedEntityType: 'Vendor',
        relatedEntityId: vendor.id,
      });
    }

    return res.json({ success: true, vendor: updated });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/transactions', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const vendor = await prisma.vendor.findUnique({ where: { id: req.params.id } });
    if (!vendor) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && vendor.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const transactions = await prisma.apiTransaction.findMany({
      where: { vendorId: vendor.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const masked = transactions.map((t) => ({ ...t, rawPayload: maskPayload(t.rawPayload) }));
    return res.json({ success: true, transactions: masked });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
