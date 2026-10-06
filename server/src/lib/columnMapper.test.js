// Pure-unit tests for lib/columnMapper.js — the deterministic matcher
// needs no network at all; the AI fallback mocks global.fetch only
// (mirroring callAnalysis.test.js's established pattern), never a real
// network call, since aiProvider.callMultiTurn talks to the real
// Anthropic API via fetch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHeader, buildHeaderMap, buildRawRowCapture, resolveHeaderMapWithAiFallback } = require('./columnMapper');

const SYNONYMS = {
  recordDate: ['date', 'issuedate'],
  premiumCents: ['premium', 'premiumamount'],
  product: ['product', 'policytype'],
};

test('normalizeHeader lowercases and strips non-alphanumerics', () => {
  assert.equal(normalizeHeader('Issue Date'), 'issuedate');
  assert.equal(normalizeHeader('  Premium Amount '), 'premiumamount');
  assert.equal(normalizeHeader(''), '');
});

test('buildHeaderMap matches known synonyms and never overwrites an already-mapped field', () => {
  const map = buildHeaderMap(['Issue Date', 'Premium Amount', 'Date'], SYNONYMS);
  assert.equal(map.recordDate, 0, 'the first matching header wins');
  assert.equal(map.premiumCents, 1);
  assert.equal(map.product, undefined, 'no header matches product');
});

test('buildRawRowCapture keeps every non-empty column keyed by its own literal header text, recognized or not', () => {
  const headerRow = ['Issue Date', 'Source Batch', 'Reason', ''];
  const row = ['2024-01-01', 'B-42', '', 'unused'];
  const capture = buildRawRowCapture(headerRow, row);
  assert.deepEqual(capture, { 'Issue Date': '2024-01-01', 'Source Batch': 'B-42' });
});

test('resolveHeaderMapWithAiFallback skips the AI call entirely when the deterministic pass already resolved every known field', async () => {
  let fetchCalls = 0;
  const original = global.fetch;
  global.fetch = async () => { fetchCalls += 1; return { ok: true, json: async () => ({}) }; };
  try {
    const headerRow = ['Issue Date', 'Premium Amount'];
    const result = await resolveHeaderMapWithAiFallback({
      headerRow, rows: [], HEADER_SYNONYMS: SYNONYMS, knownFields: ['recordDate', 'premiumCents'], fieldDescriptions: {},
    });
    assert.equal(result.aiUsed, false);
    assert.equal(result.aiSkippedReason, 'nothing_unmapped');
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = original;
  }
});

test('resolveHeaderMapWithAiFallback reports not_configured honestly with no API key, without throwing', async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const headerRow = ['Issue Date', 'Policy Line'];
    const result = await resolveHeaderMapWithAiFallback({
      headerRow, rows: [['2024-01-01', 'Auto']], HEADER_SYNONYMS: SYNONYMS,
      knownFields: ['recordDate', 'product'], fieldDescriptions: { product: 'the insurance product/line' },
    });
    assert.equal(result.aiUsed, false);
    assert.equal(result.aiSkippedReason, 'not_configured');
    assert.equal(result.headerMap.recordDate, 0);
    assert.equal(result.headerMap.product, undefined, 'never guessed without AI');
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});

function mockFetchOnce(t, text) {
  t.mock.method(global, 'fetch', async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 } }),
  }));
}

test('resolveHeaderMapWithAiFallback applies only high-confidence suggestions, never a low-confidence guess', async (t) => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  mockFetchOnce(t, JSON.stringify([
    { header: 'Policy Line', suggestedField: 'product', confidence: 'high' },
    { header: 'Notes Col', suggestedField: 'product', confidence: 'low' },
  ]));
  try {
    const headerRow = ['Issue Date', 'Policy Line', 'Notes Col'];
    const result = await resolveHeaderMapWithAiFallback({
      headerRow, rows: [['2024-01-01', 'Auto', 'hi']], HEADER_SYNONYMS: SYNONYMS,
      knownFields: ['recordDate', 'product'], fieldDescriptions: { product: 'the insurance product/line' },
    });
    assert.equal(result.aiUsed, true);
    assert.equal(result.headerMap.product, 1, 'the high-confidence suggestion for Policy Line is applied');
    assert.ok(!result.unmappedHeaders.includes('Policy Line'));
    assert.ok(result.unmappedHeaders.includes('Notes Col'), 'the low-confidence suggestion is never applied');
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original; else delete process.env.ANTHROPIC_API_KEY;
  }
});

test('resolveHeaderMapWithAiFallback never throws on a non-JSON model response — falls back to deterministic-only', async (t) => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  mockFetchOnce(t, 'not json at all');
  try {
    const headerRow = ['Issue Date', 'Policy Line'];
    const result = await resolveHeaderMapWithAiFallback({
      headerRow, rows: [['2024-01-01', 'Auto']], HEADER_SYNONYMS: SYNONYMS,
      knownFields: ['recordDate', 'product'], fieldDescriptions: { product: 'the insurance product/line' },
    });
    assert.equal(result.aiUsed, false);
    assert.equal(result.aiSkippedReason, 'invalid_response');
    assert.equal(result.headerMap.product, undefined);
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original; else delete process.env.ANTHROPIC_API_KEY;
  }
});

test('resolveHeaderMapWithAiFallback never throws when the mocked fetch itself fails', async (t) => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  t.mock.method(global, 'fetch', async () => { throw new Error('network down'); });
  try {
    const headerRow = ['Issue Date', 'Policy Line'];
    const result = await resolveHeaderMapWithAiFallback({
      headerRow, rows: [['2024-01-01', 'Auto']], HEADER_SYNONYMS: SYNONYMS,
      knownFields: ['recordDate', 'product'], fieldDescriptions: { product: 'the insurance product/line' },
    });
    assert.equal(result.aiUsed, false);
    assert.equal(result.aiSkippedReason, 'error');
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original; else delete process.env.ANTHROPIC_API_KEY;
  }
});
