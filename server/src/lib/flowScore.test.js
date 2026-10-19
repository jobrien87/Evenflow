const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  combineComponents, explainScore, computeTelemarketerScore, computeAgencyScore, computeProducerScore,
  getActiveWeightConfig, listWeightConfigsForAgency, updateWeightConfigForAgency,
  COMPONENT_LABELS, DEFAULT_WEIGHTS, DEFAULT_LEVELS, LEVEL_POINTS, levelsToWeights, scoreToGrade,
} = require('./flowScore');
const { prisma } = require('./db');

test('COMPONENT_LABELS has exactly the same component keys as DEFAULT_WEIGHTS for every role (never drifts)', () => {
  for (const role of Object.keys(DEFAULT_WEIGHTS)) {
    const weightKeys = Object.keys(DEFAULT_WEIGHTS[role]).sort();
    const labelKeys = Object.keys(COMPONENT_LABELS[role]).sort();
    assert.deepEqual(labelKeys, weightKeys, `COMPONENT_LABELS.${role} keys must match DEFAULT_WEIGHTS.${role} keys`);
  }
});

test('levelsToWeights sums to (rounding-safe) exactly 100 for every real component count, including an uneven split', () => {
  const cases = [
    ['TELEMARKETER (2)', DEFAULT_LEVELS.TELEMARKETER],
    ['AGENCY (8)', DEFAULT_LEVELS.AGENCY],
    ['PRODUCER (11)', DEFAULT_LEVELS.PRODUCER],
    // 3-way LOW/LOW/LOW split: totalPoints=3, 100/3 doesn't divide evenly —
    // the real edge case the "last component absorbs the remainder" design
    // exists for.
    ['uneven 3-way LOW/LOW/LOW split', { a: 'LOW', b: 'LOW', c: 'LOW' }],
  ];
  for (const [label, levels] of cases) {
    const keys = Object.keys(levels);
    const weights = levelsToWeights(levels, keys);
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 100) < 0.05, `${label}: expected weights to sum to ~100, got ${sum}`);
    assert.deepEqual(Object.keys(weights).sort(), keys.sort());
  }
});

test('levelsToWeights gives a VERY_HIGH component more weight than a LOW one, proportional to LEVEL_POINTS', () => {
  const weights = levelsToWeights({ a: 'VERY_HIGH', b: 'LOW' }, ['a', 'b']);
  assert.equal(LEVEL_POINTS.VERY_HIGH, 4);
  assert.equal(LEVEL_POINTS.LOW, 1);
  assert.ok(weights.a > weights.b);
  // 4:1 ratio -> a should be 80, b should be 20 (the last key absorbs the
  // exact remainder here since 4/5*100=80 exactly).
  assert.equal(weights.a, 80);
  assert.equal(weights.b, 20);
});

test('scoreToGrade: A>=90, B>=80, C>=70, D>=60, else F; null/undefined -> null, never a fabricated letter', () => {
  assert.equal(scoreToGrade(100), 'A');
  assert.equal(scoreToGrade(90), 'A');
  assert.equal(scoreToGrade(89), 'B');
  assert.equal(scoreToGrade(80), 'B');
  assert.equal(scoreToGrade(79), 'C');
  assert.equal(scoreToGrade(70), 'C');
  assert.equal(scoreToGrade(69), 'D');
  assert.equal(scoreToGrade(60), 'D');
  assert.equal(scoreToGrade(59), 'F');
  assert.equal(scoreToGrade(0), 'F');
  assert.equal(scoreToGrade(null), null);
  assert.equal(scoreToGrade(undefined), null);
});

