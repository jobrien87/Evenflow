const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, scopeAgencyId } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { scoreLead } = require('../lib/priority');
const { normalizePhone, normalizeEmail } = require('../lib/normalize');
const { recordLeadSaleRevenue } = require('../lib/financialEvents');
const { notifyUser, notifyUsers, notifyAgencyOwners } = require('../lib/notifications');
const { updateCustomerProductsAndDetectCrossSells } = require('../lib/opportunityEvents');
const { computeProducerScore, computeAgencyScore, computeTelemarketerScore } = require('../lib/flowScore');
const { computeFunnel } = require('../lib/funnelMetrics');
const { parseLeadFile } = require('../lib/leadBulkImport');

const router = express.Router();
router.use(requireAuth);

// Small cap — a lead-list spreadsheet is text/rows, never a large binary;
// mirrors calls.js's memoryStorage()-with-no-fileFilter convention (real
// validation happens after upload, inside parseLeadFile).
const uploadSpreadsheet = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// List leads — always server-side scoped to the caller's agency (never trust client agencyId).
router.get('/', async (req, res, next) => {
  try {
    // A Telemarketer has no agencyId of their own (cross-agency via
    // TelemarketerAssignment) — scope by what they actually created
    // instead, across every agency they've ever submitted to, rather
    // than by a single agencyId (mirrors GET /transfers's existing
    // createdByTMId scoping for the same role).
    const isTelemarketer = req.user.role === 'TELEMARKETER';
    const agencyId = isTelemarketer ? null : scopeAgencyId(req);
    if (!isTelemarketer && req.user.role !== 'PLATFORM_OWNER' && !agencyId) {
      return res.json({ success: true, leads: [], page: 1, pageSize: 0, total: 0 });
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 100);

    // `stage` mirrors the exact groupings computeFunnel() uses, so a drill-down
    // click from a funnel rate lands on precisely the leads behind that rate.
    const STAGE_FILTERS = {
      contacted: { firstContactAt: { not: null } },
      quoted: { status: { in: ['QUOTE_STARTED', 'QUOTED', 'APPOINTMENT', 'FOLLOW_UP', 'SOLD'] } },
      sold: { status: 'SOLD' },
    };

    const where = {
      ...(isTelemarketer ? { createdById: req.user.id } : agencyId ? { agencyId } : {}),
      ...(req.query.status ? { status: req.query.status } : {}),
      ...(req.query.source ? { source: req.query.source } : {}),
      ...(STAGE_FILTERS[req.query.stage] || {}),
      ...(req.query.from || req.query.to ? {
        receivedAt: {
          ...(req.query.from ? { gte: new Date(req.query.from) } : {}),
          ...(req.query.to ? { lte: new Date(req.query.to) } : {}),
        },
      } : {}),
      ...(req.user.role === 'PRODUCER' ? { assignedToId: req.user.id } : {}),
      archivedAt: null,
    };

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        include: {
          customer: true,
          assignedTo: { select: { id: true, firstName: true, lastName: true } },
          createdBy: { select: { id: true, firstName: true, lastName: true } },
          vendor: { select: { id: true, name: true } },
          _count: { select: { activities: true, notes: true } },
        },
        orderBy: [{ priorityScore: 'desc' }, { receivedAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.lead.count({ where }),
    ]);

    return res.json({ success: true, leads, page, pageSize, total });
  } catch (err) {
    next(err);
  }
});

