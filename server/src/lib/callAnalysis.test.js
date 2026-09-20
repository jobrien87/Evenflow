const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeTranscript } = require('./callAnalysis');

const VALID_ANALYSIS = {
  summary: 'Producer discussed auto coverage, customer had budget concerns.',
  products_discussed: ['Auto'],
  objections: [{ objection: 'Price too high', handled_well: true, note: 'Offered a payment plan.' }],
  buying_signals: ['Asked about start date'],
  missed_opportunities: [],
  cross_sell_opportunities: ['Home bundle'],
  follow_up_commitments: [{ commitment: 'Send quote by email', when: 'today' }],
  next_steps: ['Send written quote'],
  strengths: ['Clear explanation of coverage'],
  coaching_opportunities: ['Ask more discovery questions early'],
  overall_score: 78,
  dimension_scores: { Opening: 80, Rapport: 75, Discovery: 70, 'Needs Analysis': 72, 'Question Quality': 74, 'Product Positioning': 80, 'Value Communication': 78, 'Objection Handling': 82, Closing: 76, 'Next-Step Clarity': 79, 'Cross-Sell Awareness': 60, Professionalism: 90 },
  review_recommended: false,
};

// aiProvider.callEd talks to the real Anthropic API via the global fetch —
// mocking fetch (rather than reaching into aiProvider's internals) lets us
// test analyzeTranscript's real parsing/validation logic without a live key.
function mockFetchOnce(t, { text, usage = { input_tokens: 500, output_tokens: 300 } }) {
  t.mock.method(global, 'fetch', async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text }], usage }),
  }));
}

test('analyzeTranscript returns available:false honestly when no API key is configured (never fabricates a score)', async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await analyzeTranscript('some transcript text');
    assert.equal(result.available, false);
  } finally {
    if (original) process.env.ANTHROPIC_API_KEY = original;
  }
});

test('analyzeTranscript parses and validates a real-shaped LLM response', async (t) => {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  mockFetchOnce(t, { text: JSON.stringify(VALID_ANALYSIS) });

  const result = await analyzeTranscript('producer: hi, this is...');
  assert.equal(result.available, true);
  assert.equal(result.analysis.overall_score, 78);
  assert.equal(result.analysis.dimension_scores.Opening, 80);
  assert.equal(result.inputTokens, 500);
  assert.equal(result.outputTokens, 300);
});

test('analyzeTranscript strips markdown code fences before parsing (a common real LLM formatting quirk)', async (t) => {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  mockFetchOnce(t, { text: '```json\n' + JSON.stringify(VALID_ANALYSIS) + '\n```' });

  const result = await analyzeTranscript('producer: hi, this is...');
  assert.equal(result.available, true);
  assert.equal(result.analysis.overall_score, 78);
});

test('analyzeTranscript throws (never silently fabricates) on non-JSON model output', async (t) => {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  mockFetchOnce(t, { text: 'Sorry, I cannot analyze this call.' });

  await assert.rejects(() => analyzeTranscript('producer: hi'), /not valid JSON/);
});

test('analyzeTranscript throws on a schema-invalid response (e.g. missing a required field)', async (t) => {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  const broken = { ...VALID_ANALYSIS };
  delete broken.overall_score;
  mockFetchOnce(t, { text: JSON.stringify(broken) });

  await assert.rejects(() => analyzeTranscript('producer: hi'), /did not match expected schema/);
});
