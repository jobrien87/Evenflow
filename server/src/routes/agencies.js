const express = require('express');
const { z } = require('zod');
const crypto = require('crypto');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { sendInvitationEmail } = require('../lib/email');
const { reissueInvitation } = require('../lib/invitations');

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
      invitation: {
        id: invitation.id,
        expiresAt: invitation.expiresAt,
        emailStatus: emailResult.status,
        // Surfaced so the UI can show/copy the link directly when email
        // isn't configured (or failed) — it was being computed and then
        // silently discarded before this, with no way for the inviter to
        // reach it short of reading server logs.
        acceptUrl: emailResult.acceptUrl,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Platform Owner only: reissue the owner's invitation (new token, new
// 7-day expiry, old token invalidated) and resend/re-surface the link —
// covers a lost email, an expired invite, or email simply not being
// configured yet at the time the agency was first created.
router.post('/:agencyId/resend-invite', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agency = await prisma.agency.findUnique({ where: { id: req.params.agencyId } });
    if (!agency) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const owner = await prisma.user.findFirst({
      where: { agencyId: agency.id, role: 'AGENCY_OWNER' },
      orderBy: { createdAt: 'asc' },
    });
    if (!owner) return res.status(404).json({ success: false, error: 'OWNER_NOT_FOUND' });
    if (owner.status === 'ACTIVE') {
      return res.status(409).json({ success: false, error: 'ALREADY_ACTIVE', message: 'This owner has already activated their account.' });
    }

    const rawToken = await prisma.$transaction((tx) =>
      reissueInvitation(tx, { userId: owner.id, email: owner.email, role: 'AGENCY_OWNER', agencyId: agency.id, invitedById: req.user.id })
    );

    const emailResult = await sendInvitationEmail({ to: owner.email, role: 'AGENCY_OWNER', agencyName: agency.name, token: rawToken });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: agency.id,
      action: 'agency.invite_resent', entityType: 'Agency', entityId: agency.id,
      correlationId: req.correlationId,
    });

    return res.json({ success: true, emailStatus: emailResult.status, acceptUrl: emailResult.acceptUrl });
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

module.exports = router;
