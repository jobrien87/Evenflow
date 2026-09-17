const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { findEligibleAgency } = require('../lib/transferRouting');
const { canTransition } = require('../lib/transferStateMachine');
const { requireModuleEnabled } = require('../lib/entitlements');
const { recordTransferAcceptedRevenue, recordCreditApproved, recordTransferSaleRevenue } = require('../lib/financialEvents');
const { notifyAgencyOwners, notifyUser } = require('../lib/notifications');
const { normalizePhone, normalizeEmail } = require('../lib/normalize');
const { updateCustomerProductsAndDetectCrossSells } = require('../lib/opportunityEvents');
const { computeTelemarketerScore, computeAgencyScore } = require('../lib/flowScore');

const router = express.Router();
router.use(requireAuth);

async function logEvent(tx, transferId, fromStatus, toStatus, actorId, reason, metadata) {
  return tx.transferEvent.create({
    data: { transferId, fromStatus, toStatus, actorId, reason, metadata },
  });
}

async function getExcludedAgencyIds(transferId) {
  const events = await prisma.transferEvent.findMany({
    where: { transferId, toStatus: { in: ['REJECTED', 'MISSED', 'EXPIRED'] } },
  });
  return events.map((e) => e.metadata && e.metadata.agencyId).filter(Boolean);
}

async function routeTransfer(transferId) {
  const transfer = await prisma.transfer.findUnique({ where: { id: transferId } });
  if (!transfer) return;
  const excluded = await getExcludedAgencyIds(transferId);

  const routing = await findEligibleAgency({
    telemarketerId: transfer.createdByTMId,
    product: transfer.product,
    state: transfer.state,
  });

  const eligibleAgencyId =
    routing.agencyId && !excluded.includes(routing.agencyId) ? routing.agencyId : null;

  return prisma.$transaction(async (tx) => {
    if (!eligibleAgencyId) {
      const updated = await tx.transfer.update({
        where: { id: transferId },
        data: { status: 'NO_ELIGIBLE_DESTINATION', routingReason: routing.reason },
      });
      await logEvent(tx, transferId, transfer.status, 'NO_ELIGIBLE_DESTINATION', null, routing.reason);
      return updated;
    }
    const updated = await tx.transfer.update({
      where: { id: transferId },
      data: {
        agencyId: eligibleAgencyId,
        status: 'OFFERED',
        routingReason: routing.reason,
        offeredAt: new Date(),
      },
    });
    await logEvent(tx, transferId, transfer.status, 'OFFERED', null, routing.reason, { agencyId: eligibleAgencyId });
    return updated;
  }).then(async (updated) => {
    // Transfer alerts are CRITICAL severity per spec — they must not
    // disappear into a generic notification list. Fired after the
    // transaction commits so a notification failure can never roll back
    // a successfully routed transfer.
    if (updated.status === 'OFFERED') {
      await notifyAgencyOwners(updated.agencyId, {
        type: 'transfer.offered',
        severity: 'CRITICAL',
        title: `New transfer: ${updated.firstName} ${updated.lastName}`,
        body: `${updated.product} — ${updated.state}`,
        relatedEntityType: 'Transfer',
        relatedEntityId: updated.id,
      }).catch((err) => console.error('[notifications] transfer.offered failed', err.message));
    }
    return updated;
  });
}

router.get('/', async (req, res, next) => {
  try {
    let where = {};
    if (req.user.role === 'TELEMARKETER') {
      where = { createdByTMId: req.user.id };
    } else if (req.user.role !== 'PLATFORM_OWNER') {
      if (!req.user.agencyId) return res.json({ success: true, transfers: [] });
      where = { agencyId: req.user.agencyId };
    } else if (req.query.agencyId) {
      where = { agencyId: req.query.agencyId };
    }
    if (req.query.status) where.status = req.query.status;

    const transfers = await prisma.transfer.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { createdByTM: { select: { firstName: true, lastName: true } } },
    });
    return res.json({ success: true, transfers });
  } catch (err) {
    next(err);
  }
});

