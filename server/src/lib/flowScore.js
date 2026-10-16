// Flow Score — every component below is computed from real rows already in
// this schema (leads, tasks, call analyses). A component with
// zero underlying data points is EXCLUDED (remaining weights renormalize to
// still sum to 100), never defaulted to some invented number — same rule
// `lib/financialCalc.js` already uses for margin/ROI. A component with 1-2
// data points is included but flagged `lowConfidence` per the spec's own
// "one scored call shouldn't determine your whole score" requirement.

const { prisma } = require('./db');

const MIN_CONFIDENT_SAMPLE = 3;

const DEFAULT_WEIGHTS = {
  PRODUCER: { responsiveness: 25, pipelineDiscipline: 20, conversion: 35, callQuality: 20 },
  // Rebuilt for the Yield Transfers rebuild: a Telemarketer's submissions
  // are now real Lead rows (source: 'telemarketer'), not Transfers — the
  // old routing/offer step no longer exists, so there's no analog for
  // the old routingSuccessRate component.
  TELEMARKETER: { leadQuality: 50, downstreamQuality: 50 },
  AGENCY: { responseSpeed: 20, funnelHealth: 45, teamCallQuality: 35 },
};

// The same component labels used inside each computeXScore's rawComponents
// below, kept here as the one static lookup a caller can use WITHOUT running
// a full computation — e.g. to show "what this score tracks" (each real
// component, honestly marked "no data yet") when no snapshot has ever been
// saved at all, rather than hiding the breakdown entirely.
const COMPONENT_LABELS = {
  PRODUCER: {
    responsiveness: 'Speed to first attempt',
    pipelineDiscipline: 'Follow-up / task discipline',
    conversion: 'Lead-to-sale conversion',
    callQuality: 'Call quality',
  },
  TELEMARKETER: {
    leadQuality: 'Lead quality (real contacts, not bad numbers or duplicates)',
    downstreamQuality: 'Downstream sale rate (quality over quantity)',
  },
  AGENCY: {
    responseSpeed: 'Team speed to first attempt',
    funnelHealth: 'Lead-to-sale conversion',
    teamCallQuality: 'Team call quality',
  },
};

// TELEMARKETER weights are platform-wide only — a Telemarketer's
// submissions span every agency they're assigned to, with no single
// agency that owns their scoring weights. PRODUCER and AGENCY are real
// per-agency rows (an Agency Owner/Manager's own "Flow Settings").
function effectiveAgencyId(role, agencyId) {
  return role === 'TELEMARKETER' ? null : agencyId || null;
}

async function getActiveWeightConfig(role, agencyId = null) {
  const scopedAgencyId = effectiveAgencyId(role, agencyId);
  const existing = await prisma.flowScoreWeightConfig.findFirst({
    where: { role, agencyId: scopedAgencyId, isActive: true },
  });
  const defaultKeys = Object.keys(DEFAULT_WEIGHTS[role]).sort().join(',');

  // A config created under an OLD DEFAULT_WEIGHTS shape (e.g. before the
  // Yield Transfers rebuild retired routingSuccessRate) would otherwise
  // stay active forever — combineComponents' `weights[key] || 0` fallback
  // would silently zero out every real new component. Retiring/renaming a
  // component is a real weight-config change, not a data problem, so it
  // gets the same version bump a manual re-tune would: deactivate the
  // stale row and create a fresh active one.
  if (existing) {
    const existingKeys = Object.keys(existing.weights).sort().join(',');
    if (existingKeys === defaultKeys) return existing;
    await prisma.flowScoreWeightConfig.update({ where: { id: existing.id }, data: { isActive: false } });
    return prisma.flowScoreWeightConfig.create({
      data: { role, agencyId: scopedAgencyId, version: existing.version + 1, weights: DEFAULT_WEIGHTS[role], isActive: true },
    });
  }

  return prisma.flowScoreWeightConfig.create({
    data: { role, agencyId: scopedAgencyId, version: 1, weights: DEFAULT_WEIGHTS[role], isActive: true },
  });
}

