const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole, scopeAgencyId } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { scoreLead } = require('../lib/priority');
const { deriveLeadType, BULK_UPLOAD_CATEGORIES, applyBulkUploadCategory } = require('../lib/leadType');
const { normalizePhone, normalizeEmail } = require('../lib/normalize');
const { PRODUCTS, PRODUCT_LABELS } = require('../lib/products');
const { autoAdvanceLeadStatus } = require('../lib/leadStatusAuto');
const { notifyUser, notifyUsers, notifyAgencyOwners } = require('../lib/notifications');
const { updateCustomerProductsAndDetectCrossSells } = require('../lib/opportunityEvents');
const { computeProducerScore, computeAgencyScore, computeTelemarketerScore } = require('../lib/flowScore');
const { computeFunnel } = require('../lib/funnelMetrics');
const { parseLeadFileWithAi } = require('../lib/leadBulkImport');
const { parseHistoricalFileWithAi } = require('../lib/historicalDataImport');
const { resolveManualAssignment } = require('../lib/leadDistribution');
const { eligibleProducersWhere } = require('../lib/eligibleProducersQuery');
const { computeZipBreakdown } = require('../lib/zipBreakdown');
const { sendZipReportEmail } = require('../lib/email');

const router = express.Router();
router.use(requireAuth);

// Small cap — a lead-list spreadsheet is text/rows, never a large binary;
// mirrors calls.js's memoryStorage()-with-no-fileFilter convention (real
// validation happens after upload, inside parseLeadFile).
const uploadSpreadsheet = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Same enum Vendor.distributionMode already uses (lib/leadDistribution.js) —
// a bulk upload picks one of these for the whole batch rather than a
// second, parallel vocabulary.
const DISTRIBUTION_MODES = ['ROUND_ROBIN', 'SELECTED_AGENTS', 'MOSHPIT', 'ALPHA_SPLIT', 'OFFICE_SPLIT'];

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

    // Live/Yield Transfers (telemarketer-sourced leads) is a gated module —
    // POST already blocks a telemarketer's submission outright when it's
    // off; this is the matching GET-side check so an Agency Owner/Manager/
    // Producer viewing the Yield Transfers screen for a not-entitled
    // agency sees a real, honest reason instead of a silent, unexplained
    // empty list indistinguishable from "entitled but no leads yet."
    if (req.query.source === 'telemarketer' && !isTelemarketer && req.user.role !== 'PLATFORM_OWNER') {
      const agency = await prisma.agency.findUnique({ where: { id: agencyId }, select: { transfersEnabled: true, name: true } });
      if (agency && !agency.transfersEnabled) {
        return res.status(403).json({
          success: false,
          error: 'MODULE_NOT_ENTITLED',
          message: `${agency.name} does not currently have Yield Transfers enabled on its plan.`,
        });
      }
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 100);

    // `stage` mirrors the exact groupings computeFunnel() uses, so a drill-down
    // click from a funnel rate lands on precisely the leads behind that rate.
    const STAGE_FILTERS = {
      contacted: { firstContactAt: { not: null } },
      quoted: { status: { in: ['QUOTED', 'APPOINTMENT', 'FOLLOW_UP', 'SOLD'] } },
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
async function createLeadRecord({ agencyId, source, createdById, data, importBatchId }) {
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

    // Phone-number-level suppression (TCPA) — a Customer previously marked
    // DO_NOT_CONTACT (via any past Lead's disposition, from any source)
    // never gets a new, workable Lead: force straight to DO_NOT_CONTACT,
    // unassigned, and archived (hidden from GET /leads' default view, the
    // Moshpit pool, and priority recompute — same mechanism DUPLICATE/
    // ARCHIVED already use) rather than letting a new vendor/upload/
    // telemarketer submission re-surface this person for outreach.
    const isSuppressed = customer.doNotContact;

    const intakeFields = Object.fromEntries(
      INTAKE_FIELD_KEYS.filter((key) => data[key]).map((key) => [key, data[key]])
    );

    const lead = await tx.lead.create({
      data: {
        agencyId,
        customerId: customer.id,
        source,
        product: data.product,
        crossSellHaveProduct: data.crossSellHaveProduct || null,
        assignedToId: isSuppressed ? null : data.assignedToId,
        assignedAt: !isSuppressed && data.assignedToId ? new Date() : null,
        status: isSuppressed ? 'DO_NOT_CONTACT' : 'NEW',
        archivedAt: isSuppressed ? new Date() : null,
        createdById,
        customFields: data.customFields || {},
        // Lossless full-row capture from a bulk/back-catalog import only —
        // never manual creation, vendor API, or telemarketer intake, and
        // deliberately a SEPARATE bucket from customFields (which already
        // holds hand-entered/vendor-named values this would otherwise risk
        // colliding with, e.g. a spreadsheet column literally named
        // "Current Carrier").
        rawImportFields: data.rawImportFields || null,
        dob: data.dob ? new Date(data.dob) : null,
        isLiveTransfer: !!data.isLiveTransfer,
        // Every telemarketer-submitted lead becomes Moshpit-claimable —
        // not just ones explicitly flagged as a live transfer (that flag
        // stays purely informational, driving the notification's urgency
        // framing below, not eligibility) — except a suppressed Customer,
        // who must never be offered up for anyone to claim/contact.
        moshpitEligible: isSuppressed ? false : source === 'telemarketer' ? true : !!data.moshpitEligible,
        leadType: data.leadTypeOverride || deriveLeadType({ isLiveTransfer: !!data.isLiveTransfer }),
        importBatchId: importBatchId || null,
        ...intakeFields,
      },
    });

    const agencyRow = await tx.agency.findUnique({ where: { id: agencyId }, select: { priorityRules: true } });
    const { priorityScore, priorityBand, priorityReason } = scoreLead(lead, agencyRow?.priorityRules);
    const updatedLead = await tx.lead.update({
      where: { id: lead.id },
      data: { priorityScore, priorityReason },
    });

    await tx.leadEvent.create({
      data: {
        leadId: lead.id,
        type: duplicateOf ? 'lead.created.possible_duplicate' : 'lead.created',
        toStatus: updatedLead.status,
        metadata: {
          source,
          priorityBand,
          // Carries a ported-in historical row's own status/disposition
          // text, if any (see leadBulkImport.js's externalStatus column) —
          // provenance only, logged here rather than as a LeadNote so it
          // never counts as "real work" against bulk-import undo's
          // untouched-since-import check.
          ...(data.externalStatus ? { externalStatus: data.externalStatus } : {}),
          ...(isSuppressed ? { suppressedReason: customer.doNotContactReason || 'Customer marked DO_NOT_CONTACT' } : {}),
        },
      },
    });

    return { lead: updatedLead, customer, isDuplicate: !!duplicateOf, isSuppressed };
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

    // A suppressed Customer's forced-DO_NOT_CONTACT Lead is never assigned
    // or distributed (createLeadRecord already enforces that at the data
    // level) — skip every notification below too, so nobody is nudged to
    // reach out to someone who opted out.
    if (result.isSuppressed) {
      // no-op
    } else if (parsed.data.assignedToId) {
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
      // Every telemarketer lead is now Moshpit-eligible (see
      // createLeadRecord's moshpitEligible logic above) — broadcast to
      // every eligible producer the same real "first to claim it gets it"
      // way a vendor-sourced Moshpit lead already does. isLiveTransfer
      // only changes the framing/urgency of the message, never whether
      // it's sent.
      const eligibleProducers = await prisma.user.findMany({
        where: { agencyId, role: 'PRODUCER', status: 'ACTIVE' },
        select: { id: true },
      });
      await notifyUsers(eligibleProducers.map((u) => u.id), {
        agencyId,
        type: 'lead.moshpit_available',
        severity: isLiveTransfer ? 'ACTION' : 'INFO',
        title: isLiveTransfer ? 'Live transfer — caller is on the line' : 'New Moshpit lead from a telemarketer',
        body: `${result.customer.firstName} ${result.customer.lastName}${parsed.data.product ? ' — ' + parsed.data.product : ''}. First to claim it gets it.`,
        relatedEntityType: 'Lead',
        relatedEntityId: result.lead.id,
      });
    }

    return res.status(201).json({ success: true, lead: result.lead, possibleDuplicate: result.isDuplicate, suppressed: result.isSuppressed });
  } catch (err) {
    next(err);
  }
});

