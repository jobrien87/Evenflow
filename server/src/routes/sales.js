// Add Closed Sale — manual, standalone sale entry (no originating Lead in
// Evenflow). See schema.prisma's Sale model comment: a Lead-linked sale
// stays on the Lead's own disposition flow (POST /leads/:leadId/disposition),
// never a second row here. This route is the real new gap: a policy that
// was never a Lead at all.
const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole, scopeAgencyId } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { normalizePhone, normalizeEmail } = require('../lib/normalize');
const { recordManualSaleRevenue } = require('../lib/financialEvents');
const { updateCustomerProductsAndDetectCrossSells } = require('../lib/opportunityEvents');
const { PRODUCTS } = require('../lib/products');

const router = express.Router();
router.use(requireAuth);

const CREATE_ROLES = ['AGENCY_OWNER', 'AGENCY_MANAGER', 'PRODUCER', 'PLATFORM_OWNER'];

// Finds likely duplicates within the agency: an exact policyNumber match
// against other non-voided Sales, or the same carrier+policyType+saleDate
// combination (policy number alone must not block a legitimate renewal/
// rewrite, and name alone is never a reliable key — see the user's own
// spec). Also a loose cross-check against HistoricalRecord (same customer
// name + product within a few days of the sale date), the closest fields
// that model actually has.
async function findPossibleDuplicates({ agencyId, excludeSaleId, policyNumber, carrier, policyType, saleDate, firstName, lastName, zip }) {
  const saleWhere = {
    agencyId,
    voidedAt: null,
    ...(excludeSaleId ? { id: { not: excludeSaleId } } : {}),
    OR: [
      ...(policyNumber ? [{ policyNumber }] : []),
      { carrier, policyType, saleDate },
    ],
  };
  const saleMatches = await prisma.sale.findMany({
    where: saleWhere,
    select: { id: true, firstName: true, lastName: true, carrier: true, policyType: true, policyNumber: true, saleDate: true, premiumCents: true },
    take: 10,
  });

  const from = new Date(saleDate);
  from.setUTCDate(from.getUTCDate() - 3);
  const to = new Date(saleDate);
  to.setUTCDate(to.getUTCDate() + 3);
  const historicalMatches = await prisma.historicalRecord.findMany({
    where: {
      agencyId,
      firstName: { equals: firstName, mode: 'insensitive' },
      lastName: { equals: lastName, mode: 'insensitive' },
      recordDate: { gte: from, lte: to },
    },
    select: { id: true, firstName: true, lastName: true, product: true, recordDate: true, premiumCents: true, outcome: true },
    take: 10,
  });

  return {
    sales: saleMatches,
    historicalRecords: historicalMatches,
  };
}

router.post('/check-duplicate', requireRole(...CREATE_ROLES), async (req, res, next) => {
  try {
    const agencyId = scopeAgencyId(req);
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    const { policyNumber, carrier, policyType, saleDate, firstName, lastName, zip } = req.body || {};
    if (!carrier || !policyType || !saleDate || !firstName || !lastName) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'carrier, policyType, saleDate, firstName, lastName are required to check for duplicates.' });
    }
    const matches = await findPossibleDuplicates({ agencyId, policyNumber, carrier, policyType, saleDate: new Date(saleDate), firstName, lastName, zip });
    return res.json({ success: true, ...matches });
  } catch (err) {
    next(err);
  }
});

const createSaleSchema = z.object({
  clientRequestId: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  businessName: z.string().optional(),
  customerTitle: z.string().optional(),
  customerSuffix: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  zip: z.string().optional(),
  state: z.string().optional(),
  saleDate: z.string().min(1),
  issuedDate: z.string().optional(),
  effectiveDate: z.string().optional(),
  expirationDate: z.string().optional(),
  carrier: z.string().min(1),
  policyType: z.string().min(1),
  productFamily: z.enum(PRODUCTS),
  policyNumber: z.string().optional(),
  // Never negative in this round — a real adjustment/correction needs its
  // own explicitly-authorized path (see schema.prisma's Sale comment and
  // the user's own spec), not a bare negative number on a normal sale.
  premiumCents: z.number().int().nonnegative().optional(),
  revenueCents: z.number().int().nonnegative().optional(),
  items: z.number().int().nonnegative().optional(),
  leadSource: z.string().optional(),
  priorCarrier: z.string().optional(),
  reason: z.string().optional(),
  notes: z.string().max(1000).optional(),
  officeId: z.string().uuid().optional(),
  assignedToId: z.string().uuid().optional(),
  confirmDuplicate: z.boolean().optional(),
});

