const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGoalText } = require('./goalParser');

const ROSTER = [
  { id: 'user-1', firstName: 'Hand', lastName: 'Calc' },
  { id: 'user-2', firstName: 'Ada', lastName: 'Owner' },
];

function mockFetchOnce(t, text) {
  t.mock.method(global, 'fetch', async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 50 } }),
  }));
}

test('parseGoalText returns available:false honestly when no API key is configured', async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await parseGoalText('get producers to 10 sales this month', { roster: ROSTER });
    assert.equal(result.available, false);
  } finally {
    if (original) process.env.ANTHROPIC_API_KEY = original;
  }
});

test('parseGoalText resolves a producer name to a real userId from the actual roster', async (t) => {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  mockFetchOnce(t, JSON.stringify({
    producerName: 'Hand Calc',
    metric: 'sales',
    targetValue: 10,
    periodType: 'monthly',
    periodStart: '2026-09-01T00:00:00.000Z',
    periodEnd: '2026-09-30T23:59:59.000Z',
  }));

  const result = await parseGoalText('get Hand Calc to 10 sales this month', { roster: ROSTER });
  assert.equal(result.available, true);
  assert.equal(result.draft.userId, 'user-1');
  assert.equal(result.draft.unmatchedProducerName, null);
  assert.equal(result.draft.targetValue, 10);
});

test('parseGoalText never invents a user for a name that is not on the real roster', async (t) => {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  mockFetchOnce(t, JSON.stringify({
    producerName: 'Someone Fictional',
    metric: 'sales',
    targetValue: 5,
    periodType: 'monthly',
    periodStart: '2026-09-01T00:00:00.000Z',
    periodEnd: '2026-09-30T23:59:59.000Z',
  }));

  const result = await parseGoalText('get Someone Fictional to 5 sales', { roster: ROSTER });
  assert.equal(result.available, true);
  assert.equal(result.draft.userId, null);
  assert.equal(result.draft.unmatchedProducerName, 'Someone Fictional');
});

test('parseGoalText treats a null producerName as agency-wide (no user resolution attempted)', async (t) => {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  mockFetchOnce(t, JSON.stringify({
    producerName: null,
    metric: 'transfers',
    targetValue: 20,
    periodType: 'monthly',
    periodStart: '2026-09-01T00:00:00.000Z',
    periodEnd: '2026-09-30T23:59:59.000Z',
  }));

  const result = await parseGoalText('get the whole agency to 20 transfers this month', { roster: ROSTER });
  assert.equal(result.available, true);
  assert.equal(result.draft.userId, null);
  assert.equal(result.draft.unmatchedProducerName, null);
  assert.equal(result.draft.metric, 'transfers');
});

test('parseGoalText throws on a schema-invalid response (e.g. a metric outside the real enum)', async (t) => {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  mockFetchOnce(t, JSON.stringify({
    producerName: null,
    metric: 'made_up_metric',
    targetValue: 10,
    periodType: 'monthly',
    periodStart: '2026-09-01T00:00:00.000Z',
    periodEnd: '2026-09-30T23:59:59.000Z',
  }));

  await assert.rejects(() => parseGoalText('do something', { roster: ROSTER }), /did not match expected schema/);
});

test('parseGoalText throws on non-JSON model output rather than fabricating a draft', async (t) => {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  mockFetchOnce(t, 'I am not sure what you mean by that.');

  await assert.rejects(() => parseGoalText('do something vague', { roster: ROSTER }), /not valid JSON/);
});