// An Agency Owner/Manager's real, current weight setup for every role
// Flow Score tracks — used by the "Flow Settings" UI to show today's
// active weights (agency-customized or still the default) alongside each
// component's label, and whether this role is actually editable from an
// agency's own settings (TELEMARKETER is platform-wide, shown read-only).
async function listWeightConfigsForAgency(agencyId) {
  const roles = Object.keys(DEFAULT_WEIGHTS);
  const configs = await Promise.all(roles.map((role) => getActiveWeightConfig(role, agencyId)));
  return roles.reduce((acc, role, i) => {
    acc[role] = {
      role,
      weights: configs[i].weights,
      version: configs[i].version,
      editable: role !== 'TELEMARKETER',
      labels: COMPONENT_LABELS[role],
    };
    return acc;
  }, {});
}

// Agency Owner/Manager tuning a role's weights. Only PRODUCER/AGENCY are
// ever editable this way — TELEMARKETER is platform-wide and has no
// agency to scope a custom config to. Every weight must be a finite
// number 0-100, the key set must exactly match today's real scored
// components (never a stale or invented key), and the set must sum to
// 100 — the same invariant the schema itself documents and
// combineComponents relies on.
async function updateWeightConfigForAgency(role, agencyId, weights) {
  if (role === 'TELEMARKETER') {
    const err = new Error('Telemarketer scoring weights are platform-wide and cannot be set per agency.');
    err.code = 'NOT_EDITABLE';
    throw err;
  }
  if (!agencyId) {
    const err = new Error('agencyId is required.');
    err.code = 'VALIDATION';
    throw err;
  }
  const expectedKeys = Object.keys(DEFAULT_WEIGHTS[role] || {}).sort();
  if (expectedKeys.length === 0) {
    const err = new Error(`Unknown Flow Score role: ${role}`);
    err.code = 'VALIDATION';
    throw err;
  }
  const givenKeys = Object.keys(weights || {}).sort();
  if (givenKeys.join(',') !== expectedKeys.join(',')) {
    const err = new Error(`Weights must include exactly: ${expectedKeys.join(', ')}.`);
    err.code = 'VALIDATION';
    throw err;
  }
  let sum = 0;
  for (const key of expectedKeys) {
    const value = weights[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      const err = new Error(`${key} must be a number between 0 and 100.`);
      err.code = 'VALIDATION';
      throw err;
    }
    sum += value;
  }
  if (Math.round(sum) !== 100) {
    const err = new Error(`Weights must sum to 100 (currently ${sum}).`);
    err.code = 'VALIDATION';
    throw err;
  }

  const current = await prisma.flowScoreWeightConfig.findFirst({ where: { role, agencyId, isActive: true } });
  const normalizedWeights = expectedKeys.reduce((acc, key) => ({ ...acc, [key]: weights[key] }), {});

  if (current) {
    await prisma.flowScoreWeightConfig.update({ where: { id: current.id }, data: { isActive: false } });
    return prisma.flowScoreWeightConfig.create({
      data: { role, agencyId, version: current.version + 1, weights: normalizedWeights, isActive: true },
    });
  }
  return prisma.flowScoreWeightConfig.create({
    data: { role, agencyId, version: 1, weights: normalizedWeights, isActive: true },
  });
}

function pct(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

// Combines raw component values (0-100 each, or null if no data) with the
// active weight config into a final score, excluding zero-sample components
// and renormalizing the rest, exactly as documented in the schema comment.
function combineComponents(rawComponents, weights) {
  const components = [];
  const excludedComponents = [];

  for (const [key, raw] of Object.entries(rawComponents)) {
    const weight = weights[key] || 0;
    if (raw.sampleSize === 0 || raw.value === null) {
      excludedComponents.push({ key, label: raw.label, reason: 'INSUFFICIENT_DATA', sampleSize: raw.sampleSize });
      continue;
    }
    components.push({
      key,
      label: raw.label,
      value: raw.value,
      weight,
      sampleSize: raw.sampleSize,
      lowConfidence: raw.sampleSize < MIN_CONFIDENT_SAMPLE,
    });
  }

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight === 0) {
    return { score: null, components, excludedComponents };
  }

  let score = 0;
  for (const c of components) {
    const normalizedWeight = (c.weight / totalWeight) * 100;
    const contribution = Math.round(((c.value * normalizedWeight) / 100) * 10) / 10;
    c.normalizedWeight = Math.round(normalizedWeight * 10) / 10;
    c.contribution = contribution;
    score += contribution;
  }

  return { score: Math.round(score), components, excludedComponents };
}