router.post('/', requireRole(...CREATE_ROLES), async (req, res, next) => {
  try {
    const agencyId = scopeAgencyId(req);
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const parsed = createSaleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const data = parsed.data;

    // Idempotency: a retried/double-submitted request with the same
    // client-generated id returns the existing row instead of creating a
    // second one.
    const existing = await prisma.sale.findUnique({ where: { clientRequestId: data.clientRequestId } });
    if (existing) {
      return res.json({ success: true, sale: existing, idempotentReplay: true });
    }

    // A Producer can only ever credit themselves; Owner/Manager/Platform
    // Owner may credit any real producer in the agency — never trust a
    // client-supplied assignedToId blindly either way.
    let assignedToId = data.assignedToId;
    if (req.user.role === 'PRODUCER') {
      assignedToId = req.user.id;
    } else if (!assignedToId) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'assignedToId is required.' });
    }
    const assignee = await prisma.user.findUnique({ where: { id: assignedToId } });
    if (!assignee || assignee.agencyId !== agencyId) {
      return res.status(400).json({ success: false, error: 'INVALID_PRODUCER', message: 'assignedToId must be a real user in this agency.' });
    }

    if (data.officeId) {
      const office = await prisma.office.findUnique({ where: { id: data.officeId } });
      if (!office || office.agencyId !== agencyId) {
        return res.status(400).json({ success: false, error: 'INVALID_OFFICE', message: 'officeId must be a real office in this agency.' });
      }
    }

    const saleDate = new Date(data.saleDate);
    if (Number.isNaN(saleDate.getTime())) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'saleDate is not a valid date.' });
    }

    // Re-run the duplicate check server-side regardless of what the client
    // already showed the user — never trust a client-side-only check for
    // something this consequential. A match requires explicit confirmation.
    const duplicates = await findPossibleDuplicates({
      agencyId, policyNumber: data.policyNumber, carrier: data.carrier, policyType: data.policyType,
      saleDate, firstName: data.firstName, lastName: data.lastName, zip: data.zip,
    });
    const hasDuplicates = duplicates.sales.length > 0 || duplicates.historicalRecords.length > 0;
    if (hasDuplicates && !data.confirmDuplicate) {
      return res.status(409).json({ success: false, error: 'POSSIBLE_DUPLICATE', message: 'A similar sale already exists. Review and confirm to proceed.', ...duplicates });
    }

    // Customer get-or-create — same phone/email dedup createLeadRecord
    // already uses in leads.js, so a standalone sale and a Lead-sourced
    // customer converge on the same real Customer row when they match.
    const phoneNormalized = normalizePhone(data.phone);
    const email = normalizeEmail(data.email);
    let customer = null;
    if (phoneNormalized || email) {
      customer = await prisma.customer.findFirst({
        where: { OR: [phoneNormalized ? { phoneNormalized } : undefined, email ? { email } : undefined].filter(Boolean) },
      });
    }
    if (!customer) {
      customer = await prisma.customer.create({
        data: { firstName: data.firstName, lastName: data.lastName, phoneNormalized, email, zip: data.zip, state: data.state },
      });
    }

    const sale = await prisma.sale.create({
      data: {
        agencyId,
        customerId: customer.id,
        firstName: data.firstName,
        lastName: data.lastName,
        businessName: data.businessName || null,
        customerTitle: data.customerTitle || null,
        customerSuffix: data.customerSuffix || null,
        zip: data.zip || null,
        state: data.state || null,
        saleDate,
        issuedDate: data.issuedDate ? new Date(data.issuedDate) : null,
        effectiveDate: data.effectiveDate ? new Date(data.effectiveDate) : null,
        expirationDate: data.expirationDate ? new Date(data.expirationDate) : null,
        carrier: data.carrier,
        policyType: data.policyType,
        productFamily: data.productFamily,
        policyNumber: data.policyNumber || null,
        premiumCents: data.premiumCents !== undefined ? data.premiumCents : null,
        revenueCents: data.revenueCents !== undefined ? data.revenueCents : null,
        items: data.items !== undefined ? data.items : 1,
        leadSource: data.leadSource || null,
        priorCarrier: data.priorCarrier || null,
        reason: data.reason || null,
        notes: data.notes || null,
        officeId: data.officeId || null,
        assignedToId,
        createdById: req.user.id,
        clientRequestId: data.clientRequestId,
      },
    });

    // Real, entered premium feeds the Financial Ledger — same convention
    // as a Lead's own disposition-to-SOLD path.
    if (sale.premiumCents) {
      await recordManualSaleRevenue(sale);
    }
    // Real sold product updates the customer's product ledger and detects
    // genuine cross-sell gaps — same hook the Lead/Transfer paths already use.
    await updateCustomerProductsAndDetectCrossSells({
      customerId: customer.id,
      agencyId,
      soldProduct: sale.productFamily,
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId,
      action: 'sale.created', entityType: 'Sale', entityId: sale.id,
      after: { carrier: sale.carrier, policyType: sale.policyType, premiumCents: sale.premiumCents, assignedToId },
      correlationId: req.correlationId,
    });

    return res.status(201).json({ success: true, sale });
  } catch (err) {
    next(err);
  }
});