// Bulk lead-list upload (CSV/XLS/XLSX) — Agency Owner/Manager for their own
// agency, or Platform Owner on behalf of a given agency. Each parsed row
// goes through the exact same createLeadRecord() transaction a manual
// single-lead submission does — no second/thinner creation path.
// Shared by POST /bulk-import (live, distribution-aware) and POST
// /back-catalog-import (historical, always-unassigned) — parse once,
// create one Lead per row via the same createLeadRecord transaction every
// other intake path uses, track the batch so undo/history work the exact
// same way regardless of which route created it. The two routes differ
// only in how `assignRow` resolves each row's assignedToId/moshpitEligible
// and in whether/how they notify afterward — never in the create path
// itself.
async function importLeadsFromFile({ fileBuffer, agencyId, uploaderId, actorRole, leadCategory, categoryFields, sourceOverride, sourceSystem, assignRow, correlationId }) {
  const parsedFile = await parseLeadFileWithAi(fileBuffer);
  if (parsedFile.error) {
    return { error: parsedFile.error, message: parsedFile.message };
  }
  if (parsedFile.leads.length === 0) {
    return { error: 'NO_VALID_ROWS', message: 'No rows had a usable name column.', skipped: parsedFile.skipped };
  }

  // Created up front (before the per-row loop) so every Lead this upload
  // creates can carry its id — that's what POST /import-batches/:id/undo
  // later uses to find and reverse exactly this batch, and only this one.
  const batch = await prisma.leadImportBatch.create({
    data: { agencyId, uploadedById: uploaderId, leadCategory, totalRows: parsedFile.totalRows, created: 0, skipped: 0, sourceSystem: sourceSystem || null },
  });

  let created = 0;
  const failures = parsedFile.skipped.map((s) => ({ row: s.row, reason: s.reason }));
  // A plain in-memory counter, not a persisted/atomic cursor — safe here
  // because this one request processes every row sequentially in a
  // single process (see resolveManualAssignment's own doc comment for
  // why that's the real distinction from the vendor webhook path).
  let cursor = 0;
  const assignedCounts = new Map(); // producerId -> count, for ONE aggregate notification each, not one per lead.
  let moshpitCount = 0;
  const createdLeads = [];

  for (const row of parsedFile.leads) {
    try {
      const assignment = await assignRow(row, cursor);
      cursor = assignment.nextCursor;

      const result = await createLeadRecord({
        agencyId,
        source: sourceOverride,
        createdById: uploaderId,
        data: { ...row, ...categoryFields, assignedToId: assignment.assignedToId, moshpitEligible: assignment.moshpitEligible, rawImportFields: row.rawImportFields },
        importBatchId: batch.id,
      });
      created += 1;
      createdLeads.push({ lead: result.lead, row });
      if (assignment.assignedToId) {
        assignedCounts.set(assignment.assignedToId, (assignedCounts.get(assignment.assignedToId) || 0) + 1);
      } else if (assignment.moshpitEligible) {
        moshpitCount += 1;
      }
      await recordAudit({
        actorId: uploaderId,
        actorRole,
        agencyId,
        action: 'lead.created',
        entityType: 'Lead',
        entityId: result.lead.id,
        after: result.lead,
        correlationId,
      });
    } catch (err) {
      failures.push({ row: row._sourceRow, reason: err.message || 'Failed to create this row.' });
    }
  }

  await prisma.leadImportBatch.update({ where: { id: batch.id }, data: { created, skipped: failures.length } });

  return { batch, parsedFile, created, failures, assignedCounts, moshpitCount, createdLeads };
}