// Registered BEFORE '/:id' — otherwise Express would match "credit-requests"
// as a transfer ID and this route would be unreachable (caught during audit).
router.get('/credit-requests', requireRole('AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const where = req.user.role === 'PLATFORM_OWNER'
      ? (req.query.status ? { status: req.query.status } : {})
      : { transfer: { agencyId: req.user.agencyId }, ...(req.query.status ? { status: req.query.status } : {}) };
    const creditRequests = await prisma.creditRequest.findMany({
      where,
      include: { transfer: { select: { id: true, firstName: true, lastName: true, product: true, agencyId: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, creditRequests });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const transfer = await prisma.transfer.findUnique({
      where: { id: req.params.id },
      include: { events: { orderBy: { createdAt: 'desc' } }, creditRequests: true },
    });
    if (!transfer) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    const allowed =
      req.user.role === 'PLATFORM_OWNER' ||
      (req.user.role === 'TELEMARKETER' && transfer.createdByTMId === req.user.id) ||
      (transfer.agencyId && transfer.agencyId === req.user.agencyId);
    if (!allowed) return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    return res.json({ success: true, transfer });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  product: z.string().min(1),
  state: z.string().length(2),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  currentInsurance: z.string().optional(),
  notes: z.string().optional(),
  qualification: z.record(z.any()).optional(),
});

router.post('/', requireRole('TELEMARKETER'), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }

    const transfer = await prisma.$transaction(async (tx) => {
      // Link or create the real Customer record — same phone/email dedup
      // pattern used for CRM leads — so this transfer's eventual SOLD
      // outcome can feed the real product ledger and cross-sell detection,
      // and so this customer has one unified record across both intake paths.
      const phoneNormalized = normalizePhone(parsed.data.phone);
      const email = normalizeEmail(parsed.data.email);
      let customer = null;
      if (phoneNormalized || email) {
        customer = await tx.customer.findFirst({
          where: { OR: [phoneNormalized ? { phoneNormalized } : undefined, email ? { email } : undefined].filter(Boolean) },
        });
      }
      if (!customer) {
        customer = await tx.customer.create({
          data: { firstName: parsed.data.firstName, lastName: parsed.data.lastName, phoneNormalized, email, state: parsed.data.state.toUpperCase() },
        });
      }

      const t = await tx.transfer.create({
        data: {
          createdByTMId: req.user.id,
          customerId: customer.id,
          product: parsed.data.product,
          state: parsed.data.state.toUpperCase(),
          firstName: parsed.data.firstName,
          lastName: parsed.data.lastName,
          phone: parsed.data.phone,
          email: parsed.data.email || null,
          currentInsurance: parsed.data.currentInsurance,
          notes: parsed.data.notes,
          qualification: parsed.data.qualification || {},
          status: 'QUALIFIED',
        },
      });
      await logEvent(tx, t.id, 'LEAD_CAPTURED', 'QUALIFIED', req.user.id, 'Submitted by telemarketer');
      return t;
    });

    await prisma.transfer.update({ where: { id: transfer.id }, data: { status: 'ROUTING' } });
    await logEvent(prisma, transfer.id, 'QUALIFIED', 'ROUTING', req.user.id, 'Automatic routing initiated');
    const routed = await routeTransfer(transfer.id);

    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      agencyId: routed.agencyId,
      action: 'transfer.created',
      entityType: 'Transfer',
      entityId: transfer.id,
      after: { product: parsed.data.product, state: parsed.data.state },
      correlationId: req.correlationId,
    });

    return res.status(201).json({ success: true, transfer: routed });
  } catch (err) {
    next(err);
  }
});

function assertAgencyMatch(req, transfer) {
  if (req.user.role === 'PLATFORM_OWNER') return true;
  return transfer.agencyId && transfer.agencyId === req.user.agencyId;
}

router.post('/:id/accept', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PRODUCER', 'PLATFORM_OWNER'), requireModuleEnabled('transfersEnabled'), async (req, res, next) => {
  try {
    const transfer = await prisma.transfer.findUnique({ where: { id: req.params.id } });
    if (!transfer) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (!assertAgencyMatch(req, transfer)) return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    if (!canTransition(transfer.status, 'ACCEPTED')) {
      return res.status(409).json({ success: false, error: 'INVALID_TRANSITION', from: transfer.status });
    }

    const result = await prisma.transfer.updateMany({
      where: { id: transfer.id, status: 'OFFERED' },
      data: { status: 'ACCEPTED', acceptedById: req.user.id, respondedAt: new Date() },
    });

    if (result.count === 0) {
      return res.status(409).json({ success: false, error: 'TRANSFER_NO_LONGER_AVAILABLE' });
    }

    await logEvent(prisma, transfer.id, 'OFFERED', 'ACCEPTED', req.user.id, null, { agencyId: transfer.agencyId });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: transfer.agencyId,
      action: 'transfer.accepted', entityType: 'Transfer', entityId: transfer.id, correlationId: req.correlationId,
    });

    const updated = await prisma.transfer.findUnique({ where: { id: transfer.id } });

    // Record the real transfer-fee revenue event, if the agency has one configured.
    if (updated.agencyId) {
      const agency = await prisma.agency.findUnique({ where: { id: updated.agencyId } });
      await recordTransferAcceptedRevenue(updated, agency);
    }

    await notifyUser({
      userId: updated.createdByTMId,
      type: 'transfer.accepted',
      severity: 'INFO',
      title: 'Your transfer was accepted',
      body: `${updated.firstName} ${updated.lastName} — ${updated.product}`,
      relatedEntityType: 'Transfer',
      relatedEntityId: updated.id,
    });

    return res.json({ success: true, transfer: updated });
  } catch (err) {
    next(err);
  }
});

