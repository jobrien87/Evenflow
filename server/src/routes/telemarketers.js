const express = require('express');
const { z } = require('zod');
const crypto = require('crypto');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { sendInvitationEmail } = require('../lib/email');

const router = express.Router();
router.use(requireAuth);

router.get('/', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const tms = await prisma.user.findMany({
      where: { role: 'TELEMARKETER' },
      select: {
        id: true, email: true, firstName: true, lastName: true, status: true, createdAt: true,
        telemarketerAssignments: {
          where: { status: 'ACTIVE' },
          include: { agency: { select: { id: true, name: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, telemarketers: tms });
  } catch (err) {
    next(err);
  }
});

// A telemarketer's own view of which offices they're assigned to — required
// so the TM dashboard can honestly show "no offices assigned yet" instead of
// silently letting them submit leads into a routing dead end.
router.get('/me/assignments', requireRole('TELEMARKETER'), async (req, res, next) => {
  try {
    const assignments = await prisma.telemarketerAssignment.findMany({
      where: { telemarketerId: req.user.id, status: 'ACTIVE' },
      include: { agency: { select: { id: true, name: true, transfersEnabled: true, transferPaused: true } } },
    });
    return res.json({ success: true, assignments });
  } catch (err) {
    next(err);
  }
});

const inviteTMSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
});

router.post('/invite', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = inviteTMSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const email = parsed.data.email.trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ success: false, error: 'EMAIL_IN_USE' });

    const { user, rawToken } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          firstName: parsed.data.firstName,
          lastName: parsed.data.lastName,
          role: 'TELEMARKETER',
          status: 'INVITED',
          invitedById: req.user.id,
        },
      });
      await tx.telemarketerProfile.create({
        data: { userId: user.id, phone: parsed.data.phone, status: 'INVITED' },
      });
      const rawToken = crypto.randomBytes(24).toString('hex');
      await tx.invitation.create({
        data: {
          email,
          role: 'TELEMARKETER',
          token: rawToken,
          invitedById: req.user.id,
          userId: user.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      return { user, rawToken };
    });

    const emailResult = await sendInvitationEmail({ to: email, role: 'TELEMARKETER', agencyName: 'Yield Marketing', token: rawToken });

    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'telemarketer.invited',
      entityType: 'User',
      entityId: user.id,
      after: { email },
      correlationId: req.correlationId,
    });

    return res.status(201).json({
      success: true,
      telemarketer: { id: user.id, email: user.email },
      emailStatus: emailResult.status,
      acceptUrl: emailResult.acceptUrl,
    });
  } catch (err) {
    next(err);
  }
});

const assignSchema = z.object({
  telemarketerId: z.string().uuid(),
  agencyId: z.string().uuid(),
  notes: z.string().optional(),
});

router.post('/assign', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const [tm, agency] = await Promise.all([
      prisma.user.findUnique({ where: { id: parsed.data.telemarketerId } }),
      prisma.agency.findUnique({ where: { id: parsed.data.agencyId } }),
    ]);
    if (!tm || tm.role !== 'TELEMARKETER') return res.status(404).json({ success: false, error: 'TELEMARKETER_NOT_FOUND' });
    if (!agency) return res.status(404).json({ success: false, error: 'AGENCY_NOT_FOUND' });

    const existing = await prisma.telemarketerAssignment.findFirst({
      where: { telemarketerId: tm.id, agencyId: agency.id, status: 'ACTIVE' },
    });
    if (existing) {
      return res.status(409).json({ success: false, error: 'ALREADY_ASSIGNED' });
    }

    const assignment = await prisma.telemarketerAssignment.create({
      data: {
        telemarketerId: tm.id,
        agencyId: agency.id,
        assignedById: req.user.id,
        notes: parsed.data.notes,
        status: 'ACTIVE',
      },
    });

    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      agencyId: agency.id,
      action: 'telemarketer.assigned',
      entityType: 'TelemarketerAssignment',
      entityId: assignment.id,
      after: { telemarketerId: tm.id, agencyId: agency.id },
      correlationId: req.correlationId,
    });

    return res.status(201).json({ success: true, assignment });
  } catch (err) {
    next(err);
  }
});

router.post('/assignments/:assignmentId/end', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const assignment = await prisma.telemarketerAssignment.findUnique({ where: { id: req.params.assignmentId } });
    if (!assignment) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const updated = await prisma.telemarketerAssignment.update({
      where: { id: assignment.id },
      data: { status: 'ENDED', effectiveTo: new Date() },
    });

    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      agencyId: assignment.agencyId,
      action: 'telemarketer.unassigned',
      entityType: 'TelemarketerAssignment',
      entityId: assignment.id,
      before: { status: 'ACTIVE' },
      after: { status: 'ENDED' },
      correlationId: req.correlationId,
    });

    return res.json({ success: true, assignment: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
