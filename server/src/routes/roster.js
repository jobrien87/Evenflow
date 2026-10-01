// Roster Settings backend — badges, PTO, and upcoming birthdays. The
// hours report already exists at GET /timeclock/report; invite/
// deactivate already exist at POST /users/invite(-bulk) and POST
// /users/:userId/deactivate. This file is the three real gaps the
// consolidated Roster Settings hub needs that nothing else covers.

const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { notifyUser } = require('../lib/notifications');

const router = express.Router();
router.use(requireAuth);

const LEADERSHIP_ROLES = ['AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'];

function scopeAgencyIdForRoster(req) {
  if (req.user.role === 'PLATFORM_OWNER') return req.query.agencyId || undefined;
  return req.user.agencyId;
}

// ---------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------

router.get('/badges', requireRole(...LEADERSHIP_ROLES), async (req, res, next) => {
  try {
    const agencyId = scopeAgencyIdForRoster(req);
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const badges = await prisma.userBadge.findMany({
      where: { agencyId, ...(req.query.userId ? { userId: req.query.userId } : {}) },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { awardedAt: 'desc' },
    });
    return res.json({ success: true, badges });
  } catch (err) {
    next(err);
  }
});

const awardBadgeSchema = z.object({
  userId: z.string().uuid(),
  type: z.enum(['FIRST_YEAR', 'FIVE_YEAR', 'TEN_YEAR', 'PC_LICENSE', 'LIFE_LICENSE', 'AGENT_OF_THE_MONTH']),
  periodLabel: z.string().optional(),
});

router.post('/badges', requireRole(...LEADERSHIP_ROLES), async (req, res, next) => {
  try {
    const parsed = awardBadgeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const target = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
    if (!target) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && target.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    const badge = await prisma.userBadge.create({
      data: {
        userId: target.id,
        agencyId: target.agencyId,
        type: parsed.data.type,
        periodLabel: parsed.data.periodLabel || null,
        awardedById: req.user.id,
      },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: target.agencyId,
      action: 'badge.awarded', entityType: 'UserBadge', entityId: badge.id,
      after: { userId: target.id, type: badge.type }, correlationId: req.correlationId,
    });

    await notifyUser({
      userId: target.id, agencyId: target.agencyId, type: 'badge.awarded', severity: 'INFO',
      title: 'New badge earned', body: `You were awarded the ${badge.type.replace(/_/g, ' ')} badge.`,
    });

    return res.status(201).json({ success: true, badge });
  } catch (err) {
    next(err);
  }
});

