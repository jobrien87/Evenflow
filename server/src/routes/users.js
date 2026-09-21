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

// List users in the caller's own agency (or, for Platform Owner, filterable by agencyId).
router.get('/', async (req, res, next) => {
  try {
    let agencyId;
    if (req.user.role === 'PLATFORM_OWNER') {
      agencyId = req.query.agencyId || undefined;
    } else {
      agencyId = req.user.agencyId;
      // A non-Platform-Owner with no agencyId (e.g. a Telemarketer, who
      // isn't tied to one agency) must never fall through to an
      // unscoped `where: {}` — that would leak every user platform-wide.
      // Same pattern leads.js already uses for the equivalent case.
      if (!agencyId) return res.json({ success: true, users: [] });
    }
    const users = await prisma.user.findMany({
      where: agencyId ? { agencyId } : {},
      select: {
        id: true, email: true, firstName: true, lastName: true, role: true,
        status: true, agencyId: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, users });
  } catch (err) {
    next(err);
  }
});

const inviteSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(['AGENCY_MANAGER', 'PRODUCER']),
});

// Agency Owner/Manager invites a Producer or Manager into THEIR OWN agency only.
router.post('/invite', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const agencyId = req.user.role === 'PLATFORM_OWNER' ? req.body.agencyId : req.user.agencyId;
    if (!agencyId) {
      return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    }
    const email = parsed.data.email.trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ success: false, error: 'EMAIL_IN_USE' });
    }

    const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
    if (!agency) return res.status(404).json({ success: false, error: 'AGENCY_NOT_FOUND' });

    const { user, rawToken } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          firstName: parsed.data.firstName,
          lastName: parsed.data.lastName,
          role: parsed.data.role,
          status: 'INVITED',
          agencyId,
          invitedById: req.user.id,
        },
      });
      const rawToken = crypto.randomBytes(24).toString('hex');
      await tx.invitation.create({
        data: {
          email,
          role: parsed.data.role,
          token: rawToken,
          agencyId,
          invitedById: req.user.id,
          userId: user.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      return { user, rawToken };
    });

    const emailResult = await sendInvitationEmail({
      to: email,
      role: parsed.data.role,
      agencyName: agency.name,
      token: rawToken,
    });

    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      agencyId,
      action: 'user.invited',
      entityType: 'User',
      entityId: user.id,
      after: { email, role: parsed.data.role },
      correlationId: req.correlationId,
    });

    return res.status(201).json({
      success: true,
      user: { id: user.id, email: user.email, role: user.role, status: user.status },
      emailStatus: emailResult.status,
      acceptUrl: emailResult.acceptUrl,
    });
  } catch (err) {
    next(err);
  }
});

// Reissue + resend a still-pending invitation (new token, new 7-day expiry).
router.post('/:userId/resend-invite', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && target.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (target.status === 'ACTIVE') {
      return res.status(409).json({ success: false, error: 'ALREADY_ACTIVE', message: 'This user has already activated their account.' });
    }

    const agency = target.agencyId ? await prisma.agency.findUnique({ where: { id: target.agencyId } }) : null;

    const rawToken = await prisma.$transaction((tx) =>
      reissueInvitation(tx, { userId: target.id, email: target.email, role: target.role, agencyId: target.agencyId, invitedById: req.user.id })
    );

    const emailResult = await sendInvitationEmail({ to: target.email, role: target.role, agencyName: agency ? agency.name : 'EvenFlow', token: rawToken });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: target.agencyId,
      action: 'user.invite_resent', entityType: 'User', entityId: target.id,
      correlationId: req.correlationId,
    });

    return res.json({ success: true, emailStatus: emailResult.status, acceptUrl: emailResult.acceptUrl });
  } catch (err) {
    next(err);
  }
});

const updateUserSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
});

// Fix a typo'd name — no edit of any kind existed on a user record after
// invite before this (email/role intentionally stay out of scope here).
router.patch('/:userId', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && target.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const updated = await prisma.user.update({ where: { id: target.id }, data: parsed.data });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: target.agencyId,
      action: 'user.updated', entityType: 'User', entityId: target.id,
      before: { firstName: target.firstName, lastName: target.lastName },
      after: parsed.data, correlationId: req.correlationId,
    });
    return res.json({ success: true, user: { id: updated.id, firstName: updated.firstName, lastName: updated.lastName } });
  } catch (err) {
    next(err);
  }
});

// Deactivate a user — preserves all historical attribution, just blocks login.
router.post('/:userId/deactivate', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && target.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { status: 'DEACTIVATED', deactivatedAt: new Date() },
    });
    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      agencyId: target.agencyId,
      action: 'user.deactivated',
      entityType: 'User',
      entityId: target.id,
      before: { status: target.status },
      after: { status: updated.status },
      correlationId: req.correlationId,
    });
    return res.json({ success: true, user: { id: updated.id, status: updated.status } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
