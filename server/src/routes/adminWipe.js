// Temporary, narrowly-scoped one-off data-wipe trigger — NOT part of the
// app's real feature set. Exists only because this deployment's operator
// has no direct database/shell access to their Render environment, so a
// one-time "wipe this one agency's leads/customers so its owner can start
// fresh" action needs an HTTPS-reachable trigger instead of a CLI run.
// Gated by a shared secret (ADMIN_WIPE_SECRET), not a user session.
//
// Scope, deliberately narrow: only Lead/Customer/Opportunity/Transfer/
// Call data (and their child rows) for ONE agency, resolved by looking up
// a real user's email — never the Agency row, never any User row, never
// Vendor/Office/TelemarketerAssignment/Goal/Notification/FlowScoreSnapshot/
// chat history. A hard, irreversible delete (confirmed with the operator),
// unlike every other destructive action in this app (which archives).
//
// Intended to be removed (this file + its app.js mount + the env var)
// once the one-off wipe it exists for has been confirmed successful.

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { prisma } = require('../lib/db');

const router = express.Router();

const wipeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' },
});

function secretMatches(provided, configured) {
  if (!configured || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(configured));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function checkSecret(req, res) {
  const configured = process.env.ADMIN_WIPE_SECRET;
  if (!configured) {
    res.status(503).json({ success: false, error: 'NOT_CONFIGURED', message: 'ADMIN_WIPE_SECRET is not set on this environment.' });
    return false;
  }
  const provided = req.headers['x-admin-secret'];
  if (!secretMatches(provided, configured)) {
    res.status(403).json({ success: false, error: 'FORBIDDEN' });
    return false;
  }
  return true;
}

async function resolveTargetAgency(email) {
  if (!email || typeof email !== 'string') return { error: 'EMAIL_REQUIRED' };
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user) return { error: 'USER_NOT_FOUND' };
  if (!user.agencyId) return { error: 'USER_HAS_NO_AGENCY' };
  return { user, agencyId: user.agencyId };
}