async function saveSnapshot({ subjectType, subjectId, role, agencyId = null, rawComponents }) {
  const weightConfig = await getActiveWeightConfig(role, agencyId);
  const { score, components, excludedComponents } = combineComponents(rawComponents, weightConfig.weights);

  // No component had any real data at all — there is genuinely nothing to
  // score yet. Don't persist a meaningless zero row; callers see this as
  // "no snapshot exists" (the honest empty state), exactly like a brand
  // new user who's never touched anything.
  if (score === null) return null;

  return prisma.flowScoreSnapshot.create({
    data: {
      subjectType,
      subjectId,
      score,
      components,
      excludedComponents,
      weightConfigId: weightConfig.id,
    },
  });
}

// ---- PRODUCER ----

async function computeProducerScore(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { agencyId: true } });
  const leads = await prisma.lead.findMany({
    where: { assignedToId: userId },
    select: { status: true, assignedAt: true, firstAttemptAt: true, vendorId: true },
  });
  // Speed-to-first-attempt is a real-time-vendor-intake SLA — only leads
  // that actually came through the authenticated vendor API carry a
  // reliable, non-user-editable receipt timestamp worth measuring
  // response speed against. Conversion/other components below stay
  // unfiltered (ordinary CRM activity, from any intake source).
  const attemptedLeads = leads.filter((l) => l.vendorId && l.assignedAt && l.firstAttemptAt);
  const fastAttempts = attemptedLeads.filter(
    (l) => l.firstAttemptAt.getTime() - l.assignedAt.getTime() <= 60 * 60 * 1000
  );

  const tasks = await prisma.task.findMany({
    where: { assignedToId: userId },
    select: { status: true, dueAt: true, completedAt: true },
  });
  const now = new Date();
  const decidedTasks = tasks.filter((t) => t.status === 'COMPLETED' || (t.dueAt && t.dueAt < now));
  const onTimeTasks = decidedTasks.filter(
    (t) => t.status === 'COMPLETED' && (!t.dueAt || t.completedAt <= t.dueAt)
  );

  const soldLeads = leads.filter((l) => l.status === 'SOLD');

  const calls = await prisma.callAnalysis.findMany({
    where: { call: { uploadedById: userId } },
    select: { overallScore: true },
  });
  const avgCallScore =
    calls.length > 0 ? calls.reduce((sum, c) => sum + c.overallScore, 0) / calls.length : null;

  const rawComponents = {
    responsiveness: {
      label: 'Speed to first attempt',
      value: pct(fastAttempts.length, attemptedLeads.length),
      sampleSize: attemptedLeads.length,
    },
    pipelineDiscipline: {
      label: 'Follow-up / task discipline',
      value: pct(onTimeTasks.length, decidedTasks.length),
      sampleSize: decidedTasks.length,
    },
    conversion: {
      label: 'Lead-to-sale conversion',
      value: pct(soldLeads.length, leads.length),
      sampleSize: leads.length,
    },
    callQuality: {
      label: 'Call quality',
      value: avgCallScore,
      sampleSize: calls.length,
    },
  };

  return saveSnapshot({ subjectType: 'USER', subjectId: userId, role: 'PRODUCER', agencyId: user?.agencyId || null, rawComponents });
}

// ---- TELEMARKETER ----

const LEAD_QUALITY_FAILURES = ['BAD_CONTACT', 'DUPLICATE', 'DO_NOT_CONTACT'];

async function computeTelemarketerScore(userId) {
  const leads = await prisma.lead.findMany({
    where: { createdById: userId, source: 'telemarketer' },
    select: { status: true },
  });

  const goodLeads = leads.filter((l) => !LEAD_QUALITY_FAILURES.includes(l.status));
  const sold = leads.filter((l) => l.status === 'SOLD');

  const rawComponents = {
    leadQuality: {
      label: 'Lead quality (real contacts, not bad numbers or duplicates)',
      value: pct(goodLeads.length, leads.length),
      sampleSize: leads.length,
    },
    downstreamQuality: {
      label: 'Downstream sale rate (quality over quantity)',
      value: pct(sold.length, leads.length),
      sampleSize: leads.length,
    },
  };

  return saveSnapshot({ subjectType: 'USER', subjectId: userId, role: 'TELEMARKETER', rawComponents });
}