const rejectSchema = z.object({ reason: z.string().min(1) });

router.post('/:id/reject', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), requireModuleEnabled('transfersEnabled'), async (req, res, next) => {
  try {
    const parsed = rejectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION' });
    const transfer = await prisma.transfer.findUnique({ where: { id: req.params.id } });
    if (!transfer) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (!assertAgencyMatch(req, transfer)) return res.status(403).json({ success: false, error: 'FORBIDDEN' });

    const result = await prisma.transfer.updateMany({
      where: { id: transfer.id, status: 'OFFERED' },
      data: { status: 'REJECTED', rejectReason: parsed.data.reason, respondedAt: new Date() },
    });
    if (result.count === 0) {
      return res.status(409).json({ success: false, error: 'TRANSFER_NO_LONGER_AVAILABLE' });
    }
    await logEvent(prisma, transfer.id, 'OFFERED', 'REJECTED', req.user.id, parsed.data.reason, { agencyId: transfer.agencyId });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: transfer.agencyId,
      action: 'transfer.rejected', entityType: 'Transfer', entityId: transfer.id, metadata: { reason: parsed.data.reason }, correlationId: req.correlationId,
    });

    await prisma.transfer.update({ where: { id: transfer.id }, data: { status: 'ROUTING' } });
    await logEvent(prisma, transfer.id, 'REJECTED', 'ROUTING', null, 'Overflow after rejection');
    const routed = await routeTransfer(transfer.id);

    return res.json({ success: true, transfer: routed });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/connect', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PRODUCER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const transfer = await prisma.transfer.findUnique({ where: { id: req.params.id } });
    if (!transfer) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (!assertAgencyMatch(req, transfer)) return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    if (!canTransition(transfer.status, 'CONNECTED')) {
      return res.status(409).json({ success: false, error: 'INVALID_TRANSITION', from: transfer.status });
    }
    const updated = await prisma.transfer.update({
      where: { id: transfer.id },
      data: { status: 'CONNECTED', connectedAt: new Date() },
    });
    await logEvent(prisma, transfer.id, 'ACCEPTED', 'CONNECTED', req.user.id);
    return res.json({ success: true, transfer: updated });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/complete', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PRODUCER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const transfer = await prisma.transfer.findUnique({ where: { id: req.params.id } });
    if (!transfer) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (!assertAgencyMatch(req, transfer)) return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    if (!canTransition(transfer.status, 'COMPLETED')) {
      return res.status(409).json({ success: false, error: 'INVALID_TRANSITION', from: transfer.status });
    }
    const updated = await prisma.transfer.update({
      where: { id: transfer.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    await logEvent(prisma, transfer.id, 'CONNECTED', 'COMPLETED', req.user.id);
    return res.json({ success: true, transfer: updated });
  } catch (err) {
    next(err);
  }
});

const dispositionSchema = z.object({
  disposition: z.enum(['CONTACTED', 'QUOTE_STARTED', 'QUOTED', 'SOLD', 'FOLLOW_UP', 'NOT_INTERESTED', 'DUPLICATE', 'BAD_CONTACT', 'NOT_ELIGIBLE', 'DISCONNECTED', 'OTHER']),
  saleProduct: z.string().optional(),
  salePremiumCents: z.number().int().optional(),
  notes: z.string().optional(),
});

