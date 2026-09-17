const express = require('express');
const { z } = require('zod');
const crypto = require('crypto');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { sendInvitationEmail } = require('../lib/email');

const router = express.Router();

router.use(requireAuth);

// List agencies — Platform Owner sees all; Agency roles see only their own.
router.get('/', async (req, res, next) => {
  try {
    if (req.user.role === 'PLATFORM_OWNER') {
      const agencies = await prisma.agency.findMany({ orderBy: { createdAt: 'desc' } });
      return res.json({ success: true, agencies });
    }
    if (!req.user.agencyId) return res.json({ success: true, agencies: [] });
    const agency = await prisma.agency.findUnique({ where: { id: req.user.agencyId } });
    return res.json({ success: true, agencies: agency ? [agency] : [] });
  } catch (err) {
    next(err);
  }
});

const createAgencySchema = z.object({
  name: z.string().min(2),
  ownerFirstName: z.string().min(1),
  ownerLastName: z.string().min(1),
  ownerEmail: z.string().email(),
  timezone: z.string().default('America/New_York'),
  products: z.array(z.string()).optional().default([]),
});

// Platform Owner only: invite a brand-new agency + its owner in one atomic transaction.
router.post('/', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = createAgencySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const email = parsed.data.ownerEmail.trim().toLowerCase();

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ success: false, error: 'EMAIL_IN_USE', message: 'That email is already registered.' });
    }

    const { agency, invitation, rawToken } = await prisma.$transaction(async (tx) => {
      const agency = await tx.agency.create({
        data: {
          name: parsed.data.name,
          timezone: parsed.data.timezone,
          products: parsed.data.products,
          status: 'INVITED',
        },
      });
      const owner = await tx.user.create({
        data: {
          email,
          firstName: parsed.data.ownerFirstName,
          lastName: parsed.data.ownerLastName,
          role: 'AGENCY_OWNER',
          status: 'INVITED',
          agencyId: agency.id,
        },
      });
      const rawToken = crypto.randomBytes(24).toString('hex');
      const invitation = await tx.invitation.create({
        data: {
          email,
          role: 'AGENCY_OWNER',
          token: rawToken,
          agencyId: agency.id,
          invitedById: req.user.id,
          userId: owner.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      return { agency, invitation, rawToken };
    });

    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      agencyId: agency.id,
      action: 'agency.created',
      entityType: 'Agency',
      entityId: agency.id,
      after: agency,
      correlationId: req.correlationId,
    });

    const emailResult = await sendInvitationEmail({
      to: email,
      role: 'AGENCY_OWNER',
      agencyName: agency.name,
      token: rawToken,
    });

    return res.status(201).json({
      success: true,
      agency,
      invitation: { id: invitation.id, expiresAt: invitation.expiresAt, emailStatus: emailResult.status },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:agencyId', async (req, res, next) => {
  try {
    if (req.user.role !== 'PLATFORM_OWNER' && req.user.agencyId !== req.params.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const agency = await prisma.agency.findUnique({ where: { id: req.params.agencyId } });
    if (!agency) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    return res.json({ success: true, agency });
  } catch (err) {
    next(err);
  }
});

const transferSettingsSchema = z.object({
  transfersEnabled: z.boolean().optional(),
  transferPaused: z.boolean().optional(),
  transferDailyCap: z.number().int().positive().nullable().optional(),
  transferStates: z.array(z.string().length(2)).optional(),
  products: z.array(z.string()).optional(),
  transferFeeCents: z.number().int().positive().nullable().optional(),
});

// Agency Owner configures its own Yield Transfers availability — this is exactly
// what the routing engine reads when deciding where to send a qualified lead.
router.patch('/:agencyId/transfer-settings', requireRole('AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    if (req.user.role !== 'PLATFORM_OWNER' && req.user.agencyId !== req.params.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const parsed = transferSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const before = await prisma.agency.findUnique({ where: { id: req.params.agencyId } });
    if (!before) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const updated = await prisma.agency.update({
      where: { id: req.params.agencyId },
      data: parsed.data,
    });

    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      agencyId: updated.id,
      action: 'agency.transfer_settings_updated',
      entityType: 'Agency',
      entityId: updated.id,
      before: { transfersEnabled: before.transfersEnabled, transferPaused: before.transferPaused, transferDailyCap: before.transferDailyCap, transferStates: before.transferStates, products: before.products, transferFeeCents: before.transferFeeCents },
      after: parsed.data,
      correlationId: req.correlationId,
    });

    return res.json({ success: true, agency: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
