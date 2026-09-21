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

const ACTIVE_SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE'];

// Real roster counts + current plan/MRR for a set of agencies, in a
// handful of grouped queries (never N+1 per agency) — every field here
// already exists on User/TelemarketerAssignment/AgencySubscription/Plan,
// this just aggregates it the way the admin dashboard actually needs it.
async function enrichAgencies(agencies) {
  const agencyIds = agencies.map((a) => a.id);
  if (agencyIds.length === 0) return [];

  const [userCounts, tmCounts, subs] = await Promise.all([
    prisma.user.groupBy({
      by: ['agencyId', 'role'],
      where: { agencyId: { in: agencyIds }, status: { not: 'DEACTIVATED' } },
      _count: { _all: true },
    }),
    prisma.telemarketerAssignment.groupBy({
      by: ['agencyId'],
      where: { agencyId: { in: agencyIds }, status: 'ACTIVE' },
      _count: { _all: true },
    }),
    prisma.agencySubscription.findMany({
      where: { agencyId: { in: agencyIds }, status: { in: ACTIVE_SUBSCRIPTION_STATUSES } },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const latestSubByAgency = {};
  for (const sub of subs) {
    if (!latestSubByAgency[sub.agencyId]) latestSubByAgency[sub.agencyId] = sub;
  }
  const tmCountByAgency = Object.fromEntries(tmCounts.map((c) => [c.agencyId, c._count._all]));

  return agencies.map((a) => {
    const producerCount = userCounts.find((c) => c.agencyId === a.id && c.role === 'PRODUCER')?._count._all || 0;
    const managerCount = userCounts.find((c) => c.agencyId === a.id && c.role === 'AGENCY_MANAGER')?._count._all || 0;
    const sub = latestSubByAgency[a.id] || null;
    // MRR only counts a subscription that's actually billing (ACTIVE) —
    // a TRIALING or PAST_DUE subscription contributes $0, never a
    // fabricated number for revenue that isn't real yet/anymore.
    const mrrCents = sub && sub.status === 'ACTIVE'
      ? (sub.plan.interval === 'ANNUAL' ? Math.round(sub.plan.priceCents / 12) : sub.plan.priceCents)
      : 0;
    return {
      ...a,
      producerCount,
      managerCount,
      telemarketerCount: tmCountByAgency[a.id] || 0,
      plan: sub ? { id: sub.plan.id, name: sub.plan.name, priceCents: sub.plan.priceCents, interval: sub.plan.interval } : null,
      subscriptionStatus: sub ? sub.status : null,
      mrrCents,
    };
  });
}

// List agencies — Platform Owner sees all (enriched with real roster/plan
// data, paginated + optionally name-filtered for scale — see the
// GET /:agencyId/activity route below for the same page/pageSize pattern);
// Agency roles see only their own.
router.get('/', async (req, res, next) => {
  try {
    if (req.user.role === 'PLATFORM_OWNER') {
      const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
      const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 50, 1), 100);
      const search = (req.query.search || '').trim();
      const where = search ? { name: { contains: search, mode: 'insensitive' } } : {};

      const [total, agencies] = await Promise.all([
        prisma.agency.count({ where }),
        prisma.agency.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      ]);
      return res.json({ success: true, page, pageSize, total, agencies: await enrichAgencies(agencies) });
    }
    if (!req.user.agencyId) return res.json({ success: true, agencies: [] });
    const agency = await prisma.agency.findUnique({ where: { id: req.user.agencyId } });
    return res.json({ success: true, agencies: agency ? await enrichAgencies([agency]) : [] });
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

// Agency detail — enriched with the same roster/plan stats as the list,
// plus the actual roster rows (grouped by role) an admin needs to see
// who's who, not just a count.
router.get('/:agencyId', async (req, res, next) => {
  try {
    if (req.user.role !== 'PLATFORM_OWNER' && req.user.agencyId !== req.params.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const agency = await prisma.agency.findUnique({ where: { id: req.params.agencyId } });
    if (!agency) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const userSelect = { id: true, email: true, firstName: true, lastName: true, role: true, status: true, createdAt: true };
    const [enriched, owners, managers, producers, tmAssignments] = await Promise.all([
      enrichAgencies([agency]),
      prisma.user.findMany({ where: { agencyId: agency.id, role: 'AGENCY_OWNER' }, select: userSelect, orderBy: { createdAt: 'asc' } }),
      prisma.user.findMany({ where: { agencyId: agency.id, role: 'AGENCY_MANAGER' }, select: userSelect, orderBy: { createdAt: 'asc' } }),
      prisma.user.findMany({ where: { agencyId: agency.id, role: 'PRODUCER' }, select: userSelect, orderBy: { createdAt: 'asc' } }),
      prisma.telemarketerAssignment.findMany({
        where: { agencyId: agency.id, status: 'ACTIVE' },
        include: { telemarketer: { select: userSelect } },
        orderBy: { effectiveFrom: 'asc' },
      }),
    ]);

    return res.json({
      success: true,
      agency: enriched[0],
      roster: {
        owners,
        managers,
        producers,
        telemarketers: tmAssignments.map((a) => ({ ...a.telemarketer, assignmentId: a.id, assignedAt: a.effectiveFrom })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// Real activity feed — reads AuditEvent, which is already written on
// nearly every mutation (recordAudit(), lib/audit.js) but was never read
// back anywhere until now. No new writes, just a new read.
router.get('/:agencyId/activity', async (req, res, next) => {
  try {
    if (req.user.role !== 'PLATFORM_OWNER' && req.user.agencyId !== req.params.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 50, 1), 100);

    const [events, total] = await Promise.all([
      prisma.auditEvent.findMany({
        where: { agencyId: req.params.agencyId },
        include: { actor: { select: { firstName: true, lastName: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.auditEvent.count({ where: { agencyId: req.params.agencyId } }),
    ]);

    return res.json({ success: true, page, pageSize, total, events });
  } catch (err) {
    next(err);
  }
});

const updateAgencySchema = z.object({
  name: z.string().min(2).optional(),
  timezone: z.string().optional(),
  officeHours: z.record(z.string()).nullable().optional(),
  products: z.array(z.string()).optional(),
});

// Edit an agency's own settings — didn't exist at all before this: an
// Agency Owner had no way to fix a typo'd name or set their real
// timezone/products, ever.
router.patch('/:agencyId', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    if (req.user.role !== 'PLATFORM_OWNER' && req.user.agencyId !== req.params.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const parsed = updateAgencySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const before = await prisma.agency.findUnique({ where: { id: req.params.agencyId } });
    if (!before) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const updated = await prisma.agency.update({ where: { id: before.id }, data: parsed.data });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: before.id,
      action: 'agency.settings_updated', entityType: 'Agency', entityId: before.id,
      before: { name: before.name, timezone: before.timezone, officeHours: before.officeHours, products: before.products },
      after: parsed.data, correlationId: req.correlationId,
    });

    return res.json({ success: true, agency: updated });
  } catch (err) {
    next(err);
  }
});

const entitlementsSchema = z.object({
  crmEnabled: z.boolean().optional(),
  transfersEnabled: z.boolean().optional(),
  coachingEnabled: z.boolean().optional(),
});

// A direct Platform-Owner override of module access, independent of
// whatever Plan is assigned (e.g. a manual comp) — writes the exact same
// Agency fields billing.js's subscription-assignment flow already
// writes, so lib/entitlements.js's gating logic needs no changes at all.
router.patch('/:agencyId/entitlements', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = entitlementsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const before = await prisma.agency.findUnique({ where: { id: req.params.agencyId } });
    if (!before) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const updated = await prisma.agency.update({ where: { id: before.id }, data: parsed.data });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: before.id,
      action: 'agency.entitlements_overridden', entityType: 'Agency', entityId: before.id,
      before: { crmEnabled: before.crmEnabled, transfersEnabled: before.transfersEnabled, coachingEnabled: before.coachingEnabled },
      after: parsed.data, correlationId: req.correlationId,
    });

    return res.json({ success: true, agency: updated });
  } catch (err) {
    next(err);
  }
});

const inviteOwnerSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(['AGENCY_OWNER', 'AGENCY_MANAGER']).default('AGENCY_OWNER'),
});

// Invite an additional Owner/Manager into an EXISTING agency — until now
// an owner could only ever be created alongside a brand-new agency
// (POST / above); this closes that gap using the exact same
// invitation/email pattern.
router.post('/:agencyId/invite-owner', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = inviteOwnerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const agency = await prisma.agency.findUnique({ where: { id: req.params.agencyId } });
    if (!agency) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const email = parsed.data.email.trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ success: false, error: 'EMAIL_IN_USE' });

    const { user, rawToken } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          firstName: parsed.data.firstName,
          lastName: parsed.data.lastName,
          role: parsed.data.role,
          status: 'INVITED',
          agencyId: agency.id,
          invitedById: req.user.id,
        },
      });
      const rawToken = crypto.randomBytes(24).toString('hex');
      await tx.invitation.create({
        data: {
          email,
          role: parsed.data.role,
          token: rawToken,
          agencyId: agency.id,
          invitedById: req.user.id,
          userId: user.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      return { user, rawToken };
    });

    const emailResult = await sendInvitationEmail({ to: email, role: parsed.data.role, agencyName: agency.name, token: rawToken });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: agency.id,
      action: 'agency.owner_invited', entityType: 'User', entityId: user.id,
      after: { email, role: parsed.data.role }, correlationId: req.correlationId,
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

module.exports = router;