router.post('/bulk-import', uploadSpreadsheet.single('file'), async (req, res, next) => {
  try {
    if (!['AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Expected a multipart field named "file".' });
    }
    const leadCategory = req.body.leadCategory;
    if (!leadCategory || !Object.keys(BULK_UPLOAD_CATEGORIES).includes(leadCategory)) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION',
        message: 'Choose what kind of leads this list is before uploading.',
      });
    }
    const categoryFields = applyBulkUploadCategory(leadCategory);

    // How this batch gets routed — same vocabulary/engine a vendor's
    // real-time leads already use (lib/leadDistribution.js), just applied
    // once per batch instead of once per vendor. Defaults to MOSHPIT
    // (visible and claimable) rather than silently leaving every lead
    // unassigned AND un-claimable, which is what every bulk upload did
    // before this field existed.
    const distributionMode = DISTRIBUTION_MODES.includes(req.body.distributionMode) ? req.body.distributionMode : 'MOSHPIT';
    let selectedAgentIds = [];
    if (distributionMode === 'SELECTED_AGENTS') {
      try {
        selectedAgentIds = JSON.parse(req.body.selectedAgentIds || '[]');
      } catch {
        return res.status(400).json({ success: false, error: 'VALIDATION', message: 'selectedAgentIds must be a JSON array of user ids.' });
      }
      if (!Array.isArray(selectedAgentIds) || selectedAgentIds.length === 0) {
        return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Pick at least one producer for "Specific producers."' });
      }
    }

    let agencyId;
    if (req.user.role === 'PLATFORM_OWNER') {
      agencyId = req.body.agencyId;
      if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    } else {
      agencyId = req.user.agencyId;
    }
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const outcome = await importLeadsFromFile({
      fileBuffer: req.file.buffer,
      agencyId,
      uploaderId: req.user.id,
      actorRole: req.user.role,
      leadCategory,
      categoryFields,
      sourceOverride: categoryFields.sourceOverride || 'bulk_upload',
      correlationId: req.correlationId,
      assignRow: async (row, cursor) => {
        const assignment = await resolveManualAssignment(prisma, { agencyId, mode: distributionMode, selectedAgentIds, cursor, lastName: row.lastName, city: row.city, zip: row.zip });
        return { assignedToId: assignment.assignedToId, moshpitEligible: assignment.mode === 'MOSHPIT', nextCursor: assignment.nextCursor };
      },
    });
    if (outcome.error) {
      return res.status(outcome.error === 'NO_VALID_ROWS' ? 400 : 400).json({ success: false, error: outcome.error, message: outcome.message, skipped: outcome.skipped });
    }
    const { batch, parsedFile, created, failures, assignedCounts, moshpitCount } = outcome;

    // One notification per affected producer/agency for the whole batch —
    // never one per lead, which would flood a producer's notification feed
    // on a large import (mirrors vendorApi.js's per-lead version, scaled up
    // to per-batch since this route creates many leads in one request).
    const categoryLabel = leadCategory.replace(/_/g, ' ').toLowerCase();
    await Promise.all(
      [...assignedCounts.entries()].map(([producerId, count]) =>
        notifyUser({
          userId: producerId,
          agencyId,
          type: 'lead.assigned',
          severity: 'INFO',
          title: count === 1 ? 'New lead assigned to you' : `${count} new leads assigned to you`,
          body: `From a ${categoryLabel} list upload.`,
          relatedEntityType: 'LeadImportBatch',
          relatedEntityId: batch.id,
        })
      )
    );
    if (moshpitCount > 0) {
      const eligibleProducers = await prisma.user.findMany({
        where: { agencyId, role: 'PRODUCER', status: 'ACTIVE' },
        select: { id: true },
      });
      await notifyUsers(eligibleProducers.map((u) => u.id), {
        agencyId,
        type: 'lead.moshpit_available',
        severity: 'INFO',
        title: moshpitCount === 1 ? 'New Moshpit lead available' : `${moshpitCount} new Moshpit leads available`,
        body: `From a ${categoryLabel} list upload. First to claim it gets it.`,
        relatedEntityType: 'LeadImportBatch',
        relatedEntityId: batch.id,
      });
    }

    return res.json({
      success: true,
      batchId: batch.id,
      totalRows: parsedFile.totalRows,
      truncated: parsedFile.truncated,
      created,
      skipped: failures.length,
      failures: failures.slice(0, 50),
      distributionMode,
      assigned: created - moshpitCount,
      sentToMoshpit: moshpitCount,
      columnMapping: parsedFile.columnMapping,
    });
  } catch (err) {
    next(err);
  }
});

// External systems a "Back Catalog" historical import can be labeled as
// having come from — purely a tag on the LeadImportBatch for the history
// list; the parsing/creation path is identical regardless of which one is
// picked (see leadBulkImport.js's own fuzzy column matching).
const BACK_CATALOG_SYSTEMS = ['PERFORMOLOGY', 'AGENCYZOOM', 'RICOCHET', 'OTHER'];

// Historical data port-in — Performology/AgencyZoom/Ricochet/other legacy
// system exports. Deliberately simpler than /bulk-import: always lands
// unassigned and NOT Moshpit-eligible (this is backfill, not a live lead
// that should ping a producer or show up in the claim pool), and never
// sends a notification. A source file's own status/disposition column (if
// any) is folded into a LeadNote rather than trusted as Lead.status —
// "SOLD" has real revenue side effects elsewhere that must never be
// fabricated from an unverified historical import.
router.post('/back-catalog-import', uploadSpreadsheet.single('file'), async (req, res, next) => {
  try {
    if (!['AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Expected a multipart field named "file".' });
    }
    const sourceSystem = req.body.sourceSystem;
    if (!BACK_CATALOG_SYSTEMS.includes(sourceSystem)) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Choose which system this data is coming from.' });
    }
    const leadCategory = req.body.leadCategory;
    if (!leadCategory || !Object.keys(BULK_UPLOAD_CATEGORIES).includes(leadCategory)) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Choose what kind of leads this list is before uploading.' });
    }
    const categoryFields = applyBulkUploadCategory(leadCategory);

    let agencyId;
    if (req.user.role === 'PLATFORM_OWNER') {
      agencyId = req.body.agencyId;
      if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    } else {
      agencyId = req.user.agencyId;
    }
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const outcome = await importLeadsFromFile({
      fileBuffer: req.file.buffer,
      agencyId,
      uploaderId: req.user.id,
      actorRole: req.user.role,
      leadCategory,
      categoryFields,
      sourceOverride: `backcatalog_${sourceSystem.toLowerCase()}`,
      sourceSystem,
      correlationId: req.correlationId,
      assignRow: async (_row, cursor) => ({ assignedToId: null, moshpitEligible: false, nextCursor: cursor }),
    });
    if (outcome.error) {
      return res.status(400).json({ success: false, error: outcome.error, message: outcome.message, skipped: outcome.skipped });
    }
    const { batch, parsedFile, created, failures } = outcome;

    return res.json({
      success: true,
      batchId: batch.id,
      sourceSystem,
      totalRows: parsedFile.totalRows,
      truncated: parsedFile.truncated,
      created,
      skipped: failures.length,
      failures: failures.slice(0, 50),
      columnMapping: parsedFile.columnMapping,
    });
  } catch (err) {
    next(err);
  }
});

// Best-effort case-insensitive name -> id lookup for Historical Data import
// row matching — built once per request (not once per row) since an
// agency's vendor/producer roster is small. An ambiguous name (two rows
// sharing the same normalized name) resolves to null rather than guessing.
function buildNameIndex(rows, nameOf) {
  const index = new Map();
  const seen = new Set();
  for (const row of rows) {
    const key = nameOf(row).trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) index.set(key, null);
    else {
      seen.add(key);
      index.set(key, row.id);
    }
  }
  return index;
}

