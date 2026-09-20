// Free-text -> structured Goal draft, via the same one real Anthropic
// integration point every other AI feature in this app uses (aiProvider.js).
// This NEVER creates a Goal itself — it only returns a draft for a human
// to review/edit before the existing POST /api/goals actually creates one,
// and it never invents a producer: a name only resolves to a real userId
// if it actually matches someone on the agency's real roster.

const { z } = require('zod');
const { callEd, isConfigured } = require('./aiProvider');

const METRICS = ['sales', 'quotes', 'calls', 'contacts', 'premium_cents', 'cross_sells', 'winbacks', 'transfers'];
const PERIOD_TYPES = ['daily', 'weekly', 'monthly', 'quarterly', 'custom'];

const draftSchema = z.object({
  producerName: z.string().nullable(),
  metric: z.enum(METRICS),
  targetValue: z.number().int().positive(),
  periodType: z.enum(PERIOD_TYPES),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
});

function buildPrompt(roster, now) {
  const rosterNames = roster.map((u) => `${u.firstName} ${u.lastName}`);
  return `You turn a manager's plain-English sales goal into structured data for EvenFlow's Goals system.

Today's date is ${now.toISOString().slice(0, 10)}.

The real producers on this agency's roster are: ${rosterNames.length > 0 ? rosterNames.join(', ') : '(none active)'}.

Respond with ONLY a single JSON object, no markdown fences, no preamble, matching exactly this shape:
{
  "producerName": string or null (null means the whole agency, not one producer — only use a name that EXACTLY matches one of the real roster names above, never invent one),
  "metric": one of ${METRICS.join(', ')},
  "targetValue": positive integer,
  "periodType": one of ${PERIOD_TYPES.join(', ')},
  "periodStart": ISO 8601 datetime,
  "periodEnd": ISO 8601 datetime
}

Compute periodStart/periodEnd as real calendar dates relative to today for whatever period the manager described (e.g. "this month" = the 1st to the last day of the current month at 23:59:59). If the manager didn't name a producer, set producerName to null (an agency-wide goal). If the metric isn't obviously one of the listed values, pick the closest real match — never invent a metric outside that list.`;
}

// Returns { available: false } when unconfigured, { available: true, draft }
// on success, or throws on a malformed/schema-invalid model response (never
// silently fabricates a draft).
async function parseGoalText(text, { roster = [], now = new Date() } = {}) {
  if (!isConfigured()) {
    return { available: false };
  }

  const systemPrompt = buildPrompt(roster, now);
  const result = await callEd({ systemPrompt, userMessage: text, maxTokens: 400 });
  if (!result.available) {
    return { available: false };
  }

  let parsed;
  try {
    const cleaned = result.text.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Goal parse response was not valid JSON: ${err.message}`);
  }

  const validated = draftSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Goal parse response did not match expected schema: ${JSON.stringify(validated.error.flatten())}`);
  }

  // Resolve a producer name to a real userId from the actual roster —
  // never invent a user, and never trust the model's own judgement over
  // a real exact-name match against the real roster.
  let userId = null;
  let unmatchedProducerName = null;
  if (validated.data.producerName) {
    const match = roster.find(
      (u) => `${u.firstName} ${u.lastName}`.toLowerCase() === validated.data.producerName.toLowerCase()
    );
    if (match) userId = match.id;
    else unmatchedProducerName = validated.data.producerName;
  }

  return {
    available: true,
    draft: {
      userId,
      unmatchedProducerName,
      metric: validated.data.metric,
      targetValue: validated.data.targetValue,
      periodType: validated.data.periodType,
      periodStart: validated.data.periodStart,
      periodEnd: validated.data.periodEnd,
    },
  };
}

module.exports = { parseGoalText, buildPrompt, draftSchema, METRICS, PERIOD_TYPES };
