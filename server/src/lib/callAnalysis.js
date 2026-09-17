const { z } = require('zod');
const { callEd, isConfigured } = require('./aiProvider');

const SCORING_DIMENSIONS = [
  'Opening', 'Rapport', 'Discovery', 'Needs Analysis', 'Question Quality',
  'Product Positioning', 'Value Communication', 'Objection Handling',
  'Closing', 'Next-Step Clarity', 'Cross-Sell Awareness', 'Professionalism',
];

const analysisSchema = z.object({
  summary: z.string(),
  products_discussed: z.array(z.string()),
  objections: z.array(z.object({ objection: z.string(), handled_well: z.boolean(), note: z.string() })),
  buying_signals: z.array(z.string()),
  missed_opportunities: z.array(z.string()),
  cross_sell_opportunities: z.array(z.string()),
  follow_up_commitments: z.array(z.object({ commitment: z.string(), when: z.string().optional() })),
  next_steps: z.array(z.string()),
  strengths: z.array(z.string()),
  coaching_opportunities: z.array(z.string()),
  overall_score: z.number().int().min(0).max(100),
  dimension_scores: z.record(z.number().int().min(0).max(100)),
  review_recommended: z.boolean(),
  review_reason: z.string().optional(),
});

function buildAnalysisPrompt() {
  return `You are analyzing an insurance sales call transcript for EvenFlow's call coaching system.

Score the call on these exact dimensions (0-100 each): ${SCORING_DIMENSIONS.join(', ')}.

Respond with ONLY a single JSON object, no markdown fences, no preamble, matching exactly this shape:
{
  "summary": string,
  "products_discussed": string[],
  "objections": [{ "objection": string, "handled_well": boolean, "note": string }],
  "buying_signals": string[],
  "missed_opportunities": string[],
  "cross_sell_opportunities": string[],
  "follow_up_commitments": [{ "commitment": string, "when": string }],
  "next_steps": string[],
  "strengths": string[],
  "coaching_opportunities": string[],
  "overall_score": number,
  "dimension_scores": { "Opening": number, "Rapport": number, "Discovery": number, "Needs Analysis": number, "Question Quality": number, "Product Positioning": number, "Value Communication": number, "Objection Handling": number, "Closing": number, "Next-Step Clarity": number, "Cross-Sell Awareness": number, "Professionalism": number },
  "review_recommended": boolean,
  "review_reason": string
}

Do not invent compliance violations as definitive legal conclusions, only flag "review_recommended": true with a plain-language reason if something seems worth a human look. Base every field only on what is actually in the transcript below, do not invent details not present.`;
}

async function analyzeTranscript(transcript) {
  if (!isConfigured()) {
    return { available: false };
  }

  const systemPrompt = buildAnalysisPrompt();
  const result = await callEd({ systemPrompt, userMessage: transcript, maxTokens: 2000 });
  if (!result.available) {
    return { available: false };
  }

  let parsed;
  try {
    const cleaned = result.text.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Analysis response was not valid JSON: ${err.message}`);
  }

  const validated = analysisSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Analysis response did not match expected schema: ${JSON.stringify(validated.error.flatten())}`);
  }

  return {
    available: true,
    analysis: validated.data,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

module.exports = { analyzeTranscript, SCORING_DIMENSIONS, analysisSchema };
