const express = require('express');
const { prisma } = require('../lib/db');
const { requireAuth, scopeAgencyId } = require('../middleware/auth');
const { scoreLead } = require('../lib/priority');

const router = express.Router();
router.use(requireAuth);

// GET /api/work-queue
// Combines open leads assigned to the producer + open tasks assigned to the producer
// into a single ranked "what should I do next" list.
router.get('/', async (req, res, next) => {
  try {
    const agencyId = scopeAgencyId(req);
    const isProducer = req.user.role === 'PRODUCER';
    const targetUserId = req.query.userId && req.user.role !== 'PRODUCER' ? req.query.userId : req.user.id;

    const leadWhere = {
      ...(agencyId ? { agencyId } : {}),
      assignedToId: targetUserId,
      status: { in: ['NEW', 'ASSIGNED', 'ATTEMPTED', 'CONTACTED', 'QUOTE_STARTED', 'QUOTED', 'FOLLOW_UP'] },
      archivedAt: null,
    };
    const taskWhere = {
      ...(agencyId ? { agencyId } : {}),
      assignedToId: targetUserId,
      status: { in: ['OPEN', 'IN_PROGRESS'] },
    };
    const opportunityWhere = {
      ...(agencyId ? { agencyId } : {}),
      assignedToId: targetUserId,
      status: { in: ['ASSIGNED', 'ATTEMPTED', 'CONTACTED', 'QUOTED', 'SNOOZED'] },
    };

    const [leads, tasks, opportunities] = await Promise.all([
      prisma.lead.findMany({ where: leadWhere, include: { customer: true } }),
      prisma.task.findMany({ where: taskWhere, include: { lead: { include: { customer: true } } } }),
      prisma.opportunity.findMany({ where: opportunityWhere, include: { customer: true } }),
    ]);

    const now = new Date();

    const leadItems = leads.map((lead) => {
      const { priorityScore, priorityBand, priorityReason } = scoreLead(lead, now);
      return {
        itemType: 'LEAD',
        id: lead.id,
        title: lead.customer ? `${lead.customer.firstName} ${lead.customer.lastName}` : 'New Lead',
        subtitle: lead.product || lead.source,
        priorityScore,
        priorityBand,
        priorityReason,
        status: lead.status,
        dueAt: null,
        raw: lead,
      };
    });

    const overdueBonusMs = 0;
    const taskItems = tasks.map((task) => {
      let score = task.priority || 0;
      let reason = 'Assigned task';
      if (task.dueAt) {
        const overdue = new Date(task.dueAt).getTime() < now.getTime();
        if (overdue) {
          score += 40;
          reason = 'Overdue';
        } else {
          score += 15;
          reason = 'Due soon';
        }
      }
      let band = 'NORMAL';
      if (score >= 60) band = 'HIGH';
      else if (score >= 30) band = 'MEDIUM';
      return {
        itemType: 'TASK',
        id: task.id,
        title: task.title,
        subtitle: task.lead && task.lead.customer ? `${task.lead.customer.firstName} ${task.lead.customer.lastName}` : task.type,
        priorityScore: score,
        priorityBand: band,
        priorityReason: reason,
        status: task.status,
        dueAt: task.dueAt,
        raw: task,
      };
    });

    const opportunityItems = opportunities.map((opp) => {
      const band = opp.priorityScore >= 60 ? 'HIGH' : opp.priorityScore >= 30 ? 'MEDIUM' : 'NORMAL';
      return {
        itemType: 'OPPORTUNITY',
        id: opp.id,
        title: `${opp.customer.firstName} ${opp.customer.lastName}`,
        subtitle: `${opp.type === 'WINBACK' ? 'Winback' : 'Cross-sell'} — ${opp.product}`,
        priorityScore: opp.priorityScore,
        priorityBand: band,
        priorityReason: opp.reason,
        status: opp.status,
        dueAt: null,
        raw: opp,
      };
    });

    const combined = [...leadItems, ...taskItems, ...opportunityItems].sort((a, b) => b.priorityScore - a.priorityScore);

    return res.json({
      success: true,
      nextUp: combined[0] || null,
      queue: combined,
      counts: { leads: leadItems.length, tasks: taskItems.length, opportunities: opportunityItems.length, total: combined.length },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
