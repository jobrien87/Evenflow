const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { combineComponents, explainScore, computeTelemarketerScore, computeAgencyScore } = require('./flowScore');
const { prisma } = require('./db');

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

// Real-database integration tests for the Yield Transfers rebuild:
// computeTelemarketerScore/computeAgencyScore are DB-querying functions,
// not pure logic — matching this app's own "never mock the database for
// real logic" convention (see agencyChat.test.js, runningReport.test.js)
// rather than mocking Prisma here.
const suffix = Date.now();
let agencyId;
let tmId;
let leadIds = [];

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Test Agency FS ${suffix}` } });
  agencyId = agency.id;

  const tm = await prisma.user.create({
    data: { email: `tm-fs-${suffix}@test.local`, firstName: 'Test', lastName: 'TM', role: 'TELEMARKETER', status: 'ACTIVE' },
  });
  tmId = tm.id;

  // 1 SOLD, 1 CONTACTED (a real, non-failure outcome), 1 BAD_CONTACT
  // (counts against lead quality), all telemarketer-sourced.
  const statuses = ['SOLD', 'CONTACTED', 'BAD_CONTACT'];
  for (const status of statuses) {
    const lead = await prisma.lead.create({
      data: { agencyId, source: 'telemarketer', createdById: tmId, status },
    });
    leadIds.push(lead.id);
  }
});

after(async () => {
  await prisma.flowScoreSnapshot.deleteMany({ where: { subjectType: 'USER', subjectId: tmId } });
  await prisma.flowScoreSnapshot.deleteMany({ where: { subjectType: 'AGENCY', subjectId: agencyId } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.user.delete({ where: { id: tmId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await prisma.$disconnect();
});

test('computeTelemarketerScore is Lead-based: leadQuality excludes BAD_CONTACT/DUPLICATE/DO_NOT_CONTACT, downstreamQuality counts real SOLD', async () => {
  const snapshot = await computeTelemarketerScore(tmId);
  assert.ok(snapshot, 'expected a real snapshot to be saved (never null when real data exists)');
  const leadQuality = snapshot.components.find((c) => c.key === 'leadQuality');
  const downstreamQuality = snapshot.components.find((c) => c.key === 'downstreamQuality');
  assert.ok(leadQuality, 'expected leadQuality to be included');
  assert.ok(downstreamQuality, 'expected downstreamQuality to be included');
  // 2 of 3 leads are not a quality failure (SOLD, CONTACTED) -> 66.7%
  assert.equal(leadQuality.value, 66.7);
  // 1 of 3 leads is SOLD -> 33.3%
  assert.equal(downstreamQuality.value, 33.3);
  // The old routingSuccessRate component no longer exists at all.
  assert.equal(snapshot.components.find((c) => c.key === 'routingSuccessRate'), undefined);
});

test('computeAgencyScore no longer computes or includes a transferPerformance component', async () => {
  const snapshot = await computeAgencyScore(agencyId);
  assert.ok(snapshot);
  assert.equal(snapshot.components.find((c) => c.key === 'transferPerformance'), undefined);
  assert.equal(snapshot.excludedComponents.find((c) => c.key === 'transferPerformance'), undefined);
  // funnelHealth already includes the telemarketer-sourced SOLD lead for
  // free, since it's just a real Lead row like any other.
  const funnelHealth = snapshot.components.find((c) => c.key === 'funnelHealth');
  assert.ok(funnelHealth);
});