const createLeadSchema = z.object({
  agencyId: z.string().uuid().optional(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  product: z.string().optional(),
  source: z.string().optional().default('manual'),
  assignedToId: z.string().uuid().optional(),
  customFields: z.record(z.any()).optional(),
  // Rich intake fields — populated by a Telemarketer's submission form;
  // optional/unused for every other lead source.
  dob: z.string().datetime().optional().or(z.literal('')),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
  vehicleYear: z.string().optional(),
  vehicleMake: z.string().optional(),
  vehicleModel: z.string().optional(),
  additionalDrivers: z.string().optional(),
  autoClaims: z.string().optional(),
  violations: z.string().optional(),
  ownRent: z.string().optional(),
  homeAge: z.string().optional(),
  sqFootage: z.string().optional(),
  homeClaims: z.string().optional(),
  currentInsurance: z.string().optional(),
  currentPremium: z.string().optional(),
  yearsWithCarrier: z.string().optional(),
  callbackTime: z.string().optional(),
  tmNotes: z.string().optional(),
  // Only ever honored when the caller is a real TELEMARKETER (see POST /
  // below) — never trusted as-is from any other role.
  isLiveTransfer: z.boolean().optional(),
});

const INTAKE_FIELD_KEYS = [
  'address', 'city', 'state', 'zip', 'vehicleYear', 'vehicleMake', 'vehicleModel',
  'additionalDrivers', 'autoClaims', 'violations', 'ownRent', 'homeAge', 'sqFootage',
  'homeClaims', 'currentInsurance', 'currentPremium', 'yearsWithCarrier', 'callbackTime', 'tmNotes',
];

// The real per-lead creation transaction — duplicate detection, Customer
// get-or-create, priority scoring, LeadEvent — shared by the single-lead
// POST / route below and the bulk-import route, so a spreadsheet-imported
// lead goes through exactly the same real logic a manually-entered one
// does, never a second/thinner implementation.
async function createLeadRecord({ agencyId, source, createdById, data }) {
  const phoneNormalized = normalizePhone(data.phone);
  const email = normalizeEmail(data.email);

  let duplicateOf = null;
  if (phoneNormalized || email) {
    duplicateOf = await prisma.customer.findFirst({
      where: {
        OR: [
          phoneNormalized ? { phoneNormalized } : undefined,
          email ? { email } : undefined,
        ].filter(Boolean),
      },
    });
  }

  return prisma.$transaction(async (tx) => {
    const customer = duplicateOf
      ? duplicateOf
      : await tx.customer.create({
          data: {
            firstName: data.firstName,
            lastName: data.lastName,
            phoneNormalized,
            email,
          },
        });

    const intakeFields = Object.fromEntries(
      INTAKE_FIELD_KEYS.filter((key) => data[key]).map((key) => [key, data[key]])
    );

    const lead = await tx.lead.create({
      data: {
        agencyId,
        customerId: customer.id,
        source,
        product: data.product,
        assignedToId: data.assignedToId,
        assignedAt: data.assignedToId ? new Date() : null,
        status: data.assignedToId ? 'ASSIGNED' : 'NEW',
        createdById,
        customFields: data.customFields || {},
        dob: data.dob ? new Date(data.dob) : null,
        isLiveTransfer: !!data.isLiveTransfer,
        ...intakeFields,
      },
    });

    const { priorityScore, priorityBand, priorityReason } = scoreLead(lead);
    const updatedLead = await tx.lead.update({
      where: { id: lead.id },
      data: { priorityScore, priorityReason },
    });

    await tx.leadEvent.create({
      data: {
        leadId: lead.id,
        type: duplicateOf ? 'lead.created.possible_duplicate' : 'lead.created',
        toStatus: updatedLead.status,
        metadata: { source, priorityBand },
      },
    });

    return { lead: updatedLead, customer, isDuplicate: !!duplicateOf };
  });
}

router.post('/', async (req, res, next) => {
  try {
    const parsed = createLeadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }

    let agencyId;
    if (req.user.role === 'PLATFORM_OWNER') {
      agencyId = parsed.data.agencyId;
    } else if (req.user.role === 'TELEMARKETER') {
      // A TM has no agencyId of their own (cross-agency via
      // TelemarketerAssignment) — never trust a client-supplied agencyId
      // blindly; require a real ACTIVE assignment to that exact agency.
      const requested = parsed.data.agencyId;
      if (!requested) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
      const assignment = await prisma.telemarketerAssignment.findFirst({
        where: { telemarketerId: req.user.id, agencyId: requested, status: 'ACTIVE' },
      });
      if (!assignment) return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Not assigned to that agency.' });

      // requireModuleEnabled (lib/entitlements.js) assumes req.user.agencyId,
      // which a Telemarketer never has — same real billing-plan gate
      // (Agency.transfersEnabled, synced from the assigned Plan in
      // billing.js), just checked against the TM's requested target agency
      // instead of the caller's own.
      const targetAgency = await prisma.agency.findUnique({ where: { id: requested }, select: { transfersEnabled: true, name: true } });
      if (!targetAgency) return res.status(403).json({ success: false, error: 'AGENCY_NOT_FOUND' });
      if (!targetAgency.transfersEnabled) {
        return res.status(403).json({
          success: false,
          error: 'MODULE_NOT_ENTITLED',
          message: `${targetAgency.name} does not currently have Yield Transfers enabled on its plan.`,
        });
      }
      agencyId = requested;
    } else {
      agencyId = req.user.agencyId;
    }
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    // Source drives the Yield Transfers filter downstream — authoritative
    // server-side, never client-trusted, for a Telemarketer's submission.
    const source = req.user.role === 'TELEMARKETER' ? 'telemarketer' : parsed.data.source;
    // Same rule for isLiveTransfer — only a real Telemarketer can flag one,
    // regardless of what any other caller's request body claims.
    const isLiveTransfer = req.user.role === 'TELEMARKETER' && !!parsed.data.isLiveTransfer;

    const result = await createLeadRecord({ agencyId, source, createdById: req.user.id, data: { ...parsed.data, isLiveTransfer } });

    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      agencyId,
      action: 'lead.created',
      entityType: 'Lead',
      entityId: result.lead.id,
      after: result.lead,
      correlationId: req.correlationId,
    });

    if (parsed.data.assignedToId) {
      await notifyUser({
        userId: parsed.data.assignedToId,
        agencyId,
        type: 'lead.assigned',
        severity: 'INFO',
        title: 'New lead assigned to you',
        body: `${result.customer.firstName} ${result.customer.lastName}${parsed.data.product ? ' — ' + parsed.data.product : ''}`,
        relatedEntityType: 'Lead',
        relatedEntityId: result.lead.id,
      });
    } else if (source === 'telemarketer' && isLiveTransfer) {
      // A live transfer needs a producer NOW, not just visibility to the
      // owner — same real "first to claim it gets it" broadcast a
      // vendor-sourced Moshpit lead already gets, just triggered by the
      // TM's flag instead of the vendor's distribution mode.
      const eligibleProducers = await prisma.user.findMany({
        where: { agencyId, role: 'PRODUCER', status: 'ACTIVE' },
        select: { id: true },
      });
      await notifyUsers(eligibleProducers.map((u) => u.id), {
        agencyId,
        type: 'lead.moshpit_available',
        severity: 'ACTION',
        title: 'Live transfer — caller is on the line',
        body: `${result.customer.firstName} ${result.customer.lastName}${parsed.data.product ? ' — ' + parsed.data.product : ''}. First to claim it gets it.`,
        relatedEntityType: 'Lead',
        relatedEntityId: result.lead.id,
      });
    } else if (source === 'telemarketer') {
      // Instantly visible to the whole agency, per the Yield Transfers
      // rebuild — same real "new lead" notification pattern already used
      // for a vendor-sourced lead, just a different real source.
      await notifyAgencyOwners(agencyId, {
        type: 'lead.new',
        severity: 'INFO',
        title: `New lead from ${req.user.firstName} ${req.user.lastName}`,
        body: `${result.customer.firstName} ${result.customer.lastName}${parsed.data.product ? ' — ' + parsed.data.product : ''}`,
        relatedEntityType: 'Lead',
        relatedEntityId: result.lead.id,
      });
    }

    return res.status(201).json({ success: true, lead: result.lead, possibleDuplicate: result.isDuplicate });
  } catch (err) {
    next(err);
  }
});

