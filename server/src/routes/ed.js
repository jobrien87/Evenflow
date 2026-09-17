const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth } = require('../middleware/auth');
const { buildContextForUser } = require('../lib/edContext');
const { buildSystemPrompt } = require('../lib/edPersonality');
const { callEd, isConfigured } = require('../lib/aiProvider');
const { estimateCostMicros } = require('../lib/aiCost');
const { recordAudit } = require('../lib/audit');

const router = express.Router();
router.use(requireAuth);

function deterministicSummary(context) {
  if (context.role === 'PRODUCER') {
    const paceLine = context.pace
      ? `You're at ${context.pace.actual} sales against a pace of ${context.pace.expectedByNow} by today (goal ${context.pace.goal}).`
      : 'No sales goal is set for you this period.';
    return `${paceLine} You have ${context.openLeads} open leads and ${context.openTasks} open tasks.`;
  }
  if (context.role === 'AGENCY_OWNER') {
    return `${context.openLeads} open leads (${context.overdueLeads} overdue past 1 hour). ${context.transfersAccepted}/${context.transfersThisMonth} transfers accepted this month${context.transferAcceptanceRate !== null ? ` (${context.transferAcceptanceRate}%)` : ''}. Month revenue $${context.monthRevenue}, cost $${context.monthCost}.`;
  }
  if (context.role === 'PLATFORM_OWNER') {
    return `${context.activeAgencies}/${context.totalAgencies} agencies active. ${context.activeTMs}/${context.totalTMs} telemarketers active. ${context.missedTransfers} missed transfers this month out of ${context.transfersThisMonth}. Month revenue $${context.monthRevenue}, cost $${context.monthCost}. ${context.openSupportTickets} open support tickets.`;
  }
  return 'No summary available for this role yet.';
}

router.get('/status', async (req, res) => {
  return res.json({ success: true, aiConfigured: isConfigured() });
});

// AI operational cost visibility for Platform Owner (per spec: "Platform
// Owner can understand AI operational cost").
router.get('/usage-summary', async (req, res, next) => {
  try {
    if (req.user.role !== 'PLATFORM_OWNER') {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const { microsToDollars } = require('../lib/aiCost');
    const agg = await prisma.aiUsageLog.aggregate({
      _sum: { inputTokens: true, outputTokens: true, estimatedCostMicros: true },
      _count: { id: true },
    });
    return res.json({
      success: true,
      totalCalls: agg._count.id,
      totalInputTokens: agg._sum.inputTokens || 0,
      totalOutputTokens: agg._sum.outputTokens || 0,
      estimatedTotalCostUsd: microsToDollars(agg._sum.estimatedCostMicros || 0),
      note: 'Estimated cost based on documented per-model rate table; treat as an estimate, not an invoice.',
    });
  } catch (err) {
    next(err);
  }
});

const askSchema = z.object({
  message: z.string().min(1).max(2000),
  humorLevel: z.enum(['LOW', 'NORMAL', 'SPICY']).optional(),
});

router.post('/ask', async (req, res, next) => {
  try {
    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }

    const context = await buildContextForUser(req.user);
    const summary = deterministicSummary(context);

    if (!isConfigured()) {
      return res.json({
        success: true,
        available: false,
        message: `ED's language layer isn't configured right now, so no clever commentary today, but here's what's actually happening: ${summary}`,
        context,
      });
    }

    const systemPrompt = buildSystemPrompt({ context, humorLevel: parsed.data.humorLevel || 'NORMAL' });

    let result;
    try {
      result = await callEd({ systemPrompt, userMessage: parsed.data.message });
    } catch (err) {
      console.error(`[ed] provider error correlationId=${req.correlationId}`, err.message);
      return res.json({
        success: true,
        available: false,
        message: `ED's language layer hit an error, so here's the straight data instead: ${summary}`,
        context,
      });
    }

    const estimatedCostMicros = estimateCostMicros(result.model, result.inputTokens, result.outputTokens);

    await Promise.all([
      prisma.aiUsageLog.create({
        data: {
          feature: 'ed_chat',
          agencyId: req.user.agencyId,
          userId: req.user.id,
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          estimatedCostMicros,
        },
      }),
      prisma.edMessage.create({ data: { userId: req.user.id, role: 'user', content: parsed.data.message } }),
      prisma.edMessage.create({ data: { userId: req.user.id, role: 'assistant', content: result.text } }),
    ]);

    return res.json({ success: true, available: true, message: result.text, context });
  } catch (err) {
    next(err);
  }
});

router.get('/history', async (req, res, next) => {
  try {
    const messages = await prisma.edMessage.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 40,
    });
    return res.json({ success: true, messages: messages.reverse() });
  } catch (err) {
    next(err);
  }
});

const escalateSchema = z.object({ subject: z.string().min(1), description: z.string().min(1) });

router.post('/escalate', async (req, res, next) => {
  try {
    const parsed = escalateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION' });

    const ticket = await prisma.supportTicket.create({
      data: {
        agencyId: req.user.agencyId,
        userId: req.user.id,
        category: 'ed_escalation',
        subject: parsed.data.subject,
        description: parsed.data.description,
        metadata: { correlationId: req.correlationId, source: 'ed' },
      },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.user.agencyId,
      action: 'support.ticket_created_by_ed', entityType: 'SupportTicket', entityId: ticket.id,
      correlationId: req.correlationId,
    });

    return res.status(201).json({ success: true, ticket });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
