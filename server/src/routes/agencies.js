const express = require('express');
const { z } = require('zod');
const crypto = require('crypto');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { sendInvitationEmail } = require('../lib/email');
const { reissueInvitation } = require('../lib/invitations');
const { resolveSettings } = require('../lib/breakRoom');

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
        // The raw token is never returned to the browser — only delivered
        // to the invitee's own inbox. When email isn't configured (or
        // fails), lib/email.js already logs the link server-side for an
        // operator with real log access to relay manually.
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

    return res.json({ success: true, emailStatus: emailResult.status });
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

    // Optional real date-range filter — same "no from/to means no filter
    // at all" default every other date-scoped report in this app uses,
    // rather than silently defaulting to a window the caller never asked for.
    const from = req.query.from ? new Date(req.query.from) : undefined;
    const to = req.query.to ? new Date(req.query.to) : undefined;
    const hasValidRange = from && to && !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime());
    const where = { agencyId: req.params.agencyId, ...(hasValidRange ? { createdAt: { gte: from, lte: to } } : {}) };

    const [events, total] = await Promise.all([
      prisma.auditEvent.findMany({
        where,
        include: { actor: { select: { firstName: true, lastName: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.auditEvent.count({ where }),
    ]);

    return res.json({ success: true, page, pageSize, total, events });
  } catch (err) {
    next(err);
  }
});

const LEAD_TYPES = ['TRANSFER', 'REFERRAL', 'PAID_AD', 'META_AD', 'INTERNET', 'DIRECT_MAIL', 'MANUAL', 'WINBACK', 'CROSS_SELL'];
const priorityRulesSchema = z.object({
  typeRank: z.array(z.enum(LEAD_TYPES)).min(1).optional(),
  statusRules: z.record(z.object({
    afterDays: z.number().int().min(0),
    action: z.enum(['BUMP_UP', 'BUMP_DOWN', 'DROP_OFF']),
  })).optional(),
}).nullable();

const updateAgencySchema = z.object({
  name: z.string().min(2).optional(),
  timezone: z.string().optional(),
  officeHours: z.record(z.string()).nullable().optional(),
  products: z.array(z.string()).optional(),
  priorityRules: priorityRulesSchema.optional(),
  // Company contact info — collected during Record Store setup when
  // missing (master spec §6) and reused for any future Boberdoo action.
  address: z.string().trim().min(1).max(200).optional(),
  city: z.string().trim().min(1).max(100).optional(),
  state: z.string().trim().length(2).optional(),
  zip: z.string().trim().min(5).max(10).optional(),
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
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Please check the form and try again.', fieldErrors: parsed.error.flatten() });
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

// Factory Reset — the permanent, properly-authenticated replacement for
// the old temporary adminWipe.js (removed alongside this). Wipes every
// lead/customer/financial/historical row for one agency so its owner can
// start fresh, while deliberately leaving every User login, Vendor,
// Office, and Goal intact — nobody has to reconfigure their roster or
// vendor list from scratch. A real, irreversible delete (unlike every
// other destructive action in this app, which archives), gated by the
// caller re-typing the agency's own current name as confirmation rather
// than a shared secret header.
function factoryResetAuthorized(req, agencyId) {
  return req.user.role === 'PLATFORM_OWNER' || (req.user.role === 'AGENCY_OWNER' && req.user.agencyId === agencyId);
}

async function collectFactoryResetScope(tx, agencyId) {
  const [leadIds, transferIds, opportunityIds, callIds] = await Promise.all([
    tx.lead.findMany({ where: { agencyId }, select: { id: true } }).then((r) => r.map((l) => l.id)),
    tx.transfer.findMany({ where: { agencyId }, select: { id: true } }).then((r) => r.map((t) => t.id)),
    tx.opportunity.findMany({ where: { agencyId }, select: { id: true } }).then((r) => r.map((o) => o.id)),
    tx.call.findMany({ where: { agencyId }, select: { id: true } }).then((r) => r.map((c) => c.id)),
  ]);

  const customerIds = new Set();
  (await tx.lead.findMany({ where: { agencyId, customerId: { not: null } }, select: { customerId: true } })).forEach((l) => customerIds.add(l.customerId));
  (await tx.transfer.findMany({ where: { agencyId, customerId: { not: null } }, select: { customerId: true } })).forEach((t) => customerIds.add(t.customerId));
  (await tx.opportunity.findMany({ where: { agencyId }, select: { customerId: true } })).forEach((o) => customerIds.add(o.customerId));

  return { leadIds, transferIds, opportunityIds, callIds, customerIds };
}

router.get('/:agencyId/factory-reset-preview', requireRole('AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencyId = req.params.agencyId;
    if (!factoryResetAuthorized(req, agencyId)) return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    const agency = await prisma.agency.findUnique({ where: { id: agencyId }, select: { id: true, name: true } });
    if (!agency) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const { leadIds, transferIds, opportunityIds, callIds, customerIds } = await collectFactoryResetScope(prisma, agencyId);
    // Fetched once, with enough fields to both scope FlowScoreSnapshot below
    // AND show real roster identity in the confirm UI — a duplicate-named
    // Agency row (schema has no uniqueness constraint on Agency.name) looks
    // identical by name alone, but never shares a real owner email.
    const agencyUsers = await prisma.user.findMany({ where: { agencyId }, select: { id: true, email: true, firstName: true, lastName: true, role: true } });
    const userIds = agencyUsers.map((u) => u.id);
    const owner = agencyUsers.find((u) => u.role === 'AGENCY_OWNER') || agencyUsers[0] || null;

    let wipeableCustomers = 0;
    for (const customerId of customerIds) {
      const [otherLead, otherTransfer, otherOpportunity] = await Promise.all([
        prisma.lead.count({ where: { customerId, agencyId: { not: agencyId } } }),
        prisma.transfer.count({ where: { customerId, agencyId: { not: agencyId } } }),
        prisma.opportunity.count({ where: { customerId, agencyId: { not: agencyId } } }),
      ]);
      if (otherLead === 0 && otherTransfer === 0 && otherOpportunity === 0) wipeableCustomers += 1;
    }

    const [leadEvents, leadNotes, leadActivities, leadProductQuotes, leadTasks, opportunityEvents, creditRequests, transferEvents, revenueEvents, costEvents, callAnalyses, historicalRecords, importBatches, flowScoreSnapshots, notifications] = await Promise.all([
      prisma.leadEvent.count({ where: { leadId: { in: leadIds } } }),
      prisma.leadNote.count({ where: { leadId: { in: leadIds } } }),
      prisma.leadActivity.count({ where: { leadId: { in: leadIds } } }),
      prisma.leadProductQuote.count({ where: { leadId: { in: leadIds } } }),
      prisma.task.count({ where: { leadId: { in: leadIds } } }),
      prisma.opportunityEvent.count({ where: { opportunityId: { in: opportunityIds } } }),
      prisma.creditRequest.count({ where: { transferId: { in: transferIds } } }),
      prisma.transferEvent.count({ where: { transferId: { in: transferIds } } }),
      prisma.revenueEvent.count({ where: { agencyId } }),
      prisma.costEvent.count({ where: { agencyId } }),
      prisma.callAnalysis.count({ where: { callId: { in: callIds } } }),
      prisma.historicalRecord.count({ where: { agencyId } }),
      prisma.leadImportBatch.count({ where: { agencyId } }),
      prisma.flowScoreSnapshot.count({ where: { OR: [{ subjectType: 'AGENCY', subjectId: agencyId }, { subjectType: 'USER', subjectId: { in: userIds } }] } }),
      prisma.notification.count({ where: { agencyId } }),
    ]);

    return res.json({
      success: true,
      agency: { id: agency.id, name: agency.name },
      // Real roster identity, not just the (non-unique) agency name — lets
      // the confirm UI make a duplicate-named Agency row's mixup visually
      // obvious before anyone types a confirmation.
      ownerEmail: owner?.email || null,
      ownerName: owner ? `${owner.firstName} ${owner.lastName}` : null,
      totalUsers: agencyUsers.length,
      counts: {
        leads: leadIds.length,
        customers: customerIds.size,
        wipeableCustomers,
        transfers: transferIds.length,
        opportunities: opportunityIds.length,
        calls: callIds.length,
        callAnalyses,
        leadEvents,
        leadNotes,
        leadActivities,
        leadProductQuotes,
        leadLinkedTasks: leadTasks,
        opportunityEvents,
        creditRequests,
        transferEvents,
        revenueEvents,
        costEvents,
        historicalRecords,
        leadImportBatches: importBatches,
        flowScoreSnapshots,
        notifications,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:agencyId/factory-reset', requireRole('AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencyId = req.params.agencyId;
    if (!factoryResetAuthorized(req, agencyId)) return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    const agency = await prisma.agency.findUnique({ where: { id: agencyId }, select: { id: true, name: true } });
    if (!agency) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    if (req.body?.confirmText !== agency.name) {
      return res.status(400).json({ success: false, error: 'CONFIRMATION_MISMATCH', message: 'Type the agency\'s exact name to confirm.' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const { leadIds, transferIds, opportunityIds, callIds, customerIds } = await collectFactoryResetScope(tx, agencyId);
      const userIds = (await tx.user.findMany({ where: { agencyId }, select: { id: true } })).map((u) => u.id);

      const counts = {};

      counts.callAnalyses = (await tx.callAnalysis.deleteMany({ where: { callId: { in: callIds } } })).count;
      counts.calls = (await tx.call.deleteMany({ where: { agencyId } })).count;

      counts.leadEvents = (await tx.leadEvent.deleteMany({ where: { leadId: { in: leadIds } } })).count;
      counts.leadNotes = (await tx.leadNote.deleteMany({ where: { leadId: { in: leadIds } } })).count;
      counts.leadActivities = (await tx.leadActivity.deleteMany({ where: { leadId: { in: leadIds } } })).count;
      counts.leadProductQuotes = (await tx.leadProductQuote.deleteMany({ where: { leadId: { in: leadIds } } })).count;
      counts.leadLinkedTasks = (await tx.task.deleteMany({ where: { leadId: { in: leadIds } } })).count;

      counts.leads = (await tx.lead.deleteMany({ where: { agencyId } })).count;

      counts.opportunityEvents = (await tx.opportunityEvent.deleteMany({ where: { opportunityId: { in: opportunityIds } } })).count;
      counts.opportunities = (await tx.opportunity.deleteMany({ where: { agencyId } })).count;

      counts.creditRequests = (await tx.creditRequest.deleteMany({ where: { transferId: { in: transferIds } } })).count;
      counts.transferEvents = (await tx.transferEvent.deleteMany({ where: { transferId: { in: transferIds } } })).count;
      counts.transfers = (await tx.transfer.deleteMany({ where: { agencyId } })).count;

      // Scoped directly by agencyId — not just transferId, which is the
      // real gap the old adminWipe.js had: every manually-entered ledger
      // row (POST /financials/events) carries agencyId but no transferId
      // at all, so that route never actually cleared them.
      counts.revenueEvents = (await tx.revenueEvent.deleteMany({ where: { agencyId } })).count;
      counts.costEvents = (await tx.costEvent.deleteMany({ where: { agencyId } })).count;

      // HistoricalRecord before LeadImportBatch — HistoricalRecord.importBatchId
      // is a required FK into LeadImportBatch.
      counts.historicalRecords = (await tx.historicalRecord.deleteMany({ where: { agencyId } })).count;
      counts.leadImportBatches = (await tx.leadImportBatch.deleteMany({ where: { agencyId } })).count;

      counts.flowScoreSnapshots = (await tx.flowScoreSnapshot.deleteMany({
        where: { OR: [{ subjectType: 'AGENCY', subjectId: agencyId }, { subjectType: 'USER', subjectId: { in: userIds } }] },
      })).count;

      counts.notifications = (await tx.notification.deleteMany({ where: { agencyId } })).count;

      let wipeableCustomers = 0;
      for (const customerId of customerIds) {
        const [otherLead, otherTransfer, otherOpportunity] = await Promise.all([
          tx.lead.count({ where: { customerId } }),
          tx.transfer.count({ where: { customerId } }),
          tx.opportunity.count({ where: { customerId } }),
        ]);
        if (otherLead === 0 && otherTransfer === 0 && otherOpportunity === 0) {
          await tx.customer.delete({ where: { id: customerId } });
          wipeableCustomers += 1;
        }
      }
      counts.customers = wipeableCustomers;

      return counts;
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId,
      action: 'agency.factory_reset', entityType: 'Agency', entityId: agencyId,
      after: result, correlationId: req.correlationId,
    });

    return res.json({ success: true, agencyId, wipedCounts: result });
  } catch (err) {
    next(err);
  }
});

const entitlementsSchema = z.object({
  crmEnabled: z.boolean().optional(),
  transfersEnabled: z.boolean().optional(),
  coachingEnabled: z.boolean().optional(),
  // The Sales Studio compliance buffer (lib/entitlements.js's
  // requireSalesStudioAccess) — off bypasses the coachingEnabled unlock
  // entirely for this one agency.
  salesStudioGateEnabled: z.boolean().optional(),
  // Break Room master on/off — reuses requireModuleEnabled('breakRoomEnabled')
  // directly, zero new gating code needed.
  breakRoomEnabled: z.boolean().optional(),
});

// A direct Platform-Owner override of module access, independent of
// whatever Plan is assigned (e.g. a manual comp) — writes the exact same
// Agency fields billing.js's subscription-assignment flow already
// writes, so lib/entitlements.js's gating logic needs no changes at all.
router.patch('/:agencyId/entitlements', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = entitlementsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Please check the form and try again.', fieldErrors: parsed.error.flatten() });
    }
    const before = await prisma.agency.findUnique({ where: { id: req.params.agencyId } });
    if (!before) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const updated = await prisma.agency.update({ where: { id: before.id }, data: parsed.data });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: before.id,
      action: 'agency.entitlements_overridden', entityType: 'Agency', entityId: before.id,
      before: { crmEnabled: before.crmEnabled, transfersEnabled: before.transfersEnabled, coachingEnabled: before.coachingEnabled, salesStudioGateEnabled: before.salesStudioGateEnabled, breakRoomEnabled: before.breakRoomEnabled },
      after: parsed.data, correlationId: req.correlationId,
    });

    return res.json({ success: true, agency: updated });
  } catch (err) {
    next(err);
  }
});

const breakRoomSettingsSchema = z.object({
  games: z.object({
    CONGO_LINE: z.boolean().optional(),
    BUCKETS: z.boolean().optional(),
    FULL_SEND: z.boolean().optional(),
    PILL_POP: z.boolean().optional(),
  }).optional(),
  pickMeUpEnabled: z.boolean().optional(),
  lunchEligible: z.boolean().optional(),
  soundsEnabled: z.boolean().optional(),
  achievementsEnabled: z.boolean().optional(),
  leaderboardScope: z.object({
    office: z.boolean().optional(),
    agency: z.boolean().optional(),
  }).optional(),
}).nullable();

// Owner/Manager can edit their own agency's Break Room config; Platform
// Owner can edit any agency's — same authorization shape as the general
// PATCH /:agencyId settings route above, just a narrower, Break-Room-only
// body so this can't accidentally touch name/timezone/products.
router.patch('/:agencyId/break-room-settings', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    if (req.user.role !== 'PLATFORM_OWNER' && req.user.agencyId !== req.params.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const parsed = breakRoomSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Please check the form and try again.', fieldErrors: parsed.error.flatten() });
    }
    const before = await prisma.agency.findUnique({ where: { id: req.params.agencyId } });
    if (!before) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const current = resolveSettings(before.breakRoomSettings);
    const merged = {
      ...current,
      ...parsed.data,
      games: { ...current.games, ...(parsed.data.games || {}) },
      leaderboardScope: { ...current.leaderboardScope, ...(parsed.data.leaderboardScope || {}) },
    };
    const updated = await prisma.agency.update({ where: { id: before.id }, data: { breakRoomSettings: merged } });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: before.id,
      action: 'agency.break_room_settings_updated', entityType: 'Agency', entityId: before.id,
      before: before.breakRoomSettings, after: merged, correlationId: req.correlationId,
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
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Please check the form and try again.', fieldErrors: parsed.error.flatten() });
    }
    const agency = await prisma.agency.findUnique({ where: { id: req.params.agencyId } });
    if (!agency) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const email = parsed.data.email.trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ success: false, error: 'EMAIL_IN_USE', message: 'A user with that email already exists.' });
    }

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
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