test('explainScore wires grade from scoreToGrade(score) — one source of truth, never a second threshold set', () => {
  const snapshot = { score: 85, computedAt: new Date(), components: [], excludedComponents: [] };
  assert.equal(explainScore(snapshot).grade, 'B');
  assert.equal(explainScore({ ...snapshot, score: 55 }).grade, 'F');
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

// ---- Bulk/Back Catalog imports must never pollute Flow Score ----
// A 15,000-row historical or Winback/Cross-Sell-tagged upload, even one
// that got round-robin-assigned to real producers, is backfill/batch
// data — not real-time CRM work — and must never dilute conversion/
// funnelHealth the way an unfiltered "every Lead row" query would.

let bulkAgencyId, bulkProducerId, bulkUploaderId, bulkBatchId, bulkLeadIds = [];

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `FS Bulk Pollution Agency ${suffix}` } });
  bulkAgencyId = agency.id;

  const [producer, uploader] = await Promise.all([
    prisma.user.create({ data: { email: `fs-bulk-p-${suffix}@test.local`, firstName: 'Bulk', lastName: 'Producer', role: 'PRODUCER', status: 'ACTIVE', agencyId: bulkAgencyId } }),
    prisma.user.create({ data: { email: `fs-bulk-owner-${suffix}@test.local`, firstName: 'Bulk', lastName: 'Owner', role: 'AGENCY_OWNER', status: 'ACTIVE', agencyId: bulkAgencyId } }),
  ]);
  bulkProducerId = producer.id;
  bulkUploaderId = uploader.id;

  // One real, organically-worked lead: assigned, not from any import batch.
  const realCustomer = await prisma.customer.create({ data: { firstName: 'Real', lastName: 'Lead' } });
  const realLead = await prisma.lead.create({
    data: { agencyId: bulkAgencyId, customerId: realCustomer.id, assignedToId: bulkProducerId, status: 'NEW' },
  });
  bulkLeadIds.push(realLead.id);

  // A bulk-import batch of 3 leads, round-robin-assigned to the SAME
  // producer (assignedToId set, just like resolveManualAssignment would
  // do for a real upload) — these must be invisible to conversion/
  // funnelHealth despite being assigned and even SOLD.
  const batch = await prisma.leadImportBatch.create({
    data: { agencyId: bulkAgencyId, uploadedById: bulkUploaderId, totalRows: 3, created: 3, skipped: 0 },
  });
  bulkBatchId = batch.id;
  for (let i = 0; i < 3; i++) {
    const customer = await prisma.customer.create({ data: { firstName: 'Bulk', lastName: `Lead${i}` } });
    const lead = await prisma.lead.create({
      data: {
        agencyId: bulkAgencyId, customerId: customer.id, assignedToId: bulkProducerId,
        importBatchId: bulkBatchId, source: 'bulk_upload', status: i === 0 ? 'SOLD' : 'NEW',
      },
    });
    bulkLeadIds.push(lead.id);
  }
});

after(async () => {
  await prisma.flowScoreSnapshot.deleteMany({ where: { subjectType: 'USER', subjectId: bulkProducerId } });
  await prisma.flowScoreSnapshot.deleteMany({ where: { subjectType: 'AGENCY', subjectId: bulkAgencyId } });
  await prisma.lead.deleteMany({ where: { id: { in: bulkLeadIds } } });
  await prisma.leadImportBatch.deleteMany({ where: { id: bulkBatchId } });
  await prisma.user.deleteMany({ where: { id: { in: [bulkProducerId, bulkUploaderId] } } });
  await prisma.agency.delete({ where: { id: bulkAgencyId } });
});

test('computeProducerScore: conversion ignores every bulk-imported lead, even one that was round-robin-assigned and marked SOLD', async () => {
  const snapshot = await computeProducerScore(bulkProducerId);
  assert.ok(snapshot);
  const conversion = snapshot.components.find((c) => c.key === 'conversion');
  assert.ok(conversion);
  // 1, not 4 — the 3 bulk-imported leads (one of them SOLD) must be
  // completely invisible to this component.
  assert.equal(conversion.sampleSize, 1, 'only the real, non-imported lead counts toward conversion');
  assert.equal(conversion.value, 0, 'the real lead is still NEW, not SOLD, so conversion is 0% — the bulk SOLD lead must not inflate it');
});

