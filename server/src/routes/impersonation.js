const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { IMPERSONATION_COOKIE } = require('../lib/impersonation');

const router = express.Router();
router.use(requireAuth);

function publicUser(user) {
  return { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role, agencyId: user.agencyId, status: user.status };
}

router.get('/status', (req, res) => {
  return res.json({
    success: true,
    isImpersonating: req.isImpersonating,
    viewingAs: req.isImpersonating ? publicUser(req.user) : null,
    realUser: publicUser(req.realUser),
  });
});

// Platform Owner searches ANY user across the whole platform to view as —
// unlike customer search, no agency scoping applies here since Platform
// Owner already has full authorized visibility.
router.get('/search-users', async (req, res, next) => {
  try {
    if (req.realUser.role !== 'PLATFORM_OWNER') {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, users: [] });

    const users = await prisma.user.findMany({
      where: {
        role: { not: 'PLATFORM_OWNER' },
        status: 'ACTIVE',
        OR: [
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, firstName: true, lastName: true, email: true, role: true, agencyId: true },
      take: 10,
    });
    return res.json({ success: true, users });
  } catch (err) {
    next(err);
  }
});

const startSchema = z.object({ targetUserId: z.string().uuid() });

router.post('/start', async (req, res, next) => {
  try {
    if (req.realUser.role !== 'PLATFORM_OWNER') {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Only Platform Owners can view as another user.' });
    }
    if (req.isImpersonating) {
      return res.status(409).json({ success: false, error: 'ALREADY_IMPERSONATING', message: 'Exit the current view before starting another.' });
    }

    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION' });

    const targetUser = await prisma.user.findUnique({ where: { id: parsed.data.targetUserId } });
    if (!targetUser) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    if (targetUser.role === 'PLATFORM_OWNER') {
      return res.status(400).json({ success: false, error: 'CANNOT_IMPERSONATE_PLATFORM_OWNER' });
    }
    if (targetUser.status !== 'ACTIVE') {
      return res.status(400).json({ success: false, error: 'TARGET_NOT_ACTIVE', message: 'Cannot view as a deactivated or not-yet-activated user.' });
    }

    const log = await prisma.impersonationLog.create({
      data: { platformOwnerId: req.realUser.id, targetUserId: targetUser.id },
    });

    await recordAudit({
      actorId: req.realUser.id, actorRole: req.realUser.role, agencyId: targetUser.agencyId,
      action: 'impersonation.started', entityType: 'ImpersonationLog', entityId: log.id,
      after: { targetUserId: targetUser.id, targetRole: targetUser.role }, correlationId: req.correlationId,
    });

    const isProd = process.env.NODE_ENV === 'production';
    res.cookie(IMPERSONATION_COOKIE, log.id, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
    });

    return res.status(201).json({ success: true, viewingAs: publicUser(targetUser) });
  } catch (err) {
    next(err);
  }
});

router.post('/end', async (req, res, next) => {
  try {
    if (!req.isImpersonating) {
      return res.status(400).json({ success: false, error: 'NOT_IMPERSONATING' });
    }

    await prisma.impersonationLog.update({
      where: { id: req.impersonationLogId },
      data: { endedAt: new Date() },
    });

    await recordAudit({
      actorId: req.realUser.id, actorRole: req.realUser.role, agencyId: req.user.agencyId,
      action: 'impersonation.ended', entityType: 'ImpersonationLog', entityId: req.impersonationLogId,
      correlationId: req.correlationId,
    });

    const isProd = process.env.NODE_ENV === 'production';
    res.clearCookie(IMPERSONATION_COOKIE, { sameSite: isProd ? 'none' : 'lax', secure: isProd });

    return res.json({ success: true, realUser: publicUser(req.realUser) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
