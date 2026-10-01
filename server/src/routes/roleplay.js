// Live AI roleplay practice for a single training drill — reuses the
// same real Anthropic integration point every other AI feature in this
// app uses (lib/aiProvider.js's callMultiTurn), never a second provider.
// Stateless server-side by design: this is a practice tool, not a
// graded record, so the running transcript lives only in the client's
// React state and is resent in full on every turn (mirrors how a real
// multi-turn chat call works, just without persisting to a table the
// way EdMessage does for Ed).

const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth } = require('../middleware/auth');
const { requireSalesStudioAccess } = require('../lib/entitlements');
const { callMultiTurn, isConfigured } = require('../lib/aiProvider');
const { estimateCostMicros } = require('../lib/aiCost');
const { findRelevantLessons } = require('../lib/drillRetrieval');

const router = express.Router();
router.use(requireAuth);
router.use(requireSalesStudioAccess);

// Same shape/cadence as ed.js's askLimiter — real billed API calls.
const roleplayLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user.id,
  message: { success: false, error: 'RATE_LIMITED', message: "You've hit today's roleplay limit. It resets tomorrow." },
});

function buildRoleplaySystemPrompt(course, lesson, relatedLessons = []) {
  const relatedSection = relatedLessons.length > 0
    ? `\n\nOTHER RELEVANT DRILLS IN THE LIBRARY (real, from the same training library — when you give feedback, you may recommend one of these BY NAME as a next drill to practice if it genuinely fits what came up in the conversation; never invent a drill that isn't listed here, and never use its content as your own in-character script):\n${relatedLessons.map((l) => `- "${l.title}" (${l.courseTitle}): ${l.content.slice(0, 150).trim()}...`).join('\n')}`
    : '';

  return `You are running a live phone-call roleplay to help an insurance salesperson practice one specific drill from their training library.

DRILL: ${lesson.title}
CATEGORY: ${course.title}

WHAT THIS DRILL TEACHES (its real training content, follow it faithfully):
${lesson.content}
${relatedSection}

Figure out from the conversation which role the human is playing, and always play the OTHER one:
- If they're writing as the insurance agent (pitching, asking discovery questions, handling objections, guiding the call), you play a realistic PROSPECT/CUSTOMER with realistic objections relevant to this exact drill.
- If they're writing as the prospect/customer instead (asking questions, raising objections, sounding like someone being sold to), you play the INSURANCE AGENT, demonstrating this drill's technique well so they can see it modeled.
If this is the very first turn (no prior messages), open it yourself: greet in character as a customer answering the phone, since that's the default practice direction — the human can redirect by explicitly saying they want to play the customer instead, and you should switch roles for the rest of the conversation once they do.

Stay in character and keep it realistic and conversational — 2-4 sentences per turn, like real phone dialogue, not a lecture. Only break character if the human explicitly asks for feedback (e.g. "feedback", "how did I do", "how am I doing") — then step out of character, give specific, honest feedback on how well the technique from this exact drill was applied, and offer to keep the roleplay going.`;
}

const messageSchema = z.object({ role: z.enum(['user', 'assistant']), content: z.string() });
const roleplaySchema = z.object({ messages: z.array(messageSchema).max(40) });

router.post('/:lessonId/message', roleplayLimiter, async (req, res, next) => {
  try {
    const parsed = roleplaySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }

    const lesson = await prisma.trainingLesson.findUnique({
      where: { id: req.params.lessonId },
      include: { course: { select: { id: true, title: true, isActive: true } } },
    });
    if (!lesson || !lesson.course.isActive) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    }

    if (!isConfigured()) {
      return res.json({
        success: true,
        available: false,
        message: "The AI roleplay isn't configured on this environment right now — you can still read the drill's content above and practice on your own.",
      });
    }

    // First turn: no messages yet, so send a placeholder user turn asking
    // the model to open the scene (never an empty messages array to the
    // Anthropic API).
    const messages = parsed.data.messages.length > 0
      ? parsed.data.messages
      : [{ role: 'user', content: '[Begin the roleplay.]' }];

    // Search the rest of the 75-drill library (excluding the drill already
    // being practiced) against the running transcript so far, so feedback
    // can point to a genuinely relevant next drill by name — same plain
    // keyword search ED's /ask uses, never a second AI call.
    const transcriptText = messages.map((m) => m.content).join(' ');
    const relatedLessons = await findRelevantLessons(transcriptText, { limit: 2, excludeIds: [lesson.id] });
    const systemPrompt = buildRoleplaySystemPrompt(lesson.course, lesson, relatedLessons);

    let result;
    try {
      result = await callMultiTurn({ systemPrompt, messages, maxTokens: 300 });
    } catch (err) {
      console.error(`[roleplay] provider error correlationId=${req.correlationId}`, err.message);
      return res.json({
        success: true,
        available: false,
        message: "The AI roleplay hit an error on that turn — try sending your message again.",
      });
    }

    const estimatedCostMicros = estimateCostMicros(result.model, result.inputTokens, result.outputTokens);
    await prisma.aiUsageLog.create({
      data: {
        feature: 'drill_roleplay',
        agencyId: req.user.agencyId,
        userId: req.user.id,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estimatedCostMicros,
      },
    });

    return res.json({ success: true, available: true, message: result.text });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