test('computeAgencyScore: funnelHealth ignores every bulk-imported lead agency-wide', async () => {
  const snapshot = await computeAgencyScore(bulkAgencyId);
  assert.ok(snapshot);
  const funnelHealth = snapshot.components.find((c) => c.key === 'funnelHealth');
  assert.ok(funnelHealth);
  assert.equal(funnelHealth.sampleSize, 1, 'only the real, non-imported lead counts toward funnelHealth agency-wide');
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

test('updateWeightConfigForAgency validates role, key set, and level values — the old sum-to-100 numeric check is gone entirely', async () => {
  await assert.rejects(() => updateWeightConfigForAgency('TELEMARKETER', agencyXId, DEFAULT_LEVELS.TELEMARKETER), /NOT_EDITABLE|platform-wide/);
  const { funnelHealth, ...incompleteAgencyLevels } = DEFAULT_LEVELS.AGENCY;
  await assert.rejects(() => updateWeightConfigForAgency('AGENCY', agencyXId, incompleteAgencyLevels), /must include exactly/);
  await assert.rejects(() => updateWeightConfigForAgency('AGENCY', agencyXId, { ...DEFAULT_LEVELS.AGENCY, funnelHealth: 'EXTREME' }), /LOW, MEDIUM, HIGH, VERY_HIGH/);
});

test('an agency\'s own custom AGENCY/PRODUCER levels never leak into or get overwritten by another agency\'s config', async () => {
  const agencyLevels = { ...DEFAULT_LEVELS.AGENCY, responseSpeed: 'VERY_HIGH', funnelHealth: 'LOW' };
  const producerLevels = { ...DEFAULT_LEVELS.PRODUCER, responsiveness: 'VERY_HIGH', conversion: 'LOW' };
  await updateWeightConfigForAgency('AGENCY', agencyXId, agencyLevels);
  await updateWeightConfigForAgency('PRODUCER', agencyXId, producerLevels);

  const xConfigs = await listWeightConfigsForAgency(agencyXId);
  const yConfigs = await listWeightConfigsForAgency(agencyYId);

  assert.deepEqual(xConfigs.AGENCY.levels, agencyLevels);
  assert.deepEqual(xConfigs.AGENCY.weights, levelsToWeights(agencyLevels, Object.keys(agencyLevels).sort()));
  assert.deepEqual(xConfigs.PRODUCER.levels, producerLevels);
  // Agency Y, never customized, still sees the untouched platform default.
  assert.deepEqual(yConfigs.AGENCY.levels, DEFAULT_LEVELS.AGENCY);
  assert.deepEqual(yConfigs.PRODUCER.levels, DEFAULT_LEVELS.PRODUCER);
  // Telemarketer is identical and platform-wide for both — the one role
  // that was never meant to be agency-configurable.
  assert.deepEqual(xConfigs.TELEMARKETER.levels, yConfigs.TELEMARKETER.levels);
});

test('computeAgencyScore actually applies this agency\'s own custom levels/weights, not the platform default', async () => {
  // Weighted heavily onto responseSpeed (VERY_HIGH) with everything else
  // LOW — confirms the real computed score changes when the config does,
  // not just that the stored row looks right. The raw (pre-renormalized)
  // `weight` field is deterministic from the active config regardless of
  // which other components happen to have real sample data.
  const agencyLevels = {
    ...DEFAULT_LEVELS.AGENCY, responseSpeed: 'VERY_HIGH', funnelHealth: 'LOW',
    openingDiscovery: 'LOW', objectionClosing: 'LOW', pipelineControl: 'LOW',
    contactRate: 'LOW', quoteRate: 'LOW', goalPace: 'LOW',
  };
  const expectedWeights = levelsToWeights(agencyLevels, Object.keys(agencyLevels).sort());
  await updateWeightConfigForAgency('AGENCY', agencyXId, agencyLevels);
  const snapshot = await computeAgencyScore(agencyXId);
  assert.ok(snapshot);
  const responseSpeed = snapshot.components.find((c) => c.key === 'responseSpeed');
  assert.ok(responseSpeed, 'expected responseSpeed to be included (real vendor-sourced attempted lead)');
  assert.equal(responseSpeed.weight, expectedWeights.responseSpeed);
  // funnelHealth still has real sample data (the SOLD lead) so it's
  // reported as a real component at its (now much lower, LOW-tier) weight,
  // not excluded for lack of data.
  const funnelHealth = snapshot.components.find((c) => c.key === 'funnelHealth');
  assert.ok(funnelHealth);
  assert.equal(funnelHealth.weight, expectedWeights.funnelHealth);
  assert.ok(responseSpeed.weight > funnelHealth.weight, 'VERY_HIGH must outweigh LOW');
});

test('computeProducerScore resolves the producer\'s OWN agency\'s custom weight config automatically', async () => {
  const producerLevels = { ...DEFAULT_LEVELS.PRODUCER, responsiveness: 'VERY_HIGH', conversion: 'LOW' };
  const expectedWeights = levelsToWeights(producerLevels, Object.keys(producerLevels).sort());
  await updateWeightConfigForAgency('PRODUCER', agencyXId, producerLevels);
  const snapshot = await computeProducerScore(producerXId);
  assert.ok(snapshot);
  const responsiveness = snapshot.components.find((c) => c.key === 'responsiveness');
  assert.ok(responsiveness);
  assert.equal(responsiveness.weight, expectedWeights.responsiveness);
});

test('getActiveWeightConfig auto-migrates a config created under an old/incompatible component shape, deactivating the stale row', async () => {
  const staleAgency = await prisma.agency.create({ data: { name: `FS Depth Stale Agency ${suffix}` } });
  try {
    const stale = await prisma.flowScoreWeightConfig.create({
      data: {
        role: 'PRODUCER', agencyId: staleAgency.id, version: 1, isActive: true,
        // The pre-this-round PRODUCER shape — 4 keys, including the now-
        // retired `callQuality` — simulating a config saved before this
        // round's component set changed.
        levels: { responsiveness: 'HIGH', pipelineDiscipline: 'MEDIUM', conversion: 'VERY_HIGH', callQuality: 'MEDIUM' },
        weights: { responsiveness: 25, pipelineDiscipline: 20, conversion: 35, callQuality: 20 },
      },
    });
    const fresh = await getActiveWeightConfig('PRODUCER', staleAgency.id);
    assert.notEqual(fresh.id, stale.id, 'expected a brand new row, not the stale one reused');
    assert.equal(fresh.version, 2);
    assert.deepEqual(fresh.levels, DEFAULT_LEVELS.PRODUCER);
    assert.deepEqual(fresh.weights, DEFAULT_WEIGHTS.PRODUCER);

    const reloadedStale = await prisma.flowScoreWeightConfig.findUnique({ where: { id: stale.id } });
    assert.equal(reloadedStale.isActive, false, 'the old-shape row must be deactivated, not left active alongside the new one');
  } finally {
    await prisma.flowScoreWeightConfig.deleteMany({ where: { agencyId: staleAgency.id } });
    await prisma.agency.delete({ where: { id: staleAgency.id } });
  }
});

// ---- Flow Score depth: the 5 new real Producer components ----
// (crossSellFollowThrough, moshpitClaimSpeed, trainingCompliance,
// attendanceCompliance, goalPace) plus the 3-group call-quality combiner
// shared by Producer/Agency. Each component's zero-sample-excluded case is
// also covered via a second producer with none of this real data at all.

let depthAgencyId, depthProducerId, depthOtherProducerId, depthEmployeeProfileId;
let depthLeadIds = [], depthOppIds = [], depthTrainingAssignmentIds = [], depthCourseIds = [];
let depthExceptionIds = [], depthGoalId, depthCallIds = [];

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `FS Depth Agency ${suffix}` } });
  depthAgencyId = agency.id;

  const [producer, otherProducer] = await Promise.all([
    prisma.user.create({ data: { email: `fs-depth-p-${suffix}@test.local`, firstName: 'Depth', lastName: 'Producer', role: 'PRODUCER', status: 'ACTIVE', agencyId: depthAgencyId } }),
    prisma.user.create({ data: { email: `fs-depth-p2-${suffix}@test.local`, firstName: 'Depth', lastName: 'Other', role: 'PRODUCER', status: 'ACTIVE', agencyId: depthAgencyId } }),
  ]);
  depthProducerId = producer.id;
  depthOtherProducerId = otherProducer.id;

  // crossSellFollowThrough: 1 WON + 1 DECLINED (both resolved -> 50%) + 1
  // still-OPEN (not resolved, excluded from the denominator entirely).
  const customer = await prisma.customer.create({ data: { firstName: 'FS', lastName: 'Depth' } });
  const [won, declined, open] = await Promise.all([
    prisma.opportunity.create({ data: { agencyId: depthAgencyId, customerId: customer.id, type: 'CROSS_SELL', product: 'HOME', reason: 'test', assignedToId: depthProducerId, status: 'WON' } }),
    prisma.opportunity.create({ data: { agencyId: depthAgencyId, customerId: customer.id, type: 'WINBACK', product: 'AUTO', reason: 'test', assignedToId: depthProducerId, status: 'DECLINED' } }),
    prisma.opportunity.create({ data: { agencyId: depthAgencyId, customerId: customer.id, type: 'CROSS_SELL', product: 'AUTO', reason: 'test', assignedToId: depthProducerId, status: 'OPEN' } }),
  ]);
  depthOppIds = [won.id, declined.id, open.id];

  // moshpitClaimSpeed: 1 fast claim (<=15 min), 1 slow claim (>15 min).
  const now = Date.now();
  const fastLead = await prisma.lead.create({ data: { agencyId: depthAgencyId, assignedToId: depthProducerId, moshpitEligible: true, receivedAt: new Date(now - 10 * 60 * 1000), assignedAt: new Date(now), status: 'NEW' } });
  const slowLead = await prisma.lead.create({ data: { agencyId: depthAgencyId, assignedToId: depthProducerId, isLiveTransfer: true, receivedAt: new Date(now - 60 * 60 * 1000), assignedAt: new Date(now), status: 'NEW' } });
  depthLeadIds = [fastLead.id, slowLead.id];

  // trainingCompliance: 1 completed decided assignment, 1 overdue-incomplete
  // decided assignment (both due dates in the past -> 50%).
  const [course1, course2] = await Promise.all([
    prisma.trainingCourse.create({ data: { title: `FS Depth Course A ${suffix}` } }),
    prisma.trainingCourse.create({ data: { title: `FS Depth Course B ${suffix}` } }),
  ]);
  depthCourseIds = [course1.id, course2.id];
  const pastDue = new Date(now - 24 * 60 * 60 * 1000);
  const [completedAssignment, overdueAssignment] = await Promise.all([
    prisma.trainingAssignment.create({ data: { courseId: course1.id, userId: depthProducerId, dueAt: pastDue, status: 'COMPLETED', completedAt: new Date(now - 48 * 60 * 60 * 1000) } }),
    prisma.trainingAssignment.create({ data: { courseId: course2.id, userId: depthProducerId, dueAt: pastDue, status: 'ASSIGNED' } }),
  ]);
  depthTrainingAssignmentIds = [completedAssignment.id, overdueAssignment.id];

  // attendanceCompliance: 1 resolved-excused, 1 resolved-unexcused, and 1
  // still-OPEN (never counted — hasn't been judged yet).
  const employeeProfile = await prisma.hrEmployeeProfile.create({ data: { userId: depthProducerId, agencyId: depthAgencyId } });
  depthEmployeeProfileId = employeeProfile.id;
  const [excused, unexcused, openException] = await Promise.all([
    prisma.hrAttendanceException.create({ data: { employeeProfileId: depthEmployeeProfileId, agencyId: depthAgencyId, exceptionType: 'LATE_ARRIVAL', status: 'RESOLVED_EXCUSED' } }),
    prisma.hrAttendanceException.create({ data: { employeeProfileId: depthEmployeeProfileId, agencyId: depthAgencyId, exceptionType: 'MISSED_PUNCH', status: 'RESOLVED_UNEXCUSED' } }),
    prisma.hrAttendanceException.create({ data: { employeeProfileId: depthEmployeeProfileId, agencyId: depthAgencyId, exceptionType: 'LATE_ARRIVAL', status: 'OPEN' } }),
  ]);
  depthExceptionIds = [excused.id, unexcused.id, openException.id];

  // goalPace: one active goal (metric 'calls', target 10) + 2 real Call
  // rows in its period -> 20% progress.
  const periodStart = new Date(now - 24 * 60 * 60 * 1000);
  const periodEnd = new Date(now + 24 * 60 * 60 * 1000);
  const goal = await prisma.goal.create({ data: { agencyId: depthAgencyId, userId: depthProducerId, metric: 'calls', targetValue: 10, periodType: 'custom', periodStart, periodEnd } });
  depthGoalId = goal.id;
  const [call1, call2] = await Promise.all([
    prisma.call.create({ data: { agencyId: depthAgencyId, uploadedById: depthProducerId, filename: 'depth-call-1.mp3' } }),
    prisma.call.create({ data: { agencyId: depthAgencyId, uploadedById: depthProducerId, filename: 'depth-call-2.mp3' } }),
  ]);
  depthCallIds = [call1.id, call2.id];
});

