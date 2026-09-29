const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { agencyChatParticipantIds } = require('../lib/agencyChat');
const { notifyUsers } = require('../lib/notifications');

const router = express.Router();
router.use(requireAuth);

const createSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  target: z.enum(['team', 'producer', 'agency', 'agency_owner', 'telemarketer', 'all_telemarketers']),
  targetUserId: z.string().uuid().optional(),
  agencyId: z.string().uuid().optional(),
});

// Resolves a request into { data, recipientIds } — the real Announcement
// row to write plus the real users to notify, computed once here so the
// creation and the notification fan-out can never drift apart.
async function resolveTarget(req, parsed) {
  const { target, targetUserId, agencyId: bodyAgencyId } = parsed;

  if (req.user.role === 'AGENCY_OWNER' || req.user.role === 'AGENCY_MANAGER') {
    const agencyId = req.user.agencyId;
    if (target === 'team') {
      return { data: { agencyId }, recipientIds: await agencyChatParticipantIds(agencyId) };
    }
    if (target === 'producer') {
      if (!targetUserId) return { error: 'TARGET_REQUIRED' };
      const targetUser = await prisma.user.findUnique({ where: { id: targetUserId } });
      if (!targetUser || targetUser.agencyId !== agencyId || targetUser.role !== 'PRODUCER') {
        return { error: 'FORBIDDEN' };
      }
      return { data: { agencyId, targetUserId }, recipientIds: [targetUserId] };
    }
    return { error: 'INVALID_TARGET' };
  }

  // PLATFORM_OWNER
  if (target === 'agency') {
    if (!bodyAgencyId) return { error: 'AGENCY_REQUIRED' };
    const agency = await prisma.agency.findUnique({ where: { id: bodyAgencyId } });
    if (!agency) return { error: 'NOT_FOUND' };
    return { data: { agencyId: bodyAgencyId }, recipientIds: await agencyChatParticipantIds(bodyAgencyId) };
  }
  if (target === 'all_telemarketers') {
    const tms = await prisma.user.findMany({ where: { role: 'TELEMARKETER', status: 'ACTIVE' }, select: { id: true } });
    return { data: { targetRole: 'TELEMARKETER' }, recipientIds: tms.map((u) => u.id) };
  }
  if (['agency_owner', 'producer', 'telemarketer'].includes(target)) {
    if (!targetUserId) return { error: 'TARGET_REQUIRED' };
    const targetUser = await prisma.user.findUnique({ where: { id: targetUserId } });
    const expectedRoles = {
      agency_owner: ['AGENCY_OWNER', 'AGENCY_MANAGER'],
      producer: ['PRODUCER'],
      telemarketer: ['TELEMARKETER'],
    }[target];
    if (!targetUser || !expectedRoles.includes(targetUser.role)) {
      return { error: 'INVALID_TARGET_USER' };
    }
    return { data: { targetUserId, agencyId: targetUser.agencyId || null }, recipientIds: [targetUserId] };
  }
  return { error: 'INVALID_TARGET' };
}

router.post('/', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const resolved = await resolveTarget(req, parsed.data);
    if (resolved.error) {
      const status = resolved.error === 'FORBIDDEN' ? 403 : resolved.error === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ success: false, error: resolved.error });
    }

    const announcement = await prisma.announcement.create({
      data: { ...resolved.data, title: parsed.data.title, body: parsed.data.body, createdById: req.user.id },
    });

    await notifyUsers(resolved.recipientIds, {
      agencyId: resolved.data.agencyId || null,
      type: 'announcement.new',
      severity: 'ACTION',
      title: `Announcement: ${parsed.data.title}`,
      body: parsed.data.body,
      relatedEntityType: 'Announcement',
      relatedEntityId: announcement.id,
    });

    return res.status(201).json({ success: true, announcement, recipientCount: resolved.recipientIds.length });
  } catch (err) {
    next(err);
  }
});

router.get('/pending', async (req, res, next) => {
  try {
    const myAgencyIds = req.user.role === 'TELEMARKETER'
      ? (await prisma.telemarketerAssignment.findMany({
          where: { telemarketerId: req.user.id, status: 'ACTIVE' },
          select: { agencyId: true },
        })).map((a) => a.agencyId)
      : req.user.agencyId ? [req.user.agencyId] : [];

    const candidates = await prisma.announcement.findMany({
      where: {
        OR: [
          { targetUserId: req.user.id },
          ...(req.user.role === 'TELEMARKETER' ? [{ targetRole: 'TELEMARKETER', agencyId: null }] : []),
          ...(myAgencyIds.length ? [{ agencyId: { in: myAgencyIds }, targetUserId: null }] : []),
        ],
      },
      include: {
        acks: { where: { userId: req.user.id } },
        createdBy: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const pending = candidates.find((a) => a.acks.length === 0);

    return res.json({
      success: true,
      announcement: pending
        ? { id: pending.id, title: pending.title, body: pending.body, createdAt: pending.createdAt, createdBy: pending.createdBy }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/ack', async (req, res, next) => {
  try {
    const announcement = await prisma.announcement.findUnique({ where: { id: req.params.id } });
    if (!announcement) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    await prisma.announcementAck.upsert({
      where: { announcementId_userId: { announcementId: announcement.id, userId: req.user.id } },
      create: { announcementId: announcement.id, userId: req.user.id },
      update: {},
    });

    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
