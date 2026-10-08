const express = require('express');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole, scopeAgencyId } = require('../middleware/auth');
const { normalizePhone } = require('../lib/normalize');
const { buildCustomerTimeline } = require('../lib/customerTimeline');
const { recordAudit } = require('../lib/audit');

const router = express.Router();
router.use(requireAuth);

// Shared by Customer 360 (GET /:id) and the data-subject export (GET
// /:id/export) — same real data, same tenant-scoping, just two different
// response shapes for two different purposes.
async function loadCustomerBundle(customer, agencyId) {
  const leadWhere = { customerId: customer.id, ...(agencyId ? { agencyId } : {}) };
  const transferWhere = { customerId: customer.id, ...(agencyId ? { agencyId } : {}) };
  const opportunityWhere = { customerId: customer.id, ...(agencyId ? { agencyId } : {}) };
  const saleWhere = { customerId: customer.id, ...(agencyId ? { agencyId } : {}) };

  const [leads, transfers, opportunities, sales] = await Promise.all([
    prisma.lead.findMany({
      where: leadWhere,
      include: { events: { orderBy: { createdAt: 'asc' } }, notes: { include: { author: { select: { firstName: true, lastName: true } } } }, assignedTo: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.transfer.findMany({
      where: transferWhere,
      include: { events: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.opportunity.findMany({
      where: opportunityWhere,
      include: { events: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    }),
    // Standalone sales (Add Closed Sale) — previously missing entirely
    // from Customer 360/the only other place this person's full real
    // record was assembled, same gap Factory Reset had.
    prisma.sale.findMany({ where: saleWhere, orderBy: { saleDate: 'desc' } }),
  ]);

  const leadIds = leads.map((l) => l.id);
  const calls = leadIds.length
    ? await prisma.call.findMany({
        where: { leadId: { in: leadIds } },
        include: { analysis: { select: { overallScore: true } } },
        orderBy: { createdAt: 'desc' },
      })
    : [];

  return { leads, transfers, opportunities, sales, calls };
}

// Customer has no direct agencyId — it's shared across whichever agencies a
// person has interacted with via a Lead or Transfer. This scopes search to
// customers who have at least one Lead or Transfer belonging to the caller's
// own agency, so an Agency Owner can never search up a customer that isn't
// actually theirs.
router.get('/search', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencyId = scopeAgencyId(req);
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, customers: [] });

    const phoneNormalized = normalizePhone(q);
    const nameOrPhoneMatch = {
      OR: [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        ...(phoneNormalized ? [{ phoneNormalized: { contains: phoneNormalized } }] : []),
      ],
    };

    const customers = await prisma.customer.findMany({
      where: {
        AND: [
          nameOrPhoneMatch,
          agencyId
            ? { OR: [{ leads: { some: { agencyId } } }, { transfers: { some: { agencyId } } }] }
            : {},
        ],
      },
      take: 10,
    });

    return res.json({ success: true, customers });
  } catch (err) {
    next(err);
  }
});

// Customer 360 — one unified record spanning every module, scoped so a
// caller can only see the slice of this customer's history that belongs
// to their own agency (a shared customer's history at a DIFFERENT agency
// is never leaked across the tenant boundary).
router.get('/:id', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PRODUCER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencyId = scopeAgencyId(req);
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!customer) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const { leads, transfers, opportunities, sales, calls } = await loadCustomerBundle(customer, agencyId);

    // The nested collections above are already agency-scoped, but the
    // top-level `customer` record was fetched by raw id with no tenant
    // check at all — a non-platform-owner caller who guesses/knows a
    // Customer UUID with zero real relationship to their own agency must
    // not get the customer's PII back. If every scoped collection came
    // back empty, this customer isn't actually theirs.
    if (agencyId && leads.length === 0 && transfers.length === 0 && opportunities.length === 0 && sales.length === 0) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    const timeline = buildCustomerTimeline({ leads, transfers, calls, opportunities });

    return res.json({
      success: true,
      customer,
      leads,
      transfers,
      calls,
      opportunities,
      sales,
      timeline,
    });
  } catch (err) {
    next(err);
  }
});