after(async () => {
  await prisma.flowScoreSnapshot.deleteMany({ where: { subjectType: 'USER', subjectId: { in: [depthProducerId, depthOtherProducerId] } } });
  await prisma.flowScoreSnapshot.deleteMany({ where: { subjectType: 'AGENCY', subjectId: depthAgencyId } });
  await prisma.call.deleteMany({ where: { id: { in: depthCallIds } } });
  await prisma.goal.delete({ where: { id: depthGoalId } });
  await prisma.hrAttendanceException.deleteMany({ where: { id: { in: depthExceptionIds } } });
  await prisma.hrEmployeeProfile.delete({ where: { id: depthEmployeeProfileId } });
  await prisma.trainingAssignment.deleteMany({ where: { id: { in: depthTrainingAssignmentIds } } });
  await prisma.trainingCourse.deleteMany({ where: { id: { in: depthCourseIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: depthLeadIds } } });
  await prisma.opportunity.deleteMany({ where: { id: { in: depthOppIds } } });
  await prisma.flowScoreWeightConfig.deleteMany({ where: { agencyId: depthAgencyId } });
  await prisma.user.deleteMany({ where: { id: { in: [depthProducerId, depthOtherProducerId] } } });
  await prisma.agency.delete({ where: { id: depthAgencyId } });
});