// Real row counts for every table this would touch — no mutation. Call
// this first and eyeball the numbers before ever calling the delete route
// below; there is no undo once that one runs.
router.get('/wipe-agency-preview', wipeLimiter, async (req, res, next) => {
  try {
    if (!checkSecret(req, res)) return;
    const resolved = await resolveTargetAgency(req.query.email);
    if (resolved.error) return res.status(400).json({ success: false, error: resolved.error });
    const { agencyId, user } = resolved;

    const leadIds = (await prisma.lead.findMany({ where: { agencyId }, select: { id: true } })).map((l) => l.id);
    const transferIds = (await prisma.transfer.findMany({ where: { agencyId }, select: { id: true } })).map((t) => t.id);
    const opportunityIds = (await prisma.opportunity.findMany({ where: { agencyId }, select: { id: true } })).map((o) => o.id);
    const callIds = (await prisma.call.findMany({ where: { agencyId }, select: { id: true } })).map((c) => c.id);
    const customerIds = new Set(
      (
        await prisma.lead.findMany({ where: { agencyId, customerId: { not: null } }, select: { customerId: true } })
      ).map((l) => l.customerId)
    );
    (await prisma.transfer.findMany({ where: { agencyId, customerId: { not: null } }, select: { customerId: true } })).forEach((t) => customerIds.add(t.customerId));
    (await prisma.opportunity.findMany({ where: { agencyId }, select: { customerId: true } })).forEach((o) => customerIds.add(o.customerId));

    let wipeableCustomerCount = 0;
    for (const customerId of customerIds) {
      const [otherLead, otherTransfer, otherOpportunity] = await Promise.all([
        prisma.lead.count({ where: { customerId, agencyId: { not: agencyId } } }),
        prisma.transfer.count({ where: { customerId, agencyId: { not: agencyId } } }),
        prisma.opportunity.count({ where: { customerId, agencyId: { not: agencyId } } }),
      ]);
      if (otherLead === 0 && otherTransfer === 0 && otherOpportunity === 0) wipeableCustomerCount += 1;
    }

    const [leadEvents, leadNotes, leadActivities, leadProductQuotes, leadTasks, opportunityEvents, creditRequests, transferEvents, revenueEvents, costEvents, callAnalyses, importBatches] = await Promise.all([
      prisma.leadEvent.count({ where: { leadId: { in: leadIds } } }),
      prisma.leadNote.count({ where: { leadId: { in: leadIds } } }),
      prisma.leadActivity.count({ where: { leadId: { in: leadIds } } }),
      prisma.leadProductQuote.count({ where: { leadId: { in: leadIds } } }),
      prisma.task.count({ where: { leadId: { in: leadIds } } }),
      prisma.opportunityEvent.count({ where: { opportunityId: { in: opportunityIds } } }),
      prisma.creditRequest.count({ where: { transferId: { in: transferIds } } }),
      prisma.transferEvent.count({ where: { transferId: { in: transferIds } } }),
      prisma.revenueEvent.count({ where: { transferId: { in: transferIds } } }),
      prisma.costEvent.count({ where: { transferId: { in: transferIds } } }),
      prisma.callAnalysis.count({ where: { callId: { in: callIds } } }),
      prisma.leadImportBatch.count({ where: { agencyId } }),
    ]);

    return res.json({
      success: true,
      targetUser: { id: user.id, email: user.email, agencyId: user.agencyId },
      counts: {
        leads: leadIds.length,
        customers: customerIds.size,
        wipeableCustomers: wipeableCustomerCount,
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
        leadImportBatches: importBatches,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/wipe-agency-data', wipeLimiter, async (req, res, next) => {
  try {
    if (!checkSecret(req, res)) return;
    const resolved = await resolveTargetAgency(req.body?.email);
    if (resolved.error) return res.status(400).json({ success: false, error: resolved.error });
    const { agencyId, user } = resolved;

    // Second confirmation guard — the body's email must exactly match the
    // resolved user, so a copy-paste mistake can't silently wipe the wrong
    // agency just because the secret header was valid.
    if (req.body?.confirmEmail !== user.email) {
      return res.status(400).json({ success: false, error: 'CONFIRMATION_MISMATCH', message: 'confirmEmail must exactly match email.' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const leadIds = (await tx.lead.findMany({ where: { agencyId }, select: { id: true } })).map((l) => l.id);
      const transferIds = (await tx.transfer.findMany({ where: { agencyId }, select: { id: true } })).map((t) => t.id);
      const opportunityIds = (await tx.opportunity.findMany({ where: { agencyId }, select: { id: true } })).map((o) => o.id);
      const callIds = (await tx.call.findMany({ where: { agencyId }, select: { id: true } })).map((c) => c.id);

      const customerIds = new Set(
        (await tx.lead.findMany({ where: { agencyId, customerId: { not: null } }, select: { customerId: true } })).map((l) => l.customerId)
      );
      (await tx.transfer.findMany({ where: { agencyId, customerId: { not: null } }, select: { customerId: true } })).forEach((t) => customerIds.add(t.customerId));
      (await tx.opportunity.findMany({ where: { agencyId }, select: { customerId: true } })).forEach((o) => customerIds.add(o.customerId));

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
      counts.revenueEvents = (await tx.revenueEvent.deleteMany({ where: { transferId: { in: transferIds } } })).count;
      counts.costEvents = (await tx.costEvent.deleteMany({ where: { transferId: { in: transferIds } } })).count;

      counts.transfers = (await tx.transfer.deleteMany({ where: { agencyId } })).count;

      counts.leadImportBatches = (await tx.leadImportBatch.deleteMany({ where: { agencyId } })).count;

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

    return res.json({ success: true, agencyId, wipedCounts: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