// Data-subject access request (CCPA-class "right to know"/export) — the
// same real bundle Customer 360 shows, packaged as one downloadable
// record rather than a UI view. Deliberately narrower than GET /:id's
// role list — this is a compliance action an admin performs on a
// consumer's behalf, not a day-to-day lookup a Producer needs.
router.get('/:id/export', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencyId = scopeAgencyId(req);
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!customer) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const { leads, transfers, opportunities, sales, calls } = await loadCustomerBundle(customer, agencyId);

    if (agencyId && leads.length === 0 && transfers.length === 0 && opportunities.length === 0 && sales.length === 0) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: agencyId || null,
      action: 'customer.exported', entityType: 'Customer', entityId: customer.id,
      correlationId: req.correlationId,
    });

    return res.json({
      success: true,
      exportedAt: new Date().toISOString(),
      customer,
      leads,
      transfers,
      opportunities,
      sales,
      calls,
      // Known, honest limitation — not silently ignored: HistoricalRecord
      // rows (bulk historical imports) are never linked to a Customer by
      // id (by design — they predate this app and were never leads), so
      // this export cannot reliably include or scrub them for a specific
      // person without an unreliable fuzzy name/phone match. Likewise, a
      // Call's transcript is free text and may reference this person by
      // name even after this export/anonymize action — transcript
      // redaction is a separate, not-yet-built control.
      limitations: [
        'HistoricalRecord rows from bulk historical imports are not linked to a Customer by id and are not included.',
        'Call transcripts are free text and may still reference this person by name even after anonymization.',
      ],
    });
  } catch (err) {
    next(err);
  }
});

// Data-subject erasure request (CCPA/CPRA-class "right to delete"). Never
// a hard delete of the Customer row — Lead/Transfer/Sale rows carry real
// financial/legal records (a completed sale, a paid-for transfer) this
// app must keep for its own accounting/audit needs, matching how Factory
// Reset "archives" rather than destroys the agency-level audit trail.
// Instead, every identifying field this app stores for this person is
// nulled/replaced, on the Customer row AND on the denormalized copies
// Transfer and Sale each keep independently (confirmed by reading the
// schema: unlike Lead, which only ever reads a customer's name through
// the relation, Transfer and Sale both store their own firstName/
// lastName/contact fields directly, so anonymizing Customer alone would
// leave real PII behind on those rows).
router.post('/:id/anonymize', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencyId = scopeAgencyId(req);
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!customer) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const leadWhere = { customerId: customer.id, ...(agencyId ? { agencyId } : {}) };
    const [ownLeadCount, ownTransferCount, ownOpportunityCount, ownSaleCount] = await Promise.all([
      prisma.lead.count({ where: leadWhere }),
      prisma.transfer.count({ where: { customerId: customer.id, ...(agencyId ? { agencyId } : {}) } }),
      prisma.opportunity.count({ where: { customerId: customer.id, ...(agencyId ? { agencyId } : {}) } }),
      prisma.sale.count({ where: { customerId: customer.id, ...(agencyId ? { agencyId } : {}) } }),
    ]);
    if (agencyId && ownLeadCount === 0 && ownTransferCount === 0 && ownOpportunityCount === 0 && ownSaleCount === 0) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.customer.update({
        where: { id: customer.id },
        data: {
          firstName: 'Deleted', lastName: 'Customer',
          phoneNormalized: null, email: null, address: null, city: null, state: null, zip: null,
          products: [],
        },
      });

      // Only this agency's own Transfer/Sale rows — a shared Customer
      // touched by another agency too keeps that agency's records intact;
      // this anonymizes what THIS caller's agency is responsible for
      // (Platform Owner with no agencyId anonymizes every row, matching
      // the same "no agencyId = everything" convention scopeAgencyId
      // already uses elsewhere).
      const transfers = await tx.transfer.updateMany({
        where: { customerId: customer.id, ...(agencyId ? { agencyId } : {}) },
        data: { firstName: 'Deleted', lastName: 'Customer', phone: null, email: null },
      });
      const sales = await tx.sale.updateMany({
        where: { customerId: customer.id, ...(agencyId ? { agencyId } : {}) },
        data: { firstName: 'Deleted', lastName: 'Customer', businessName: null, customerTitle: null, customerSuffix: null, zip: null, state: null },
      });

      return { transfers: transfers.count, sales: sales.count };
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: agencyId || null,
      action: 'customer.anonymized', entityType: 'Customer', entityId: customer.id,
      after: result, correlationId: req.correlationId,
    });

    return res.json({
      success: true,
      customerId: customer.id,
      anonymized: result,
      limitations: [
        'HistoricalRecord rows from bulk historical imports are not linked to a Customer by id and are not touched by this action.',
        'Call transcripts are free text and may still reference this person by name.',
      ],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
