const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  combineComponents, explainScore, computeTelemarketerScore, computeAgencyScore, computeProducerScore,
  getActiveWeightConfig, listWeightConfigsForAgency, updateWeightConfigForAgency,
  COMPONENT_LABELS, DEFAULT_WEIGHTS,
} = require('./flowScore');
const { prisma } = require('./db');

test('COMPONENT_LABELS has exactly the same component keys as DEFAULT_WEIGHTS for every role (never drifts)', () => {
  for (const role of Object.keys(DEFAULT_WEIGHTS)) {
    const weightKeys = Object.keys(DEFAULT_WEIGHTS[role]).sort();
    const labelKeys = Object.keys(COMPONENT_LABELS[role]).sort();
    assert.deepEqual(labelKeys, weightKeys, `COMPONENT_LABELS.${role} keys must match DEFAULT_WEIGHTS.${role} keys`);
  }
});

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

// ---- "Flow Settings" — per-agency weight customization ----
// TELEMARKETER stays platform-wide (no single owning agency); AGENCY and
// PRODUCER become real per-agency rows once an agency customizes them —
// this is the core guarantee behind letting Agency Owners/Managers tune
// their own weights without ever affecting another agency.

let agencyXId, agencyYId, producerXId;

before(async () => {
  const [agencyX, agencyY] = await Promise.all([
    prisma.agency.create({ data: { name: `Flow Weights Lib Agency X ${suffix}` } }),
    prisma.agency.create({ data: { name: `Flow Weights Lib Agency Y ${suffix}` } }),
  ]);
  agencyXId = agencyX.id;
  agencyYId = agencyY.id;

  const producerX = await prisma.user.create({
    data: { email: `producer-fs-lib-${suffix}@test.local`, firstName: 'Test', lastName: 'ProducerX', role: 'PRODUCER', status: 'ACTIVE', agencyId: agencyXId },
  });
  producerXId = producerX.id;

  // Vendor-sourced, fast-attempted lead (counts toward responsiveness) plus
  // a SOLD lead (counts toward conversion) — enough real data that every
  // PRODUCER component is actually included, not excluded for zero sample.
  const vendor = await prisma.vendor.create({ data: { agencyId: agencyXId, name: `FS Lib Vendor ${suffix}`, email: `fs-lib-vendor-${suffix}@test.local`, product: 'AUTO' } });
  const customer = await prisma.customer.create({ data: { firstName: 'FS', lastName: 'Lib' } });
  const assignedAt = new Date(Date.now() - 10 * 60 * 1000);
  await prisma.lead.create({
    data: { agencyId: agencyXId, customerId: customer.id, assignedToId: producerXId, status: 'SOLD', vendorId: vendor.id, assignedAt, firstAttemptAt: new Date() },
  });
});

after(async () => {
  // Snapshots carry a non-nullable FK to the weight config they were
  // scored with — must be deleted first or the weight-config cleanup
  // below violates that constraint.
  await prisma.flowScoreSnapshot.deleteMany({ where: { subjectType: 'USER', subjectId: producerXId } });
  await prisma.flowScoreSnapshot.deleteMany({ where: { subjectType: 'AGENCY', subjectId: { in: [agencyXId, agencyYId] } } });
  await prisma.flowScoreWeightConfig.deleteMany({ where: { agencyId: { in: [agencyXId, agencyYId] } } });
  await prisma.lead.deleteMany({ where: { agencyId: agencyXId } });
  await prisma.vendor.deleteMany({ where: { agencyId: agencyXId } });
  await prisma.user.deleteMany({ where: { id: producerXId } });
  await prisma.agency.deleteMany({ where: { id: { in: [agencyXId, agencyYId] } } });
});

test('getActiveWeightConfig lazily creates a real per-agency row for AGENCY/PRODUCER but always forces TELEMARKETER to the platform-wide (agencyId: null) row', async () => {
  const agencyConfig = await getActiveWeightConfig('AGENCY', agencyXId);
  assert.equal(agencyConfig.agencyId, agencyXId);
  assert.deepEqual(agencyConfig.weights, DEFAULT_WEIGHTS.AGENCY);

  const tmConfig = await getActiveWeightConfig('TELEMARKETER', agencyXId);
  assert.equal(tmConfig.agencyId, null, 'TELEMARKETER must never be scoped to an agency, even when one is passed');
});