test('computeProducerScore: crossSellFollowThrough counts only resolved Opportunities (WON/DECLINED/INELIGIBLE), excluding a still-OPEN one from the denominator', async () => {
  const snapshot = await computeProducerScore(depthProducerId);
  assert.ok(snapshot);
  const component = snapshot.components.find((c) => c.key === 'crossSellFollowThrough');
  assert.ok(component, 'expected crossSellFollowThrough to be included');
  assert.equal(component.sampleSize, 2, 'only the 2 resolved opportunities count, not the still-OPEN one');
  assert.equal(component.value, 50); // 1 of 2 resolved is WON
});

test('computeProducerScore: moshpitClaimSpeed measures assignedAt-receivedAt against the real 15-minute threshold', async () => {
  const snapshot = await computeProducerScore(depthProducerId);
  const component = snapshot.components.find((c) => c.key === 'moshpitClaimSpeed');
  assert.ok(component);
  assert.equal(component.sampleSize, 2);
  assert.equal(component.value, 50); // 1 of 2 claimed within 15 minutes
});

test('computeProducerScore: trainingCompliance only counts assignments whose due date has actually passed', async () => {
  const snapshot = await computeProducerScore(depthProducerId);
  const component = snapshot.components.find((c) => c.key === 'trainingCompliance');
  assert.ok(component);
  assert.equal(component.sampleSize, 2);
  assert.equal(component.value, 50);
});