router.get('/', requireRole(...CREATE_ROLES), async (req, res, next) => {
  try {
    const agencyId = scopeAgencyId(req);
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    const where = {
      agencyId,
      ...(req.user.role === 'PRODUCER' ? { assignedToId: req.user.id } : {}),
      ...(req.query.assignedToId ? { assignedToId: req.query.assignedToId } : {}),
      ...(req.query.officeId ? { officeId: req.query.officeId } : {}),
      ...(req.query.productFamily ? { productFamily: req.query.productFamily } : {}),
      ...(req.query.includeVoided === 'true' ? {} : { voidedAt: null }),
      ...(req.query.from || req.query.to
        ? { saleDate: { ...(req.query.from ? { gte: new Date(req.query.from) } : {}), ...(req.query.to ? { lte: new Date(req.query.to) } : {}) } }
        : {}),
    };
    const sales = await prisma.sale.findMany({
      where,
      include: { assignedTo: { select: { id: true, firstName: true, lastName: true } }, office: { select: { id: true, name: true } } },
      orderBy: { saleDate: 'desc' },
    });
    return res.json({ success: true, sales });
  } catch (err) {
    next(err);
  }
});

const updateSaleSchema = createSaleSchema.omit({ clientRequestId: true, confirmDuplicate: true }).partial();

router.patch('/:saleId', requireRole(...CREATE_ROLES), async (req, res, next) => {
  try {
    const sale = await prisma.sale.findUnique({ where: { id: req.params.saleId } });
    if (!sale) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    const agencyId = scopeAgencyId(req);
    if (req.user.role !== 'PLATFORM_OWNER' && sale.agencyId !== agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    // A Producer may only correct their own sale; Owner/Manager/Platform
    // Owner may correct any sale in the agency.
    if (req.user.role === 'PRODUCER' && sale.assignedToId !== req.user.id) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'You can only edit your own sales.' });
    }
    const parsed = updateSaleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const data = parsed.data;
    const patch = {};
    for (const key of ['firstName', 'lastName', 'businessName', 'customerTitle', 'customerSuffix', 'zip', 'state', 'carrier', 'policyType', 'productFamily', 'policyNumber', 'premiumCents', 'revenueCents', 'items', 'leadSource', 'priorCarrier', 'reason', 'notes', 'officeId']) {
      if (data[key] !== undefined) patch[key] = data[key];
    }
    for (const key of ['saleDate', 'issuedDate', 'effectiveDate', 'expirationDate']) {
      if (data[key] !== undefined) patch[key] = new Date(data[key]);
    }
    if (data.assignedToId !== undefined && req.user.role !== 'PRODUCER') {
      const assignee = await prisma.user.findUnique({ where: { id: data.assignedToId } });
      if (!assignee || assignee.agencyId !== sale.agencyId) {
        return res.status(400).json({ success: false, error: 'INVALID_PRODUCER' });
      }
      patch.assignedToId = data.assignedToId;
    }

    const updated = await prisma.sale.update({ where: { id: sale.id }, data: patch });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: sale.agencyId,
      action: 'sale.corrected', entityType: 'Sale', entityId: sale.id,
      before: sale, after: updated, correlationId: req.correlationId,
    });

    return res.json({ success: true, sale: updated });
  } catch (err) {
    next(err);
  }
});

const voidSchema = z.object({ voidReason: z.string().min(1) });

router.post('/:saleId/void', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const sale = await prisma.sale.findUnique({ where: { id: req.params.saleId } });
    if (!sale) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    const agencyId = scopeAgencyId(req);
    if (req.user.role !== 'PLATFORM_OWNER' && sale.agencyId !== agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (sale.voidedAt) {
      return res.status(409).json({ success: false, error: 'ALREADY_VOIDED' });
    }
    const parsed = voidSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const updated = await prisma.sale.update({
      where: { id: sale.id },
      data: { voidedAt: new Date(), voidedById: req.user.id, voidReason: parsed.data.voidReason },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: sale.agencyId,
      action: 'sale.voided', entityType: 'Sale', entityId: sale.id,
      before: { voidedAt: null }, after: { voidedAt: updated.voidedAt, voidReason: updated.voidReason },
      correlationId: req.correlationId,
    });

    return res.json({ success: true, sale: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