// Bulk lead-list upload (CSV/XLS/XLSX) — Agency Owner/Manager for their own
// agency, or Platform Owner on behalf of a given agency. Each parsed row
// goes through the exact same createLeadRecord() transaction a manual
// single-lead submission does — no second/thinner creation path.
router.post('/bulk-import', uploadSpreadsheet.single('file'), async (req, res, next) => {
  try {
    if (!['AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Expected a multipart field named "file".' });
    }

    let agencyId;
    if (req.user.role === 'PLATFORM_OWNER') {
      agencyId = req.body.agencyId;
      if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    } else {
      agencyId = req.user.agencyId;
    }
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const parsedFile = parseLeadFile(req.file.buffer);
    if (parsedFile.error) {
      return res.status(400).json({ success: false, error: parsedFile.error, message: parsedFile.message });
    }
    if (parsedFile.leads.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'NO_VALID_ROWS',
        message: 'No rows had a usable name column.',
        skipped: parsedFile.skipped,
      });
    }

    let created = 0;
    const failures = parsedFile.skipped.map((s) => ({ row: s.row, reason: s.reason }));

    for (const row of parsedFile.leads) {
      try {
        const result = await createLeadRecord({ agencyId, source: 'bulk_upload', createdById: req.user.id, data: row });
        created += 1;
        await recordAudit({
          actorId: req.user.id,
          actorRole: req.user.role,
          agencyId,
          action: 'lead.created',
          entityType: 'Lead',
          entityId: result.lead.id,
          after: result.lead,
          correlationId: req.correlationId,
        });
      } catch (err) {
        failures.push({ row: row._sourceRow, reason: err.message || 'Failed to create this row.' });
      }
    }

    return res.json({
      success: true,
      totalRows: parsedFile.totalRows,
      truncated: parsedFile.truncated,
      created,
      skipped: failures.length,
      failures: failures.slice(0, 50),
    });
  } catch (err) {
    next(err);
  }
});