test('computeProducerScore: attendanceCompliance only counts RESOLVED_* exceptions, never a still-OPEN one', async () => {
  const snapshot = await computeProducerScore(depthProducerId);
  const component = snapshot.components.find((c) => c.key === 'attendanceCompliance');
  assert.ok(component);
  assert.equal(component.sampleSize, 2, 'the still-OPEN exception must not count toward the denominator');
  assert.equal(component.value, 50);
});

test('computeProducerScore: goalPace averages real active-goal progress', async () => {
  const snapshot = await computeProducerScore(depthProducerId);
  const component = snapshot.components.find((c) => c.key === 'goalPace');
  assert.ok(component);
  assert.equal(component.sampleSize, 1);
  assert.equal(component.value, 20); // 2 of 10 calls = 20%
});

test('every new Producer component is EXCLUDED (never fabricated), and no snapshot at all is saved, for a producer with zero real data anywhere', async () => {
  // depthOtherProducerId has no leads/tasks/opportunities/training/
  // attendance/goals of their own at all — every component (old and new)
  // is excluded for lack of data, so the honest outcome is no snapshot.
  const snapshot = await computeProducerScore(depthOtherProducerId);
  assert.equal(snapshot, null, 'expected no snapshot to be saved when literally nothing is scoreable yet');
});

