const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth } = require('../middleware/auth');
const { buildContextForUser, buildBriefingContext } = require('../lib/edContext');
const { buildSystemPrompt, buildBriefingPrompt } = require('../lib/edPersonality');
const { callEd, isConfigured } = require('../lib/aiProvider');
const { estimateCostMicros } = require('../lib/aiCost');
const { recordAudit } = require('../lib/audit');

const router = express.Router();
router.use(requireAuth);

// Real billed API calls now happen here, so a per-user daily cap is a
// responsible-use safeguard — not a business rule, just a ceiling so one
// account can't run up unbounded real spend.
const askLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user.id,
  message: { success: false, error: 'RATE_LIMITED', message: "You've hit today's ED chat limit. It resets tomorrow." },
});
const briefingLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user.id,
  message: { success: false, error: 'RATE_LIMITED', message: "You've hit today's ED briefing limit. It resets tomorrow." },
});

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

function deterministicBriefing(context) {
  if (context.role === 'PRODUCER') {
    const scoreLine = context.flowScoreDelta !== null && context.flowScoreDelta !== undefined
      ? ` Flow Score moved ${context.flowScoreDelta >= 0 ? '+' : ''}${context.flowScoreDelta} to ${context.flowScoreNow}.`
      : '';
    const paceLine = context.goalPace
      ? ` You're at ${context.goalPace.actual}/${context.goalPace.target} on your sales goal.`
      : '';
    return `Since your last briefing: ${context.newLeads} new lead(s), ${context.newSales} sale(s).${scoreLine}${paceLine}`;
  }
  if (context.role === 'AGENCY_OWNER') {
    const scoreLine = context.flowScoreDelta !== null && context.flowScoreDelta !== undefined
      ? ` Agency Flow Score moved ${context.flowScoreDelta >= 0 ? '+' : ''}${context.flowScoreDelta} to ${context.flowScoreNow}.`
      : '';
    return `Since your last briefing: ${context.newLeads} new lead(s), ${context.newTransfers} new transfer(s), ${context.newSales} sale(s).${scoreLine}`;
  }
  if (context.role === 'PLATFORM_OWNER') {
    return `Since your last briefing: ${context.newAgencies} new agenc${context.newAgencies === 1 ? 'y' : 'ies'}, ${context.newTransfers} new transfer(s), ${context.missedTransfers} missed.`;
  }
  return 'No briefing available for this role yet.';
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

router.post('/ask', askLimiter, async (req, res, next) => {
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

const briefingSchema = z.object({ humorLevel: z.enum(['LOW', 'NORMAL', 'SPICY']).optional() });

// On-demand daily briefing (not push-scheduled — no cron infra exists in
// this app, and none should be added just for this). Real deltas since
// this user's lastBriefingAt, written up in ED's voice, same honest
// fallback rule as /ask. lastBriefingAt advances on every call (whether
// or not the language layer is configured) so the next briefing's window
// starts from here, not from the last time the LLM happened to be reachable.
router.get('/briefing', briefingLimiter, async (req, res, next) => {
  try {
    const parsed = briefingSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }

    const context = await buildBriefingContext(req.user);
    const summary = deterministicBriefing(context);

    if (!isConfigured()) {
      await prisma.user.update({ where: { id: req.user.id }, data: { lastBriefingAt: new Date() } });
      return res.json({ success: true, available: false, message: summary, context });
    }

    const systemPrompt = buildBriefingPrompt({ context, humorLevel: parsed.data.humorLevel || 'NORMAL' });

    let result;
    try {
      result = await callEd({ systemPrompt, userMessage: 'Give me my daily briefing.', maxTokens: 300 });
    } catch (err) {
      console.error(`[ed] briefing provider error correlationId=${req.correlationId}`, err.message);
      await prisma.user.update({ where: { id: req.user.id }, data: { lastBriefingAt: new Date() } });
      return res.json({ success: true, available: false, message: summary, context });
    }

    const estimatedCostMicros = estimateCostMicros(result.model, result.inputTokens, result.outputTokens);

    await Promise.all([
      prisma.aiUsageLog.create({
        data: {
          feature: 'ed_briefing',
          agencyId: req.user.agencyId,
          userId: req.user.id,
          model: result.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          estimatedCostMicros,
        },
      }),
      prisma.user.update({ where: { id: req.user.id }, data: { lastBriefingAt: new Date() } }),
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
// Pure, side-effect-free helpers attached for direct unit testing (see
// ed.test.js) — the router itself is a function, so properties on it are
// just as reachable via require() as a plain module.exports object.
module.exports.deterministicSummary = deterministicSummary;
module.exports.deterministicBriefing = deterministicBriefing;