// ---- AGENCY ----

async function computeAgencyScore(agencyId) {
  const leads = await prisma.lead.findMany({
    where: { agencyId },
    select: { status: true, assignedAt: true, firstAttemptAt: true, vendorId: true },
  });
  // Same vendor-API-only gate as computeProducerScore's responsiveness
  // component — team speed-to-first-attempt only measures real vendor
  // intake, not bulk-upload/manual/telemarketer leads.
  const attemptedLeads = leads.filter((l) => l.vendorId && l.assignedAt && l.firstAttemptAt);
  const fastAttempts = attemptedLeads.filter(
    (l) => l.firstAttemptAt.getTime() - l.assignedAt.getTime() <= 60 * 60 * 1000
  );
  const soldLeads = leads.filter((l) => l.status === 'SOLD');

  const calls = await prisma.callAnalysis.findMany({
    where: { call: { agencyId } },
    select: { overallScore: true },
  });
  const avgCallScore =
    calls.length > 0 ? calls.reduce((sum, c) => sum + c.overallScore, 0) / calls.length : null;

  const rawComponents = {
    responseSpeed: {
      label: 'Team speed to first attempt',
      value: pct(fastAttempts.length, attemptedLeads.length),
      sampleSize: attemptedLeads.length,
    },
    funnelHealth: {
      label: 'Lead-to-sale conversion',
      value: pct(soldLeads.length, leads.length),
      sampleSize: leads.length,
    },
    teamCallQuality: {
      label: 'Team call quality',
      value: avgCallScore,
      sampleSize: calls.length,
    },
  };

  return saveSnapshot({ subjectType: 'AGENCY', subjectId: agencyId, role: 'AGENCY', agencyId, rawComponents });
}

// Turns a stored snapshot's components into "strongest area" / "biggest
// opportunity" — ranked by each component's own raw value (0-100), not by
// a deviation from some baseline. A real "+3.0 vs. last period" style
// explanation needs a historical/peer comparison this phase doesn't build
// yet (that's Phase D's Running Report, once there's snapshot history to
// compare against) — showing a fake delta now would be exactly the kind of
// invented number this whole system is built to avoid.
//
// A component only counts as an "opportunity" if it's actually below a
// real improvement threshold — a component sitting at 100% is not an
// opportunity just because it happens to be the lowest of two great
// numbers, and the two lists never share a component.
const OPPORTUNITY_THRESHOLD = 80;

function explainScore(snapshot) {
  const components = [...(Array.isArray(snapshot.components) ? snapshot.components : [])].sort(
    (a, b) => b.value - a.value
  );

  // Opportunities are decided first (anything genuinely below threshold),
  // so a real weak spot never gets swallowed into "strongest" just because
  // there happen to be few total components.
  const biggestOpportunities = components
    .filter((c) => c.value < OPPORTUNITY_THRESHOLD)
    .sort((a, b) => a.value - b.value)
    .slice(0, 2);
  const opportunityKeys = new Set(biggestOpportunities.map((c) => c.key));
  const strongestAreas = components.filter((c) => !opportunityKeys.has(c.key)).slice(0, 2);

  return {
    score: snapshot.score,
    computedAt: snapshot.computedAt,
    strongestAreas: strongestAreas.map((c) => ({ label: c.label, value: c.value, lowConfidence: c.lowConfidence })),
    biggestOpportunities: biggestOpportunities.map((c) => ({ label: c.label, value: c.value, lowConfidence: c.lowConfidence })),
    excludedComponents: Array.isArray(snapshot.excludedComponents) ? snapshot.excludedComponents : [],
  };
}

// Turns { key: 'Label' } into [{ key, label }] — the shape a "no data yet"
// placeholder UI renders in place of real components, close enough to
// explainScore's own component shape to reuse the same rendering code.
function componentPlaceholders(role) {
  return Object.entries(COMPONENT_LABELS[role] || {}).map(([key, label]) => ({ key, label }));
}

module.exports = {
  computeProducerScore,
  computeTelemarketerScore,
  computeAgencyScore,
  explainScore,
  getActiveWeightConfig,
  listWeightConfigsForAgency,
  updateWeightConfigForAgency,
  combineComponents,
  componentPlaceholders,
  COMPONENT_LABELS,
  DEFAULT_WEIGHTS,
};