router.delete('/badges/:id', requireRole(...LEADERSHIP_ROLES), async (req, res, next) => {
  try {
    const badge = await prisma.userBadge.findUnique({ where: { id: req.params.id } });
    if (!badge) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && badge.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    await prisma.userBadge.delete({ where: { id: badge.id } });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: badge.agencyId,
      action: 'badge.revoked', entityType: 'UserBadge', entityId: badge.id, correlationId: req.correlationId,
    });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Birthdays — upcoming, within the next 30 days, agency-scoped.
// ---------------------------------------------------------------------

router.get('/birthdays', requireRole(...LEADERSHIP_ROLES), async (req, res, next) => {
  try {
    const agencyId = scopeAgencyIdForRoster(req);
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const users = await prisma.user.findMany({
      where: { agencyId, status: 'ACTIVE', birthday: { not: null } },
      select: { id: true, firstName: true, lastName: true, birthday: true },
    });

    const today = new Date();
    const todayMD = today.getUTCMonth() * 100 + today.getUTCDate();
    const withNextOccurrence = users.map((u) => {
      const b = new Date(u.birthday);
      const bMD = b.getUTCMonth() * 100 + b.getUTCDate();
      // Days until the next occurrence of this month/day, wrapping to next year.
      let daysUntil = Math.round((new Date(Date.UTC(today.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate())) - new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))) / 86400000);
      if (bMD < todayMD) daysUntil += 365;
      return { id: u.id, firstName: u.firstName, lastName: u.lastName, month: b.getUTCMonth() + 1, day: b.getUTCDate(), daysUntil };
    });

    const upcoming = withNextOccurrence.filter((u) => u.daysUntil <= 30).sort((a, b) => a.daysUntil - b.daysUntil);
    return res.json({ success: true, birthdays: upcoming });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// PTO requests
// ---------------------------------------------------------------------

router.get('/pto', async (req, res, next) => {
  try {
    const isLeadership = LEADERSHIP_ROLES.includes(req.user.role);
    const agencyId = scopeAgencyIdForRoster(req);
    const where = {};
    if (isLeadership) {
      if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
      where.agencyId = agencyId;
    } else {
      // A Producer/TM only ever sees their own requests — never the
      // whole agency's, which is leadership's view above.
      where.userId = req.user.id;
    }
    const requests = await prisma.ptoRequest.findMany({
      where,
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, requests });
  } catch (err) {
    next(err);
  }
});

const createPtoSchema = z.object({
  startDate: z.string().date(),
  endDate: z.string().date(),
  reason: z.string().optional(),
});

router.post('/pto', async (req, res, next) => {
  try {
    const parsed = createPtoSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    if (!req.user.agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const start = new Date(parsed.data.startDate);
    const end = new Date(parsed.data.endDate);
    if (end < start) return res.status(400).json({ success: false, error: 'VALIDATION', message: 'endDate must be on or after startDate.' });

    const request = await prisma.ptoRequest.create({
      data: { userId: req.user.id, agencyId: req.user.agencyId, startDate: start, endDate: end, reason: parsed.data.reason },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.user.agencyId,
      action: 'pto.requested', entityType: 'PtoRequest', entityId: request.id, correlationId: req.correlationId,
    });

    const leadership = await prisma.user.findMany({
      where: { agencyId: req.user.agencyId, role: { in: ['AGENCY_OWNER', 'AGENCY_MANAGER'] }, status: 'ACTIVE' },
      select: { id: true },
    });
    await Promise.all(leadership.map((l) => notifyUser({
      userId: l.id, agencyId: req.user.agencyId, type: 'pto.requested', severity: 'INFO',
      title: `PTO request from ${req.user.firstName} ${req.user.lastName}`,
      body: `${start.toLocaleDateString()} – ${end.toLocaleDateString()}`,
    })));

    return res.status(201).json({ success: true, request });
  } catch (err) {
    next(err);
  }
});

const reviewPtoSchema = z.object({
  status: z.enum(['APPROVED', 'DENIED']),
  reviewNote: z.string().optional(),
});

router.patch('/pto/:id', requireRole(...LEADERSHIP_ROLES), async (req, res, next) => {
  try {
    const parsed = reviewPtoSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const request = await prisma.ptoRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && request.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (request.status !== 'PENDING') {
      return res.status(409).json({ success: false, error: 'ALREADY_REVIEWED', message: 'This request was already reviewed.' });
    }

    const updated = await prisma.ptoRequest.update({
      where: { id: request.id },
      data: { status: parsed.data.status, reviewedById: req.user.id, reviewedAt: new Date(), reviewNote: parsed.data.reviewNote },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: request.agencyId,
      action: 'pto.reviewed', entityType: 'PtoRequest', entityId: request.id,
      after: { status: updated.status }, correlationId: req.correlationId,
    });

    await notifyUser({
      userId: request.userId, agencyId: request.agencyId, type: 'pto.reviewed', severity: 'INFO',
      title: `Your PTO request was ${updated.status.toLowerCase()}`,
      body: updated.reviewNote || `${new Date(updated.startDate).toLocaleDateString()} – ${new Date(updated.endDate).toLocaleDateString()}`,
    });

    return res.json({ success: true, request: updated });
  } catch (err) {
    next(err);
  }
});

// Self-cancel — only while still PENDING, and only your own request.
router.delete('/pto/:id', async (req, res, next) => {
  try {
    const request = await prisma.ptoRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (request.userId !== req.user.id) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (request.status !== 'PENDING') {
      return res.status(409).json({ success: false, error: 'ALREADY_REVIEWED', message: 'Only a pending request can be cancelled.' });
    }
    await prisma.ptoRequest.update({ where: { id: request.id }, data: { status: 'CANCELLED' } });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
