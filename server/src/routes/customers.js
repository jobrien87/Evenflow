const express = require('express');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole, scopeAgencyId } = require('../middleware/auth');
const { normalizePhone } = require('../lib/normalize');
const { buildCustomerTimeline } = require('../lib/customerTimeline');

const router = express.Router();
router.use(requireAuth);

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

    const leadWhere = { customerId: customer.id, ...(agencyId ? { agencyId } : {}) };
    const transferWhere = { customerId: customer.id, ...(agencyId ? { agencyId } : {}) };

    const [leads, transfers, opportunities] = await Promise.all([
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
        where: { customerId: customer.id, ...(agencyId ? { agencyId } : {}) },
        include: { events: { orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // Calls are linked via leadId, not directly to Customer — gather them
    // through the customer's own real leads rather than a fabricated join.
    const leadIds = leads.map((l) => l.id);
    const calls = leadIds.length
      ? await prisma.call.findMany({
          where: { leadId: { in: leadIds } },
          include: { analysis: { select: { overallScore: true } } },
          orderBy: { createdAt: 'desc' },
        })
      : [];

    const timeline = buildCustomerTimeline({ leads, transfers, calls, opportunities });

    return res.json({
      success: true,
      customer,
      leads,
      transfers,
      calls,
      opportunities,
      timeline,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