// Historical Data — raw facts for numbers/pattern-learning only, never a
// workable Lead. No Customer, no distribution, no notification: the entire
// point is this never shows up anywhere a producer would see or claim it.
// See lib/historicalDataImport.js's own header comment for why this uses a
// separate parser/vocabulary from the live-lead importer.
router.post('/historical-data-import', uploadSpreadsheet.single('file'), async (req, res, next) => {
  try {
    if (!['AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Expected a multipart field named "file".' });
    }
    const sourceSystem = req.body.sourceSystem;
    if (!BACK_CATALOG_SYSTEMS.includes(sourceSystem)) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Choose which system this data is coming from.' });
    }

    let agencyId;
    if (req.user.role === 'PLATFORM_OWNER') {
      agencyId = req.body.agencyId;
      if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    } else {
      agencyId = req.user.agencyId;
    }
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const parsedFile = await parseHistoricalFileWithAi(req.file.buffer);
    if (parsedFile.error) {
      return res.status(400).json({ success: false, error: parsedFile.error, message: parsedFile.message });
    }
    if (parsedFile.records.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'NO_VALID_ROWS',
        message: 'No rows had a usable date column.',
        skipped: parsedFile.skipped,
      });
    }

    const [vendors, agents, offices] = await Promise.all([
      prisma.vendor.findMany({ where: { agencyId }, select: { id: true, name: true } }),
      prisma.user.findMany({ where: { agencyId }, select: { id: true, firstName: true, lastName: true } }),
      prisma.office.findMany({ where: { agencyId }, select: { id: true, name: true } }),
    ]);
    const vendorIndex = buildNameIndex(vendors, (v) => v.name);
    const agentIndex = buildNameIndex(agents, (u) => `${u.firstName} ${u.lastName}`);
    const officeIndex = buildNameIndex(offices, (o) => o.name);

    const batch = await prisma.leadImportBatch.create({
      data: {
        agencyId, uploadedById: req.user.id, isHistorical: true, sourceSystem,
        leadCategory: null, totalRows: parsedFile.totalRows, created: 0, skipped: 0,
      },
    });

    let created = 0;
    const failures = parsedFile.skipped.map((s) => ({ row: s.row, reason: s.reason }));

    for (const record of parsedFile.records) {
      try {
        const vendorId = record.vendorNameRaw ? vendorIndex.get(record.vendorNameRaw.trim().toLowerCase()) || null : null;
        const assignedToId = record.agentNameRaw ? agentIndex.get(record.agentNameRaw.trim().toLowerCase()) || null : null;
        const officeId = record.officeNameRaw ? officeIndex.get(record.officeNameRaw.trim().toLowerCase()) || null : null;

        await prisma.historicalRecord.create({
          data: {
            agencyId,
            importBatchId: batch.id,
            recordDate: record.recordDate,
            firstName: record.firstName,
            lastName: record.lastName,
            phone: record.phone,
            email: record.email,
            product: record.product,
            zip: record.zip,
            vendorId,
            vendorNameRaw: record.vendorNameRaw,
            assignedToId,
            agentNameRaw: record.agentNameRaw,
            officeId,
            officeNameRaw: record.officeNameRaw,
            isSold: record.isSold,
            premiumCents: record.premiumCents,
            outcome: record.outcome,
            items: record.items,
            itemsSource: record.itemsSource,
            sourceSystem,
            rawFields: record.rawFields,
          },
        });
        created += 1;
      } catch (err) {
        failures.push({ row: record._sourceRow, reason: err.message || 'Failed to create this row.' });
      }
    }

    await prisma.leadImportBatch.update({ where: { id: batch.id }, data: { created, skipped: failures.length } });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId,
      action: 'historical_data.imported', entityType: 'LeadImportBatch', entityId: batch.id,
      after: { created, skipped: failures.length, sourceSystem }, correlationId: req.correlationId,
    });

    // A per-reason tally (parse-time skips from parsedFile.skippedReasons,
    // plus any create-time DB failures appended above) so the client can
    // show a clean breakdown ("340 missing/unparseable date") instead of
    // either a vague guess or every individual row for a large file.
    const skippedReasons = { ...parsedFile.skippedReasons };
    for (const f of failures) {
      if (f.row === undefined) continue;
      const isParseSkip = parsedFile.skipped.some((s) => s.row === f.row && s.reason === f.reason);
      if (!isParseSkip) skippedReasons[f.reason] = (skippedReasons[f.reason] || 0) + 1;
    }

    return res.json({
      success: true,
      batchId: batch.id,
      sourceSystem,
      totalRows: parsedFile.totalRows,
      truncated: parsedFile.truncated,
      created,
      skipped: failures.length,
      skippedReasons,
      failures: failures.slice(0, 50),
      columnMapping: parsedFile.columnMapping,
    });
  } catch (err) {
    next(err);
  }
});

// Undo window — a batch older than this can no longer be undone in one
// click (matches staleLeadReminders.js's own "a few business hours" scale
// for what counts as still-fresh activity on a lead).
const IMPORT_UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

// Whether a bulk-imported Lead has had zero real activity since creation —
// the only condition under which undo can safely archive it without
// throwing away real work (a disposition, a note, an assignment, a call).
function leadIsUntouchedSinceImport(lead) {
  return (
    lead.status === 'NEW' &&
    !lead.assignedToId &&
    !lead.firstAttemptAt &&
    !lead.firstContactAt &&
    lead.attemptCount === 0 &&
    lead._count.notes === 0 &&
    lead._count.activities === 0 &&
    lead._count.tasks === 0 &&
    lead._count.calls === 0 &&
    lead._count.productQuotes === 0
  );
}