test('computeProducerScore: openingDiscovery/objectionClosing/pipelineControl group the real 6 drill categories into 3 — the old single callQuality component no longer exists', async () => {
  const call = await prisma.call.create({
    data: {
      agencyId: depthAgencyId, uploadedById: depthProducerId, filename: 'depth-drill.wav', storageKey: `depth-drill/${suffix}`,
      status: 'COMPLETE', transcript: 'test transcript',
      analysis: {
        create: {
          summary: 'test', productsDiscussed: [], objections: [], buyingSignals: [],
          missedOpportunities: [], crossSellOpportunities: [], followUpCommitments: [],
          nextSteps: [], strengths: [], coachingOpportunities: [],
          overallScore: 80,
          dimensionScores: {
            Opening: 90, Rapport: 90, Discovery: 70, 'Needs Analysis': 70, 'Question Quality': 70,
            'Objection Handling': 40, Closing: 40, 'Next-Step Clarity': 60, 'Cross-Sell Awareness': 60, Professionalism: 100,
          },
          reviewRecommended: false, aiModel: 'test',
        },
      },
    },
  });
  try {
    const snapshot = await computeProducerScore(depthProducerId);
    assert.ok(snapshot);
    assert.equal(snapshot.components.find((c) => c.key === 'callQuality'), undefined, 'the old single callQuality component must no longer exist');
    const openingDiscovery = snapshot.components.find((c) => c.key === 'openingDiscovery');
    const objectionClosing = snapshot.components.find((c) => c.key === 'objectionClosing');
    const pipelineControl = snapshot.components.find((c) => c.key === 'pipelineControl');
    assert.ok(openingDiscovery && objectionClosing && pipelineControl, 'expected all 3 call-quality groups to be included');
    // Opening & Rapport (w10, 90) + Discovery & Needs Analysis (w12, 70) -> (10*90+12*70)/22 = 79.09 -> 79
    assert.equal(openingDiscovery.value, 79);
    // Objection Handling (w20, 40) + Closing Techniques (w15, avg(40,60)=50) -> (20*40+15*50)/35 = 44.29 -> 44
    assert.equal(objectionClosing.value, 44);
    // Follow-Up & Pipeline (w10, avg(60,60)=60) + Call Control (w8, 100) -> (10*60+8*100)/18 = 77.78 -> 78
    assert.equal(pipelineControl.value, 78);

    // computeAgencyScore reuses the exact same combiner, agency-wide — with
    // only one producer's one analyzed call in this agency, the agency-wide
    // aggregate is numerically identical here.
    const agencySnapshot = await computeAgencyScore(depthAgencyId);
    assert.ok(agencySnapshot);
    assert.equal(agencySnapshot.components.find((c) => c.key === 'teamCallQuality'), undefined, 'the old teamCallQuality component must no longer exist');
    assert.equal(agencySnapshot.components.find((c) => c.key === 'openingDiscovery').value, 79);
  } finally {
    await prisma.callAnalysis.deleteMany({ where: { callId: call.id } });
    await prisma.call.deleteMany({ where: { id: call.id } });
  }
});
