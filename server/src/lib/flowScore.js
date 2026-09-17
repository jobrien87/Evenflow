// Flow Score — every component below is computed from real rows already in
// this schema (leads, tasks, transfers, call analyses). A component with
// zero underlying data points is EXCLUDED (remaining weights renormalize to
// still sum to 100), never defaulted to some invented number — same rule
// `lib/financialCalc.js` already uses for margin/ROI. A component with 1-2
// data points is included but flagged `lowConfidence` per the spec's own
// "one scored call shouldn't determine your whole score" requirement.

const { prisma } = require('./db');

const MIN_CONFIDENT_SAMPLE = 3;

const DEFAULT_WEIGHTS = {
  PRODUCER: { responsiveness: 25, pipelineDiscipline: 20, conversion: 35, callQuality: 20 },
  TELEMARKETER: { qualificationRate: 25, routingSuccessRate: 25, downstreamQuality: 50 },
  AGENCY: { responseSpeed: 20, funnelHealth: 35, transferPerformance: 20, teamCallQuality: 25 },
};

async function getActiveWeightConfig(role) {
  const existing = await prisma.flowScoreWeightConfig.findFirst({ where: { role, isActive: true } });
  if (existing) return existing;
  return prisma.flowScoreWeightConfig.create({
    data: { role, version: 1, weights: DEFAULT_WEIGHTS[role], isActive: true },
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

async function saveSnapshot({ subjectType, subjectId, role, rawComponents }) {
  const weightConfig = await getActiveWeightConfig(role);
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
  const leads = await prisma.lead.findMany({
    where: { assignedToId: userId },
    select: { status: true, assignedAt: true, firstAttemptAt: true },
  });
  const attemptedLeads = leads.filter((l) => l.assignedAt && l.firstAttemptAt);
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

  return saveSnapshot({ subjectType: 'USER', subjectId: userId, role: 'PRODUCER', rawComponents });
}

// ---- TELEMARKETER ----

async function computeTelemarketerScore(userId) {
  const transfers = await prisma.transfer.findMany({
    where: { createdByTMId: userId },
    select: { status: true, disposition: true },
  });

  const qualified = transfers.filter((t) => !['LEAD_CAPTURED', 'QUALIFYING', 'NOT_QUALIFIED'].includes(t.status));
  const offered = transfers.filter(
    (t) => !['LEAD_CAPTURED', 'QUALIFYING', 'NOT_QUALIFIED', 'READY', 'ROUTING', 'NO_ELIGIBLE_DESTINATION'].includes(t.status)
  );
  const sold = transfers.filter((t) => t.disposition === 'SOLD');

  const rawComponents = {
    qualificationRate: {
      label: 'Qualification rate',
      value: pct(qualified.length, transfers.length),
      sampleSize: transfers.length,
    },
    routingSuccessRate: {
      label: 'Routing success rate',
      value: pct(offered.length, qualified.length),
      sampleSize: qualified.length,
    },
    downstreamQuality: {
      label: 'Downstream sale rate (quality over quantity)',
      value: pct(sold.length, transfers.length),
      sampleSize: transfers.length,
    },
  };

  return saveSnapshot({ subjectType: 'USER', subjectId: userId, role: 'TELEMARKETER', rawComponents });
}

// ---- AGENCY ----

async function computeAgencyScore(agencyId) {
  const leads = await prisma.lead.findMany({
    where: { agencyId },
    select: { status: true, assignedAt: true, firstAttemptAt: true },
  });
  const attemptedLeads = leads.filter((l) => l.assignedAt && l.firstAttemptAt);
  const fastAttempts = attemptedLeads.filter(
    (l) => l.firstAttemptAt.getTime() - l.assignedAt.getTime() <= 60 * 60 * 1000
  );
  const soldLeads = leads.filter((l) => l.status === 'SOLD');

  const transfers = await prisma.transfer.findMany({
    where: { agencyId },
    select: { status: true },
  });
  const offeredTransfers = transfers.filter((t) => t.status !== 'NO_ELIGIBLE_DESTINATION');
  const acceptedOrBeyond = transfers.filter(
    (t) => !['LEAD_CAPTURED', 'QUALIFYING', 'NOT_QUALIFIED', 'READY', 'ROUTING', 'NO_ELIGIBLE_DESTINATION', 'OFFERED', 'REJECTED', 'MISSED', 'EXPIRED'].includes(t.status)
  );

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
    transferPerformance: {
      label: 'Transfer acceptance rate',
      value: pct(acceptedOrBeyond.length, offeredTransfers.length),
      sampleSize: offeredTransfers.length,
    },
    teamCallQuality: {
      label: 'Team call quality',
      value: avgCallScore,
      sampleSize: calls.length,
    },
  };

  return saveSnapshot({ subjectType: 'AGENCY', subjectId: agencyId, role: 'AGENCY', rawComponents });
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

module.exports = {
  computeProducerScore,
  computeTelemarketerScore,
  computeAgencyScore,
  explainScore,
  getActiveWeightConfig,
};