// Registered before /:leadId — "funnel" would otherwise be swallowed as a
// leadId by that param route (same anti-shadowing pattern already used
// elsewhere in this app, e.g. transfers.js's /credit-requests).
router.get('/funnel', async (req, res, next) => {
  try {
    const agencyId = scopeAgencyId(req);
    if (req.user.role !== 'PLATFORM_OWNER' && !agencyId) {
      return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    }
    const scope = req.query.scope === 'me' ? 'me' : 'agency';
    if (scope === 'me' && !['PRODUCER', 'TELEMARKETER'].includes(req.user.role)) {
      return res.status(400).json({ success: false, error: 'NOT_APPLICABLE', message: 'scope=me applies to Producers.' });
    }

    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getFullYear(), to.getMonth(), 1);

    const mine = scope === 'me' ? await computeFunnel({ agencyId, userId: req.user.id, from, to }) : null;
    const agencyWide = await computeFunnel({ agencyId, from, to });

    return res.json({
      success: true,
      period: { from: from.toISOString(), to: to.toISOString() },
      mine,
      agency: agencyWide,
    });
  } catch (err) {
    next(err);
  }
});

// Registered before /:leadId for the same anti-shadowing reason as /funnel.
// The claimable pool: unassigned leads from vendors configured for MOSHPIT
// distribution, agency-scoped.
router.get('/moshpit', async (req, res, next) => {
  try {
    const agencyId = scopeAgencyId(req);
    if (req.user.role !== 'PLATFORM_OWNER' && !agencyId) {
      return res.json({ success: true, leads: [] });
    }

    const leads = await prisma.lead.findMany({
      where: {
        assignedToId: null,
        archivedAt: null,
        OR: [{ vendor: { distributionMode: 'MOSHPIT' } }, { isLiveTransfer: true }],
        ...(agencyId ? { agencyId } : {}),
      },
      include: {
        customer: true,
        vendor: { select: { id: true, name: true } },
      },
      orderBy: [{ priorityScore: 'desc' }, { receivedAt: 'desc' }],
    });

    return res.json({ success: true, leads });
  } catch (err) {
    next(err);
  }
});