router.post('/:id/disposition', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PRODUCER', 'PLATFORM_OWNER'), requireModuleEnabled('transfersEnabled'), async (req, res, next) => {
  try {
    const parsed = dispositionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    const transfer = await prisma.transfer.findUnique({ where: { id: req.params.id } });
    if (!transfer) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (!assertAgencyMatch(req, transfer)) return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    if (!canTransition(transfer.status, 'DISPOSITIONED')) {
      return res.status(409).json({ success: false, error: 'INVALID_TRANSITION', from: transfer.status });
    }
    const updated = await prisma.transfer.update({
      where: { id: transfer.id },
      data: {
        status: 'DISPOSITIONED',
        disposition: parsed.data.disposition,
        dispositionAt: new Date(),
        saleProduct: parsed.data.disposition === 'SOLD' ? parsed.data.saleProduct : null,
        salePremiumCents: parsed.data.disposition === 'SOLD' ? parsed.data.salePremiumCents : null,
      },
    });
    await logEvent(prisma, transfer.id, 'COMPLETED', 'DISPOSITIONED', req.user.id, parsed.data.notes, { disposition: parsed.data.disposition });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: transfer.agencyId,
      action: 'transfer.dispositioned', entityType: 'Transfer', entityId: transfer.id,
      after: { disposition: parsed.data.disposition }, correlationId: req.correlationId,
    });

    // The sale premium the producer just entered is real data — feed it into
    // the Financial Ledger as revenue, separate from any flat acceptance fee.
    if (parsed.data.disposition === 'SOLD' && parsed.data.salePremiumCents) {
      await recordTransferSaleRevenue(updated);
    }

    if (parsed.data.disposition === 'SOLD' && updated.customerId && parsed.data.saleProduct) {
      await updateCustomerProductsAndDetectCrossSells({
        customerId: updated.customerId,
        agencyId: updated.agencyId,
        soldProduct: parsed.data.saleProduct,
      });
    }

    // A disposition is a real downstream-quality signal for the telemarketer
    // who sourced this transfer, and for the receiving agency — recompute
    // now rather than on every dashboard view.
    Promise.all([
      computeTelemarketerScore(updated.createdByTMId),
      updated.agencyId ? computeAgencyScore(updated.agencyId) : Promise.resolve(),
    ]).catch((err) => console.error('[flowScore] recompute after transfer disposition failed', err.message));

    return res.json({ success: true, transfer: updated });
  } catch (err) {
    next(err);
  }
});

const creditRequestSchema = z.object({ reason: z.string().min(1), notes: z.string().optional() });

router.post('/:id/credit-request', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER'), async (req, res, next) => {
  try {
    const parsed = creditRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION' });
    const transfer = await prisma.transfer.findUnique({ where: { id: req.params.id } });
    if (!transfer) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (!assertAgencyMatch(req, transfer)) return res.status(403).json({ success: false, error: 'FORBIDDEN' });

    const credit = await prisma.$transaction(async (tx) => {
      const c = await tx.creditRequest.create({
        data: { transferId: transfer.id, requestedById: req.user.id, reason: parsed.data.reason, notes: parsed.data.notes },
      });
      await tx.transfer.update({ where: { id: transfer.id }, data: { status: 'CREDIT_REQUESTED' } });
      return c;
    });
    await logEvent(prisma, transfer.id, transfer.status, 'CREDIT_REQUESTED', req.user.id, parsed.data.reason);
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: transfer.agencyId,
      action: 'transfer.credit_requested', entityType: 'CreditRequest', entityId: credit.id,
      after: { reason: parsed.data.reason }, correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, creditRequest: credit });
  } catch (err) {
    next(err);
  }
});

const creditDecisionSchema = z.object({ decision: z.enum(['APPROVED', 'DENIED']), notes: z.string().optional() });

router.post('/credit-requests/:creditId/decide', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = creditDecisionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION' });
    const credit = await prisma.creditRequest.findUnique({ where: { id: req.params.creditId }, include: { transfer: true } });
    if (!credit) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const newStatus = parsed.data.decision === 'APPROVED' ? 'CREDIT_APPROVED' : 'CREDIT_DENIED';
    await prisma.$transaction([
      prisma.creditRequest.update({
        where: { id: credit.id },
        data: { status: parsed.data.decision, decidedById: req.user.id, decidedAt: new Date(), decisionNotes: parsed.data.notes },
      }),
      prisma.transfer.update({ where: { id: credit.transferId }, data: { status: newStatus } }),
    ]);
    await logEvent(prisma, credit.transferId, 'CREDIT_REQUESTED', newStatus, req.user.id, parsed.data.notes);
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: credit.transfer.agencyId,
      action: `transfer.credit_${parsed.data.decision.toLowerCase()}`, entityType: 'CreditRequest', entityId: credit.id, correlationId: req.correlationId,
    });

    if (parsed.data.decision === 'APPROVED' && credit.transfer.agencyId) {
      const agency = await prisma.agency.findUnique({ where: { id: credit.transfer.agencyId } });
      await recordCreditApproved(credit.transfer, credit, agency);
    }

    await notifyUser({
      userId: credit.requestedById,
      agencyId: credit.transfer.agencyId,
      type: 'transfer.credit_decided',
      severity: 'ACTION',
      title: `Credit request ${parsed.data.decision.toLowerCase()}`,
      body: `Transfer for ${credit.transfer.firstName} ${credit.transfer.lastName}`,
      relatedEntityType: 'CreditRequest',
      relatedEntityId: credit.id,
    });

    return res.json({ success: true, status: newStatus });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