// Recent bulk-import batches for this agency, each flagged with whether
// it's still within the undo window and how many of its leads are still
// untouched (i.e. what undo would actually archive right now).
router.get('/import-batches', async (req, res, next) => {
  try {
    if (!['AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const agencyId = req.user.role === 'PLATFORM_OWNER' ? req.query.agencyId : req.user.agencyId;
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    // Three separate history lists share this one route: the ordinary live
    // bulk-upload flow (isHistorical false, sourceSystem null), the Back
    // Catalog tab's historical-LEAD imports (isHistorical false, sourceSystem
    // set), and Historical Data imports (isHistorical true, numbers only) —
    // kept apart so no list's UI has to explain another's rows.
    const kind = req.query.kind;
    const where = { agencyId, isHistorical: kind === 'historical_data' };
    if (kind !== 'historical_data') {
      where.sourceSystem = kind === 'back_catalog' ? { not: null } : null;
    }

    const batches = await prisma.leadImportBatch.findMany({
      where,
      include: {
        uploadedBy: { select: { id: true, firstName: true, lastName: true } },
        leads: {
          select: {
            status: true, assignedToId: true, firstAttemptAt: true, firstContactAt: true, attemptCount: true, archivedAt: true,
            _count: { select: { notes: true, activities: true, tasks: true, calls: true, productQuotes: true } },
          },
        },
        _count: { select: { historicalRecords: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return res.json({
      success: true,
      batches: batches.map((b) => {
        if (b.isHistorical) {
          // No "untouched since import" concept for Historical Data — these
          // were never workable, so undo is always available, unconditionally.
          return {
            id: b.id, leadCategory: b.leadCategory, sourceSystem: b.sourceSystem, isHistorical: true,
            totalRows: b.totalRows, created: b.created, skipped: b.skipped,
            createdAt: b.createdAt, uploadedBy: b.uploadedBy, undoneAt: b.undoneAt,
            withinUndoWindow: true,
            undoableCount: b.undoneAt ? 0 : b._count.historicalRecords,
            totalActive: b._count.historicalRecords,
          };
        }
        const activeLeads = b.leads.filter((l) => !l.archivedAt);
        const undoable = activeLeads.filter(leadIsUntouchedSinceImport).length;
        return {
          id: b.id, leadCategory: b.leadCategory, sourceSystem: b.sourceSystem, isHistorical: false,
          totalRows: b.totalRows, created: b.created, skipped: b.skipped,
          createdAt: b.createdAt, uploadedBy: b.uploadedBy, undoneAt: b.undoneAt,
          withinUndoWindow: Date.now() - new Date(b.createdAt).getTime() < IMPORT_UNDO_WINDOW_MS,
          undoableCount: undoable, totalActive: activeLeads.length,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// Archives every still-untouched Lead from one bulk-import batch — never a
// hard delete (same archivedAt mechanism DUPLICATE/ARCHIVED dispositions
// already use), and never a lead that's since been worked (assigned,
// attempted, noted, or dispositioned) so real work is never thrown away.
//
// Two real races, both closed here:
// 1. Double-undo — two concurrent clicks (or two tabs) hitting this route
//    for the same batch at once. Closed by an atomic claim (updateMany on
//    LeadImportBatch gated on undoneAt: null, same idempotent-claim shape
//    as recordStoreProvisioning.js's provisionSubscription) — only one
//    request's claim can match, the other sees count: 0 and reports
//    ALREADY_UNDONE rather than double-processing.
// 2. Lost real work — the previous version read the untouched leads with
//    one SELECT, then archived exactly those ids with a second, later
//    statement that carried no further condition. Any real work landing
//    in between (a producer claiming/assigning/noting/dispositioning the
//    lead) was silently overwritten, because the archiving update() never
//    re-checked state at write time. Fixed by folding the "untouched"
//    predicate directly into the archiving updateMany's WHERE clause, so
//    Postgres evaluates it against the row's current state at the moment
//    of the write, inside the same transaction — not a stale JS snapshot.
router.post('/import-batches/:batchId/undo', async (req, res, next) => {
  try {
    if (!['AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const batch = await prisma.leadImportBatch.findUnique({ where: { id: req.params.batchId } });
    if (!batch) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && batch.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (batch.undoneAt) {
      return res.status(409).json({ success: false, error: 'ALREADY_UNDONE', message: 'This import was already undone.' });
    }
    if (!batch.isHistorical && Date.now() - new Date(batch.createdAt).getTime() > IMPORT_UNDO_WINDOW_MS) {
      return res.status(409).json({ success: false, error: 'WINDOW_EXPIRED', message: 'This import is too old to undo automatically — archive the leads individually instead.' });
    }

    const claim = await prisma.leadImportBatch.updateMany({
      where: { id: batch.id, undoneAt: null },
      data: { undoneAt: new Date(), undoneById: req.user.id },
    });
    if (claim.count === 0) {
      return res.status(409).json({ success: false, error: 'ALREADY_UNDONE', message: 'This import was already undone.' });
    }

    // Historical Data has no "untouched since import" concept — these rows
    // were never workable, so undo is an unconditional, unguarded delete.
    if (batch.isHistorical) {
      const { count } = await prisma.historicalRecord.deleteMany({ where: { importBatchId: batch.id } });
      await recordAudit({
        actorId: req.user.id, actorRole: req.user.role, agencyId: batch.agencyId,
        action: 'historical_data.import_undone', entityType: 'LeadImportBatch', entityId: batch.id,
        after: { deleted: count }, correlationId: req.correlationId,
      });
      return res.json({ success: true, archived: count, kept: 0 });
    }

    const { archived, kept } = await prisma.$transaction(async (tx) => {
      const candidates = await tx.lead.findMany({ where: { importBatchId: batch.id, archivedAt: null }, select: { id: true } });
      const candidateIds = candidates.map((l) => l.id);

      let archivedLeads = [];
      if (candidateIds.length > 0) {
        // The real guard: re-asserted here, not trusted from the SELECT
        // above, so anything that touched the lead between that SELECT
        // and this UPDATE (same transaction or not) excludes it for real.
        await tx.lead.updateMany({
          where: {
            id: { in: candidateIds },
            archivedAt: null,
            status: 'NEW',
            assignedToId: null,
            firstAttemptAt: null,
            firstContactAt: null,
            attemptCount: 0,
            notes: { none: {} },
            activities: { none: {} },
            tasks: { none: {} },
            calls: { none: {} },
            productQuotes: { none: {} },
          },
          data: { archivedAt: new Date() },
        });
        archivedLeads = await tx.lead.findMany({ where: { id: { in: candidateIds }, archivedAt: { not: null } }, select: { id: true } });
        if (archivedLeads.length > 0) {
          await tx.leadEvent.createMany({
            data: archivedLeads.map((lead) => ({ leadId: lead.id, type: 'lead.import_undone', metadata: { batchId: batch.id } })),
          });
        }
      }

      const totalActive = await tx.lead.count({ where: { importBatchId: batch.id, archivedAt: null } });
      return { archived: archivedLeads.length, kept: totalActive };
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: batch.agencyId,
      action: 'lead.import_undone', entityType: 'LeadImportBatch', entityId: batch.id,
      after: { archived, kept }, correlationId: req.correlationId,
    });

    return res.json({ success: true, archived, kept });
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
        OR: [{ vendor: { distributionMode: 'MOSHPIT' } }, { isLiveTransfer: true }, { moshpitEligible: true }],
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
      prisma.lead.count({ where: { ...baseWhere, status: { in: ['QUOTED', 'APPOINTMENT', 'FOLLOW_UP', 'SOLD'] } } }),
      prisma.lead.count({ where: { ...baseWhere, status: 'SOLD' } }),
      prisma.lead.count({ where: { ...baseWhere, assignedToId: null, OR: [{ vendor: { distributionMode: 'MOSHPIT' } }, { isLiveTransfer: true }, { moshpitEligible: true }] } }),
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

// Zip code performance — one row per zip this agency has received leads
// from. Requires agencyId unconditionally (even for PLATFORM_OWNER),
// mirroring financials.js's /by-vendor: an unscoped call would mean
// fanning the per-vendor cost lookups out across every agency on the
// platform, which isn't a real product surface.
router.get('/zip-report', async (req, res, next) => {
  try {
    if (!['AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const agencyId = scopeAgencyId(req);
    if (!agencyId) {
      return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    }

    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getFullYear(), to.getMonth(), 1);
    const rows = await computeZipBreakdown({ agencyId, from, to });

    return res.json({ success: true, period: { from: from.toISOString(), to: to.toISOString() }, rows });
  } catch (err) {
    next(err);
  }
});

const emailZipReportSchema = z.object({ to: z.string().email() });

router.post('/zip-report/email', async (req, res, next) => {
  try {
    if (!['AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const agencyId = scopeAgencyId(req);
    if (!agencyId) {
      return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    }
    const parsed = emailZipReportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Enter a valid email address.', fieldErrors: parsed.error.flatten() });
    }

    const agency = await prisma.agency.findUnique({ where: { id: agencyId }, select: { name: true } });
    if (!agency) return res.status(404).json({ success: false, error: 'AGENCY_NOT_FOUND' });

    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getFullYear(), to.getMonth(), 1);
    const rows = await computeZipBreakdown({ agencyId, from, to });

    const emailResult = await sendZipReportEmail({ to: parsed.data.to, agencyName: agency.name, rows });

    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      agencyId,
      action: 'zip_report.emailed',
      entityType: 'Agency',
      entityId: agencyId,
      after: { to: parsed.data.to, zipCount: rows.length },
      correlationId: req.correlationId,
    });

    return res.json({ success: true, emailStatus: emailResult.status });
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
    if (!lead.isLiveTransfer && !lead.moshpitEligible && (!lead.vendor || lead.vendor.distributionMode !== 'MOSHPIT')) {
      return res.status(400).json({ success: false, error: 'NOT_CLAIMABLE', message: 'This lead is not in the Moshpit.' });
    }

    const now = new Date();
    const claim = await prisma.lead.updateMany({
      where: { id: lead.id, assignedToId: null },
      data: { assignedToId: req.user.id, assignedAt: now },
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
        toStatus: lead.status,
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

// One real server-side authorization policy for every single-lead route
// below (list filtering above already restricts PRODUCER to assignedToId
// — this is the single-lead equivalent, applied consistently instead of
// each route hand-rolling its own, inconsistent check). A PRODUCER may
// always act on a lead actually assigned to them. The only other case
// allowed is a READ (never a write) of a still-unclaimed Moshpit-eligible
// lead, so they can preview it before deciding to claim — claiming itself
// still only ever happens through POST /:leadId/claim's own atomic,
// updateMany-guarded assignment, never granted here. Every other role
// keeps the existing agency-membership rule (PLATFORM_OWNER unrestricted).
function authorizeLeadAccess(req, lead, { write = false } = {}) {
  if (!lead) return { ok: false, status: 404, error: 'NOT_FOUND' };
  if (req.user.role !== 'PLATFORM_OWNER' && lead.agencyId !== req.user.agencyId) {
    return { ok: false, status: 403, error: 'FORBIDDEN' };
  }
  if (req.user.role === 'PRODUCER') {
    if (lead.assignedToId === req.user.id) return { ok: true };
    const isMoshpitEligible = lead.isLiveTransfer || lead.moshpitEligible || lead.vendor?.distributionMode === 'MOSHPIT';
    if (!write && lead.assignedToId === null && isMoshpitEligible) return { ok: true };
    return { ok: false, status: 403, error: 'FORBIDDEN' };
  }
  return { ok: true };
}

router.get('/:leadId', async (req, res, next) => {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.leadId },
      include: {
        customer: true,
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        vendor: { select: { id: true, name: true, product: true, distributionMode: true } },
        events: { orderBy: { createdAt: 'desc' } },
        notes: { include: { author: { select: { firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' } },
        activities: { include: { createdBy: { select: { firstName: true, lastName: true } } }, orderBy: { occurredAt: 'desc' } },
        tasks: { include: { assignedTo: { select: { id: true, firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' } },
        productQuotes: { orderBy: { product: 'asc' } },
      },
    });
    const access = authorizeLeadAccess(req, lead, { write: false });
    if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });
    return res.json({ success: true, lead });
  } catch (err) {
    next(err);
  }
});

async function loadLeadWithAccessCheck(req, { write = true } = {}) {
  const lead = await prisma.lead.findUnique({ where: { id: req.params.leadId } });
  const access = authorizeLeadAccess(req, lead, { write });
  return { lead, forbidden: !access.ok };
}

const reassignSchema = z.object({
  assignedToId: z.string().uuid(),
});

// Reassign an already-assigned lead to a different eligible active LSP in
// the same agency — a distinct action from POST /:leadId/claim (which
// exclusively assigns from assignedToId:null and sets assignedAt/the real
// "this is when the clock started" moment). Reassignment must never touch
// assignedAt/firstAttemptAt — doing so would let a reassignment restart
// the SLA clock a producer's own slow response already started.
router.post('/:leadId/reassign', async (req, res, next) => {
  try {
    const parsed = reassignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const { lead, forbidden } = await loadLeadWithAccessCheck(req);
    if (!lead) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (forbidden) return res.status(403).json({ success: false, error: 'FORBIDDEN' });

    const previousAssigneeId = lead.assignedToId;
    if (!previousAssigneeId) {
      return res.status(400).json({ success: false, error: 'NOT_ASSIGNED', message: 'This lead has no current assignee — use claim instead.' });
    }
    const { assignedToId: newAssigneeId } = parsed.data;
    if (newAssigneeId === previousAssigneeId) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'This lead is already assigned to that person.' });
    }

    // Never trust the client-supplied target blindly — must be a real,
    // active, production-eligible teammate in this exact same agency.
    const target = await prisma.user.findFirst({
      where: eligibleProducersWhere(lead.agencyId, { id: newAssigneeId }),
      select: { id: true },
    });
    if (!target) {
      return res.status(400).json({ success: false, error: 'INVALID_ASSIGNEE', message: 'assignedToId must be a real, active producer or manager in this agency.' });
    }

    // Atomic concurrency guard — same updateMany-then-recheck idiom as
    // /claim, keyed on the assignee actually still being who we read above.
    const result = await prisma.lead.updateMany({
      where: { id: lead.id, assignedToId: previousAssigneeId },
      data: { assignedToId: newAssigneeId },
    });
    if (result.count === 0) {
      return res.status(409).json({ success: false, error: 'ALREADY_REASSIGNED', message: 'This lead was just reassigned by someone else.' });
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
        type: 'lead.reassigned',
        fromStatus: lead.status,
        toStatus: lead.status,
        metadata: { fromAssigneeId: previousAssigneeId, toAssigneeId: newAssigneeId, reassignedById: req.user.id },
      },
    });

    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      agencyId: lead.agencyId,
      action: 'lead.reassigned',
      entityType: 'Lead',
      entityId: lead.id,
      before: { assignedToId: previousAssigneeId },
      after: { assignedToId: newAssigneeId },
      correlationId: req.correlationId,
    });

    return res.json({ success: true, lead: updated });
  } catch (err) {
    next(err);
  }
});

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

    // TCPA backstop: refuse to log an outbound call/text against a
    // Customer already marked DO_NOT_CONTACT, regardless of what this
    // particular Lead's own status says — a clear "don't reach out to
    // this person" warning at the one place a producer is about to record
    // that they did. Inbound contact (the customer reaching out to US) and
    // EMAIL are unaffected — this only gates the TCPA-relevant channels.
    if (lead.customerId && parsed.data.direction === 'OUTBOUND' && ['CALL', 'TEXT'].includes(parsed.data.type)) {
      const customer = await prisma.customer.findUnique({ where: { id: lead.customerId }, select: { doNotContact: true } });
      if (customer?.doNotContact) {
        return res.status(403).json({
          success: false,
          error: 'DO_NOT_CONTACT',
          message: 'This customer is marked DO_NOT_CONTACT. Outbound calls/texts cannot be logged against them.',
        });
      }
    }

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

    // firstAttemptAt marks the moment a producer first actually worked this
    // lead — set on any logged touch (inbound or outbound), independent of
    // whether status itself advances, since the real-time speed-to-lead SLA
    // check (firstAttemptSlaAlerts.js) keys off this timestamp specifically.
    if (!lead.firstAttemptAt) {
      await prisma.lead.update({ where: { id: lead.id }, data: { firstAttemptAt: new Date() } });
    }

    // Inbound contact means the customer actually engaged back — a lead a
    // producer got a live response from should never keep reading
    // "untouched." An outbound-only touch (a call/text/email that didn't
    // reach the customer) no longer auto-advances status on its own; the
    // producer's own disposition (Left VM, etc.) is what moves it forward.
    if (parsed.data.direction === 'INBOUND') {
      await autoAdvanceLeadStatus({ leadId: lead.id, targetStatus: 'CONTACTED', reason: `activity_logged:${parsed.data.type}` });
    }

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

// Recomputes Lead.salePremiumCents/saleProduct as a derived sum/join of this
// lead's SOLD LeadProductQuote rows, so the existing per-vendor/per-zip
// revenue reports (which read those two fields directly off Lead, not this
// new table) stay correct without needing their own changes.
async function syncLeadSaleFieldsFromProductQuotes(leadId) {
  const soldRows = await prisma.leadProductQuote.findMany({ where: { leadId, status: 'SOLD' } });
  const totalSoldCents = soldRows.reduce((sum, r) => sum + (r.premiumCents || 0), 0);
  const soldLabels = soldRows.map((r) => PRODUCT_LABELS[r.product] || r.product).join(', ') || null;
  await prisma.lead.update({
    where: { id: leadId },
    data: { salePremiumCents: totalSoldCents || null, saleProduct: soldLabels },
  });
}

const productActionSchema = z.object({
  product: z.enum(PRODUCTS),
  status: z.enum(['QUOTED', 'SOLD']),
  premiumCents: z.number().int().positive().optional(),
});

// Per-product quote/sale tracking — independent of the lead's overall
// pipeline `status`. Diffing PRODUCTS against this lead's productQuotes is
// what tells an agent which products still need cross-selling.
router.post('/:leadId/products', async (req, res, next) => {
  try {
    const parsed = productActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const { lead, forbidden } = await loadLeadWithAccessCheck(req);
    if (!lead) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (forbidden) return res.status(403).json({ success: false, error: 'FORBIDDEN' });

    const { product, status, premiumCents } = parsed.data;

    // Enforced server-side too, not just the client's chip-row filter — a
    // direct API call must not be able to quote the product this lead's
    // own cross-sell category says is already held. Only enforced when
    // crossSellHaveProduct is actually populated (a plain/generic
    // CROSS_SELL lead with no reliable source data is never inferred).
    if (lead.crossSellHaveProduct && lead.crossSellHaveProduct === product) {
      return res.status(400).json({
        success: false, error: 'PRODUCT_ALREADY_HELD',
        message: `This lead already has ${PRODUCT_LABELS[product] || product} — it cannot be quoted here.`,
      });
    }

    const existing = await prisma.leadProductQuote.findUnique({
      where: { leadId_product: { leadId: lead.id, product } },
    });
    const wasSold = existing?.status === 'SOLD';
    const now = new Date();

    await prisma.leadProductQuote.upsert({
      where: { leadId_product: { leadId: lead.id, product } },
      create: {
        leadId: lead.id,
        product,
        status,
        premiumCents: premiumCents ?? null,
        soldAt: status === 'SOLD' ? now : null,
        createdById: req.user.id,
      },
      update: {
        status,
        premiumCents: premiumCents ?? existing?.premiumCents ?? null,
        soldAt: status === 'SOLD' && !wasSold ? now : existing?.soldAt,
      },
    });

    await prisma.leadEvent.create({
      data: {
        leadId: lead.id,
        type: status === 'SOLD' ? 'lead.product_sold' : 'lead.product_quoted',
        metadata: { product, premiumCents: premiumCents ?? null },
      },
    });

    // A product SOLD here is a queue/pipeline disposition, not a
    // production entry — no revenue is posted from this path. Real
    // production/revenue only ever comes from an explicit Add Closed
    // Sale entry (routes/sales.js). Cross-sell detection still runs on
    // the first time this product is marked SOLD — that's a product-
    // ownership signal, unrelated to revenue.
    if (status === 'SOLD' && !wasSold && lead.customerId) {
      await updateCustomerProductsAndDetectCrossSells({
        customerId: lead.customerId, agencyId: lead.agencyId, soldProduct: PRODUCT_LABELS[product],
      });
    }

    await syncLeadSaleFieldsFromProductQuotes(lead.id);

    // A real quote or sale is real pipeline progress — the lead's overall
    // status should never lag behind what actually happened on it.
    await autoAdvanceLeadStatus({ leadId: lead.id, targetStatus: status === 'SOLD' ? 'SOLD' : 'QUOTED', reason: `product_${status.toLowerCase()}:${product}` });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: lead.agencyId,
      action: 'lead.product_quote_saved', entityType: 'Lead', entityId: lead.id,
      after: { product, status, premiumCents: premiumCents ?? null }, correlationId: req.correlationId,
    });

    const productQuotes = await prisma.leadProductQuote.findMany({ where: { leadId: lead.id }, orderBy: { product: 'asc' } });
    return res.json({ success: true, productQuotes });
  } catch (err) {
    next(err);
  }
});

// Un-mark a product (back to "not quoted") — blocked once SOLD, since that
// would silently remove a row a RevenueEvent already references (by lead id
// + product, in its notes — there's no hard FK to clean up automatically).
router.delete('/:leadId/products/:product', async (req, res, next) => {
  try {
    if (!PRODUCTS.includes(req.params.product)) {
      return res.status(400).json({ success: false, error: 'INVALID_PRODUCT' });
    }
    const { lead, forbidden } = await loadLeadWithAccessCheck(req);
    if (!lead) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (forbidden) return res.status(403).json({ success: false, error: 'FORBIDDEN' });

    const existing = await prisma.leadProductQuote.findUnique({
      where: { leadId_product: { leadId: lead.id, product: req.params.product } },
    });
    if (existing) {
      if (existing.status === 'SOLD') {
        return res.status(409).json({ success: false, error: 'ALREADY_SOLD', message: 'A sold product cannot be un-marked here.' });
      }
      await prisma.leadProductQuote.delete({ where: { id: existing.id } });
    }

    const productQuotes = await prisma.leadProductQuote.findMany({ where: { leadId: lead.id }, orderBy: { product: 'asc' } });
    return res.json({ success: true, productQuotes });
  } catch (err) {
    next(err);
  }
});

const dispositionSchema = z.object({
  status: z.enum([
    'NEW', 'CONTACTED', 'LEFT_VM', 'APPOINTMENT',
    'QUOTED', 'QUOTED_HOT', 'FOLLOW_UP', 'SOLD', 'LOST', 'NOT_INTERESTED', 'BAD_CONTACT',
    'DUPLICATE', 'DO_NOT_CONTACT', 'INELIGIBLE', 'ARCHIVED',
  ]),
  note: z.string().optional(),
  saleProduct: z.string().optional(),
  salePremiumCents: z.number().int().positive().optional(),
  // Additive policy-detail fields — the "linked lead" path of the Add
  // Closed Sale form, optional and never required for an ordinary
  // disposition. See schema.prisma's Sale model comment for why a
  // Lead-linked sale stays on the Lead itself rather than a second row.
  policyNumber: z.string().optional(),
  saleIssuedDate: z.string().optional(),
  saleEffectiveDate: z.string().optional(),
  saleExpirationDate: z.string().optional(),
  saleCarrier: z.string().optional(),
  salePolicyTypeDetail: z.string().optional(),
  salePriorCarrier: z.string().optional(),
  saleReason: z.string().optional(),
  saleItems: z.number().int().nonnegative().optional(),
});

// Disposition a lead — records status HISTORY, never overwrites it.
// Role-restricted to the roles that actually work leads (no TELEMARKETER —
// they submit leads but never disposition them; see authorizeLeadAccess
// below for the further per-record ownership/agency check).
router.post('/:leadId/disposition', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PRODUCER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = dispositionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.leadId },
      include: { createdBy: { select: { role: true } } },
    });
    const access = authorizeLeadAccess(req, lead, { write: true });
    if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

    const fromStatus = lead.status;
    const now = new Date();
    const patch = { status: parsed.data.status };
    if (fromStatus === 'NEW') {
      if (!lead.firstAttemptAt && parsed.data.status === 'CONTACTED') {
        patch.firstAttemptAt = now;
      }
    }
    if (parsed.data.status === 'CONTACTED' && !lead.firstContactAt) {
      patch.firstContactAt = now;
    }
    if (parsed.data.status === 'SOLD') {
      patch.saleProduct = parsed.data.saleProduct || null;
      patch.salePremiumCents = parsed.data.salePremiumCents || null;
      patch.policyNumber = parsed.data.policyNumber || null;
      patch.saleIssuedDate = parsed.data.saleIssuedDate ? new Date(parsed.data.saleIssuedDate) : null;
      patch.saleEffectiveDate = parsed.data.saleEffectiveDate ? new Date(parsed.data.saleEffectiveDate) : null;
      patch.saleExpirationDate = parsed.data.saleExpirationDate ? new Date(parsed.data.saleExpirationDate) : null;
      patch.saleCarrier = parsed.data.saleCarrier || null;
      patch.salePolicyTypeDetail = parsed.data.salePolicyTypeDetail || null;
      patch.salePriorCarrier = parsed.data.salePriorCarrier || null;
      patch.saleReason = parsed.data.saleReason || null;
      patch.saleItems = parsed.data.saleItems ?? null;
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

    const agencyRow = await prisma.agency.findUnique({ where: { id: lead.agencyId }, select: { priorityRules: true } });
    const { priorityScore, priorityReason } = scoreLead(updated, agencyRow?.priorityRules);
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

    // A SOLD disposition is a queue/pipeline status change only — it never
    // posts revenue or production credit. The lead's sale-detail fields
    // above are preserved for history/audit (and to pre-fill the Add
    // Closed Sale nudge below), but the one real production entry is an
    // explicit Add Closed Sale (routes/sales.js), counted once there.

    // Phone-number-level suppression (TCPA) — a DO_NOT_CONTACT disposition
    // marks the underlying Customer, not just this one Lead row, so the
    // suppression follows this person across every future Lead from any
    // vendor/source (createLeadRecord/vendorApi.js both check this flag at
    // intake). Never cleared automatically — only a real admin action
    // should ever lift a suppression once recorded.
    if (parsed.data.status === 'DO_NOT_CONTACT' && updated.customerId) {
      await prisma.customer.update({
        where: { id: updated.customerId },
        data: {
          doNotContact: true,
          doNotContactAt: now,
          doNotContactReason: parsed.data.note || 'Marked DO_NOT_CONTACT via lead disposition',
        },
      });
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
module.exports.authorizeLeadAccess = authorizeLeadAccess;