// Registered before /:leadId for the same anti-shadowing reason as /funnel.
// The Main Stage "leads snapshot" box — total/Moshpit/untouched/quoted/sold
// counts for a date range, all scoped to receivedAt so every number moves
// together with the same date-range selector.
router.get('/snapshot', async (req, res, next) => {
  try {
    if (!['AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const agencyId = scopeAgencyId(req);
    if (req.user.role !== 'PLATFORM_OWNER' && !agencyId) {
      return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    }

    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getFullYear(), to.getMonth(), 1);
    const baseWhere = { agencyId, receivedAt: { gte: from, lte: to }, archivedAt: null };

    const [totalLeads, untouched, quoted, sold, inMoshpit] = await Promise.all([
      prisma.lead.count({ where: baseWhere }),
      prisma.lead.count({ where: { ...baseWhere, firstAttemptAt: null } }),
      prisma.lead.count({ where: { ...baseWhere, status: { in: ['QUOTE_STARTED', 'QUOTED', 'APPOINTMENT', 'FOLLOW_UP', 'SOLD'] } } }),
      prisma.lead.count({ where: { ...baseWhere, status: 'SOLD' } }),
      prisma.lead.count({ where: { ...baseWhere, assignedToId: null, OR: [{ vendor: { distributionMode: 'MOSHPIT' } }, { isLiveTransfer: true }] } }),
    ]);

    return res.json({
      success: true,
      period: { from: from.toISOString(), to: to.toISOString() },
      totalLeads, untouched, quoted, sold, inMoshpit,
    });
  } catch (err) {
    next(err);
  }
});

// Atomic optimistic claim — the updateMany's assignedToId: null guard is
// what makes this race-safe: if two producers claim the same lead at
// the same instant, only one updateMany can match assignedToId: null
// (the other loses the race and gets 409, never a double-assignment).
router.post('/:leadId/claim', async (req, res, next) => {
  try {
    if (req.user.role !== 'PRODUCER') {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Only producers can claim Moshpit leads.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id: req.params.leadId },
      include: { vendor: { select: { distributionMode: true } } },
    });
    if (!lead) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (lead.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (!lead.isLiveTransfer && (!lead.vendor || lead.vendor.distributionMode !== 'MOSHPIT')) {
      return res.status(400).json({ success: false, error: 'NOT_CLAIMABLE', message: 'This lead is not in the Moshpit.' });
    }

    const now = new Date();
    const claim = await prisma.lead.updateMany({
      where: { id: lead.id, assignedToId: null },
      data: { assignedToId: req.user.id, assignedAt: now, status: 'ASSIGNED' },
    });

    if (claim.count === 0) {
      return res.status(409).json({ success: false, error: 'ALREADY_CLAIMED', message: 'Another producer already claimed this lead.' });
    }

    const updated = await prisma.lead.findUnique({
      where: { id: lead.id },
      include: {
        customer: true,
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    await prisma.leadEvent.create({
      data: {
        leadId: lead.id,
        type: 'lead.claimed',
        fromStatus: lead.status,
        toStatus: 'ASSIGNED',
        metadata: { claimedById: req.user.id },
      },
    });

    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      agencyId: lead.agencyId,
      action: 'lead.claimed',
      entityType: 'Lead',
      entityId: lead.id,
      after: { assignedToId: req.user.id },
      correlationId: req.correlationId,
    });

    return res.json({ success: true, lead: updated });
  } catch (err) {
    next(err);
  }
});

router.get('/:leadId', async (req, res, next) => {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.leadId },
      include: {
        customer: true,
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        vendor: { select: { id: true, name: true, product: true } },
        events: { orderBy: { createdAt: 'desc' } },
        notes: { include: { author: { select: { firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' } },
        activities: { include: { createdBy: { select: { firstName: true, lastName: true } } }, orderBy: { occurredAt: 'desc' } },
        tasks: { include: { assignedTo: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!lead) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && lead.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    return res.json({ success: true, lead });
  } catch (err) {
    next(err);
  }
});

async function loadLeadWithAccessCheck(req) {
  const lead = await prisma.lead.findUnique({ where: { id: req.params.leadId } });
  if (!lead) return { lead: null, forbidden: false };
  if (req.user.role !== 'PLATFORM_OWNER' && lead.agencyId !== req.user.agencyId) {
    return { lead, forbidden: true };
  }
  return { lead, forbidden: false };
}

const activitySchema = z.object({
  type: z.enum(['CALL', 'EMAIL', 'TEXT']),
  direction: z.enum(['OUTBOUND', 'INBOUND']).optional().default('OUTBOUND'),
  outcome: z.string().optional(),
  occurredAt: z.string().datetime().optional(),
});

// Log a real interaction with a lead — "I called them", "I emailed them",
// "I texted them" — distinct from LeadNote (freeform notes) and LeadEvent
// (system-generated status-change history). This is what "activity count"
// on a lead means.
router.post('/:leadId/activities', async (req, res, next) => {
  try {
    const parsed = activitySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const { lead, forbidden } = await loadLeadWithAccessCheck(req);
    if (!lead) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (forbidden) return res.status(403).json({ success: false, error: 'FORBIDDEN' });

    const activity = await prisma.leadActivity.create({
      data: {
        leadId: lead.id,
        type: parsed.data.type,
        direction: parsed.data.direction,
        outcome: parsed.data.outcome || null,
        createdById: req.user.id,
        occurredAt: parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : new Date(),
      },
      include: { createdBy: { select: { firstName: true, lastName: true } } },
    });

    // "Attempts" means real outbound dials — a running count, not derived
    // from status, so it stays accurate regardless of how status is set.
    if (parsed.data.type === 'CALL' && parsed.data.direction === 'OUTBOUND') {
      await prisma.lead.update({ where: { id: lead.id }, data: { attemptCount: { increment: 1 } } });
    }

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: lead.agencyId,
      action: 'lead.activity_logged', entityType: 'Lead', entityId: lead.id,
      after: { type: activity.type, direction: activity.direction }, correlationId: req.correlationId,
    });

    return res.status(201).json({ success: true, activity });
  } catch (err) {
    next(err);
  }
});

const noteSchema = z.object({ content: z.string().min(1) });

// Standalone note creation — previously a note could only be attached as
// a side effect of a disposition change; this lets a producer jot a note
// without also changing the lead's status.
router.post('/:leadId/notes', async (req, res, next) => {
  try {
    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const { lead, forbidden } = await loadLeadWithAccessCheck(req);
    if (!lead) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (forbidden) return res.status(403).json({ success: false, error: 'FORBIDDEN' });

    const note = await prisma.leadNote.create({
      data: { leadId: lead.id, authorId: req.user.id, content: parsed.data.content },
      include: { author: { select: { firstName: true, lastName: true } } },
    });

    return res.status(201).json({ success: true, note });
  } catch (err) {
    next(err);
  }
});

const dispositionSchema = z.object({
  status: z.enum([
    'NEW', 'ASSIGNED', 'ATTEMPTED', 'CONTACTED', 'LEFT_VM', 'APPOINTMENT', 'QUOTE_STARTED',
    'QUOTED', 'QUOTED_HOT', 'FOLLOW_UP', 'SOLD', 'LOST', 'NOT_INTERESTED', 'BAD_CONTACT',
    'DUPLICATE', 'DO_NOT_CONTACT', 'INELIGIBLE', 'ARCHIVED',
  ]),
  note: z.string().optional(),
  saleProduct: z.string().optional(),
  salePremiumCents: z.number().int().positive().optional(),
});

// Disposition a lead — records status HISTORY, never overwrites it.
router.post('/:leadId/disposition', async (req, res, next) => {
  try {
    const parsed = dispositionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.leadId },
      include: { createdBy: { select: { role: true } } },
    });
    if (!lead) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && lead.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    const fromStatus = lead.status;
    const now = new Date();
    const patch = { status: parsed.data.status };
    if (fromStatus === 'NEW' || fromStatus === 'ASSIGNED') {
      if (!lead.firstAttemptAt && ['ATTEMPTED', 'CONTACTED'].includes(parsed.data.status)) {
        patch.firstAttemptAt = now;
      }
    }
    if (parsed.data.status === 'CONTACTED' && !lead.firstContactAt) {
      patch.firstContactAt = now;
    }
    if (parsed.data.status === 'SOLD') {
      patch.saleProduct = parsed.data.saleProduct || null;
      patch.salePremiumCents = parsed.data.salePremiumCents || null;
    }
    // Duplicate/Archived both mean "hide from active views" — same real
    // archivedAt field GET /leads and other agency-wide counts already
    // filter on, never a hard delete.
    if (['DUPLICATE', 'ARCHIVED'].includes(parsed.data.status) && !lead.archivedAt) {
      patch.archivedAt = now;
    }

    const [updated] = await prisma.$transaction([
      prisma.lead.update({ where: { id: lead.id }, data: patch }),
      prisma.leadEvent.create({
        data: {
          leadId: lead.id,
          type: 'lead.disposition',
          fromStatus,
          toStatus: parsed.data.status,
          metadata: { note: parsed.data.note || null },
        },
      }),
      ...(parsed.data.note
        ? [prisma.leadNote.create({ data: { leadId: lead.id, authorId: req.user.id, content: parsed.data.note } })]
        : []),
    ]);

    const { priorityScore, priorityReason } = scoreLead(updated);
    await prisma.lead.update({ where: { id: lead.id }, data: { priorityScore, priorityReason } });

    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      agencyId: lead.agencyId,
      action: 'lead.disposition',
      entityType: 'Lead',
      entityId: lead.id,
      before: { status: fromStatus },
      after: { status: parsed.data.status },
      correlationId: req.correlationId,
    });

    // Real, entered sale premium feeds the Financial Ledger directly.
    if (parsed.data.status === 'SOLD' && parsed.data.salePremiumCents) {
      await recordLeadSaleRevenue(updated);
    }

    // A real sold product updates the customer's real product ledger and
    // detects genuine cross-sell gaps — same honest, non-fabricated hook
    // used for the transfer path.
    if (parsed.data.status === 'SOLD' && updated.customerId && parsed.data.saleProduct) {
      await updateCustomerProductsAndDetectCrossSells({
        customerId: updated.customerId,
        agencyId: lead.agencyId,
        soldProduct: parsed.data.saleProduct,
      });
    }

    // A disposition changes real conversion/responsiveness signal —
    // recompute the assigned producer's and agency's Flow Score now
    // rather than on every dashboard view.
    Promise.all([
      updated.assignedToId ? computeProducerScore(updated.assignedToId) : Promise.resolve(),
      computeAgencyScore(lead.agencyId),
      // Only when this lead was actually submitted by a Telemarketer — a
      // Producer's own self-created lead must never trigger a Telemarketer
      // score recompute for that Producer.
      lead.createdById && lead.createdBy?.role === 'TELEMARKETER' ? computeTelemarketerScore(lead.createdById) : Promise.resolve(),
    ]).catch((err) => console.error('[flowScore] recompute after lead disposition failed', err.message));

    return res.json({ success: true, lead: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
