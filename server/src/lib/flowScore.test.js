const { test } = require('node:test');
const assert = require('node:assert/strict');
const { combineComponents, explainScore } = require('./flowScore');

test('combineComponents excludes zero-sample components and renormalizes the rest', () => {
  const weights = { a: 50, b: 30, c: 20 };
  const raw = {
    a: { label: 'A', value: 80, sampleSize: 5 },
    b: { label: 'B', value: 40, sampleSize: 5 },
    c: { label: 'C', value: null, sampleSize: 0 },
  };
  const { score, components, excludedComponents } = combineComponents(raw, weights);

  assert.equal(excludedComponents.length, 1);
  assert.equal(excludedComponents[0].key, 'c');
  assert.equal(excludedComponents[0].reason, 'INSUFFICIENT_DATA');
  assert.equal(components.length, 2);

  // weights renormalize among the remaining components (50/80=62.5%, 30/80=37.5%)
  const a = components.find((c) => c.key === 'a');
  const b = components.find((c) => c.key === 'b');
  assert.equal(a.normalizedWeight, 62.5);
  assert.equal(b.normalizedWeight, 37.5);

  // score = 80*0.625 + 40*0.375 = 65
  assert.equal(score, 65);
});

test('combineComponents flags lowConfidence below the minimum sample threshold', () => {
  const raw = {
    a: { label: 'A', value: 100, sampleSize: 2 },
    b: { label: 'B', value: 50, sampleSize: 3 },
  };
  const { components } = combineComponents(raw, { a: 50, b: 50 });
  assert.equal(components.find((c) => c.key === 'a').lowConfidence, true);
  assert.equal(components.find((c) => c.key === 'b').lowConfidence, false);
});

test('combineComponents returns a null score (never a fabricated number) when every component is excluded', () => {
  const raw = {
    a: { label: 'A', value: null, sampleSize: 0 },
    b: { label: 'B', value: null, sampleSize: 0 },
  };
  const { score, components, excludedComponents } = combineComponents(raw, { a: 50, b: 50 });
  assert.equal(score, null);
  assert.equal(components.length, 0);
  assert.equal(excludedComponents.length, 2);
});

test('explainScore picks biggest opportunities first so a genuine weak spot is never swallowed into strongest', () => {
  // Regression test for the Phase A bug: with only 2 valid components, a
  // naive "top 2 = strongest" would show the same 2 components as both
  // "strongest" and never surface the weak one as an opportunity.
  const snapshot = {
    score: 71,
    computedAt: new Date('2026-01-01'),
    components: [
      { key: 'responsiveness', label: 'Speed to first attempt', value: 100, lowConfidence: false },
      { key: 'conversion', label: 'Lead-to-sale conversion', value: 50, lowConfidence: false },
    ],
    excludedComponents: [{ key: 'callQuality', label: 'Call quality', reason: 'INSUFFICIENT_DATA', sampleSize: 0 }],
  };

  const explanation = explainScore(snapshot);

  assert.equal(explanation.biggestOpportunities.length, 1);
  assert.equal(explanation.biggestOpportunities[0].label, 'Lead-to-sale conversion');
  assert.equal(explanation.strongestAreas.length, 1);
  assert.equal(explanation.strongestAreas[0].label, 'Speed to first attempt');

  // The two lists never share a component.
  const strongestLabels = new Set(explanation.strongestAreas.map((c) => c.label));
  const opportunityLabels = new Set(explanation.biggestOpportunities.map((c) => c.label));
  for (const label of strongestLabels) assert.equal(opportunityLabels.has(label), false);
});

test('explainScore treats a component at or above the opportunity threshold as strong, never a false opportunity', () => {
  const snapshot = {
    score: 92,
    computedAt: new Date(),
    components: [
      { key: 'a', label: 'A', value: 95, lowConfidence: false },
      { key: 'b', label: 'B', value: 88, lowConfidence: false },
    ],
    excludedComponents: [],
  };
  const explanation = explainScore(snapshot);
  assert.equal(explanation.biggestOpportunities.length, 0);
  assert.equal(explanation.strongestAreas.length, 2);
});