test('updateWeightConfigForAgency validates role, key set, range, and the sum-to-100 invariant', async () => {
  await assert.rejects(() => updateWeightConfigForAgency('TELEMARKETER', agencyXId, { leadQuality: 60, downstreamQuality: 40 }), /NOT_EDITABLE|platform-wide/);
  await assert.rejects(() => updateWeightConfigForAgency('AGENCY', agencyXId, { responseSpeed: 50, funnelHealth: 50 }), /must include exactly/);
  await assert.rejects(() => updateWeightConfigForAgency('AGENCY', agencyXId, { responseSpeed: 50, funnelHealth: 30, teamCallQuality: 30 }), /sum to 100/);
  await assert.rejects(() => updateWeightConfigForAgency('AGENCY', agencyXId, { responseSpeed: -5, funnelHealth: 65, teamCallQuality: 40 }), /between 0 and 100/);
});

test('an agency\'s own custom AGENCY/PRODUCER weights never leak into or get overwritten by another agency\'s config', async () => {
  await updateWeightConfigForAgency('AGENCY', agencyXId, { responseSpeed: 70, funnelHealth: 20, teamCallQuality: 10 });
  await updateWeightConfigForAgency('PRODUCER', agencyXId, { responsiveness: 70, pipelineDiscipline: 10, conversion: 10, callQuality: 10 });

  const xConfigs = await listWeightConfigsForAgency(agencyXId);
  const yConfigs = await listWeightConfigsForAgency(agencyYId);

  assert.deepEqual(xConfigs.AGENCY.weights, { responseSpeed: 70, funnelHealth: 20, teamCallQuality: 10 });
  assert.deepEqual(xConfigs.PRODUCER.weights, { responsiveness: 70, pipelineDiscipline: 10, conversion: 10, callQuality: 10 });
  // Agency Y, never customized, still sees the untouched platform default.
  assert.deepEqual(yConfigs.AGENCY.weights, DEFAULT_WEIGHTS.AGENCY);
  assert.deepEqual(yConfigs.PRODUCER.weights, DEFAULT_WEIGHTS.PRODUCER);
  // Telemarketer is identical and platform-wide for both — the one role
  // that was never meant to be agency-configurable.
  assert.deepEqual(xConfigs.TELEMARKETER.weights, yConfigs.TELEMARKETER.weights);
});

test('computeAgencyScore actually applies this agency\'s own custom weights, not the platform default', async () => {
  // Weighted entirely onto responseSpeed (100) for agency X — confirms the
  // real computed score changes when the config does, not just that the
  // stored row looks right.
  await updateWeightConfigForAgency('AGENCY', agencyXId, { responseSpeed: 100, funnelHealth: 0, teamCallQuality: 0 });
  const snapshot = await computeAgencyScore(agencyXId);
  assert.ok(snapshot);
  const responseSpeed = snapshot.components.find((c) => c.key === 'responseSpeed');
  assert.ok(responseSpeed);
  assert.equal(responseSpeed.normalizedWeight, 100);
  // funnelHealth still has real sample data (the SOLD lead) so it's
  // reported as a component with weight 0, not excluded for lack of data.
  const funnelHealth = snapshot.components.find((c) => c.key === 'funnelHealth');
  assert.ok(funnelHealth);
  assert.equal(funnelHealth.weight, 0);
});

test('computeProducerScore resolves the producer\'s OWN agency\'s custom weight config automatically', async () => {
  await updateWeightConfigForAgency('PRODUCER', agencyXId, { responsiveness: 100, pipelineDiscipline: 0, conversion: 0, callQuality: 0 });
  const snapshot = await computeProducerScore(producerXId);
  assert.ok(snapshot);
  const responsiveness = snapshot.components.find((c) => c.key === 'responsiveness');
  assert.ok(responsiveness);
  assert.equal(responsiveness.normalizedWeight, 100);
});
