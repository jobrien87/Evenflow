// Flow Score — every component below is computed from real rows already in
// this schema (leads, tasks, opportunities, training assignments, HR
// attendance review, goals, call analyses). A component with zero
// underlying data points is EXCLUDED (remaining weights renormalize to
// still sum to 100), never defaulted to some invented number — same rule
// `lib/financialCalc.js` already uses for margin/ROI. A component with 1-2
// data points is included but flagged `lowConfidence` per the spec's own
// "one scored call shouldn't determine your whole score" requirement.
//
// An agency owner/manager never sets a raw 0-100 weight directly — they
// pick a LOW/MEDIUM/HIGH/VERY_HIGH tier per component ("Flow Settings"),
// and `levelsToWeights()` below converts that into the real numeric
// weights `combineComponents` consumes. The final score itself stays
// 0-100 either way; only the input method changed. `scoreToGrade()` adds
// a single, server-only A-F letter grade on top of that same 0-100 score
// — never duplicated as a second set of thresholds anywhere else.

const { prisma } = require('./db');
const { CATEGORIES, computeCoachingBreakdown } = require('./callScoring');
const { computeFunnel } = require('./funnelMetrics');

const MIN_CONFIDENT_SAMPLE = 3;

// ---- Low/Medium/High/Very High weight tiers ----

const LEVEL_POINTS = { LOW: 1, MEDIUM: 2, HIGH: 3, VERY_HIGH: 4 };

// Converts a per-component qualitative level map into real numeric weights
// that sum to EXACTLY 100 (never 99.9/100.1) via a largest-remainder-safe
// pass: every component but the last is rounded to its own share of total
// points, and the last component absorbs whatever's left — the same
// invariant the schema's own comment documents ("weights for an active
// config always sum to 100").
function levelsToWeights(levels, componentKeys) {
  const points = componentKeys.map((k) => LEVEL_POINTS[levels[k]]);
  const totalPoints = points.reduce((a, b) => a + b, 0);
  const weights = {};
  let runningTotal = 0;
  componentKeys.forEach((key, i) => {
    if (i === componentKeys.length - 1) {
      weights[key] = Math.round((100 - runningTotal) * 10) / 10;
    } else {
      const w = Math.round(((points[i] / totalPoints) * 100) * 10) / 10;
      weights[key] = w;
      runningTotal += w;
    }
  });
  return weights;
}

// DEFAULT_LEVELS is the single source of truth per role — DEFAULT_WEIGHTS
// is always DERIVED from it below, so the stated default percentage can
// never drift from the stated default level.
const DEFAULT_LEVELS = {
  PRODUCER: {
    conversion: 'VERY_HIGH',
    responsiveness: 'HIGH',
    objectionClosing: 'HIGH',
    pipelineDiscipline: 'MEDIUM',
    openingDiscovery: 'MEDIUM',
    crossSellFollowThrough: 'MEDIUM',
    goalPace: 'MEDIUM',
    pipelineControl: 'LOW',
    moshpitClaimSpeed: 'LOW',
    trainingCompliance: 'LOW',
    attendanceCompliance: 'LOW',
  },
  // Rebuilt for the Yield Transfers rebuild: a Telemarketer's submissions
  // are now real Lead rows (source: 'telemarketer'), not Transfers — the
  // old routing/offer step no longer exists, so there's no analog for
  // the old routingSuccessRate component. Both kept at VERY_HIGH to
  // preserve the exact 50/50 split this role has always used.
  TELEMARKETER: { leadQuality: 'VERY_HIGH', downstreamQuality: 'VERY_HIGH' },
  AGENCY: {
    funnelHealth: 'VERY_HIGH',
    responseSpeed: 'HIGH',
    objectionClosing: 'HIGH',
    contactRate: 'MEDIUM',
    quoteRate: 'MEDIUM',
    goalPace: 'MEDIUM',
    openingDiscovery: 'LOW',
    pipelineControl: 'LOW',
  },
};

// Sorted key order matches updateWeightConfigForAgency's own normalization
// exactly, so a freshly-created default config and a config a human saves
// right back unchanged (no real edits) always derive byte-identical
// weights — the alphabetical ordering itself is arbitrary, but using ONE
// canonical order everywhere is what keeps the last component's rounding
// remainder landing on the same key every time.
const DEFAULT_WEIGHTS = Object.keys(DEFAULT_LEVELS).reduce((acc, role) => {
  const keys = Object.keys(DEFAULT_LEVELS[role]).sort();
  acc[role] = levelsToWeights(DEFAULT_LEVELS[role], keys);
  return acc;
}, {});

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
    openingDiscovery: 'Call quality — opening & discovery',
    objectionClosing: 'Call quality — objections & closing',
    pipelineControl: 'Call quality — follow-up & control',
    crossSellFollowThrough: 'Cross-sell / winback follow-through',
    moshpitClaimSpeed: 'Moshpit claim speed',
    trainingCompliance: 'Training compliance',
    attendanceCompliance: 'Attendance compliance',
    goalPace: 'Goal pace',
  },
  TELEMARKETER: {
    leadQuality: 'Lead quality (real contacts, not bad numbers or duplicates)',
    downstreamQuality: 'Downstream sale rate (quality over quantity)',
  },
  AGENCY: {
    responseSpeed: 'Team speed to first attempt',
    funnelHealth: 'Lead-to-sale conversion',
    openingDiscovery: 'Call quality — opening & discovery',
    objectionClosing: 'Call quality — objections & closing',
    pipelineControl: 'Call quality — follow-up & control',
    contactRate: 'Contact rate',
    quoteRate: 'Quote rate',
    goalPace: 'Goal pace',
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
  const defaultKeys = Object.keys(DEFAULT_LEVELS[role]).sort().join(',');

  // A config created under an OLD component shape (e.g. before this round
  // added trainingCompliance/attendanceCompliance/goalPace, or before the
  // Yield Transfers rebuild retired routingSuccessRate) would otherwise
  // stay active forever — combineComponents' `weights[key] || 0` fallback
  // would silently zero out every real new component. Retiring/renaming/
  // adding a component is a real weight-config change, not a data
  // problem, so it gets the same version bump a manual re-tune would:
  // deactivate the stale row and create a fresh one from the real
  // defaults — `levels` is compared here (not `weights`), since `levels`
  // is the real, human-facing shape and `weights` is always derived from
  // it; a `{}`-default row from the schema migration itself never matches
  // any role's real key set, so it's replaced the same way.
  if (existing) {
    const existingKeys = Object.keys(existing.levels || {}).sort().join(',');
    if (existingKeys === defaultKeys) return existing;
    await prisma.flowScoreWeightConfig.update({ where: { id: existing.id }, data: { isActive: false } });
    return prisma.flowScoreWeightConfig.create({
      data: {
        role, agencyId: scopedAgencyId, version: existing.version + 1,
        levels: DEFAULT_LEVELS[role], weights: DEFAULT_WEIGHTS[role], isActive: true,
      },
    });
  }

  return prisma.flowScoreWeightConfig.create({
    data: { role, agencyId: scopedAgencyId, version: 1, levels: DEFAULT_LEVELS[role], weights: DEFAULT_WEIGHTS[role], isActive: true },
  });
}

// An Agency Owner/Manager's real, current weight setup for every role
// Flow Score tracks — used by the "Flow Settings" UI to show today's
// active levels/weights (agency-customized or still the default)
// alongside each component's label, and whether this role is actually
// editable from an agency's own settings (TELEMARKETER is platform-wide,
// shown read-only).
async function listWeightConfigsForAgency(agencyId) {
  const roles = Object.keys(DEFAULT_LEVELS);
  const configs = await Promise.all(roles.map((role) => getActiveWeightConfig(role, agencyId)));
  return roles.reduce((acc, role, i) => {
    acc[role] = {
      role,
      levels: configs[i].levels,
      weights: configs[i].weights,
      version: configs[i].version,
      editable: role !== 'TELEMARKETER',
      labels: COMPONENT_LABELS[role],
    };
    return acc;
  }, {});
}

const VALID_LEVELS = new Set(Object.keys(LEVEL_POINTS));

// Agency Owner/Manager tuning a role's weights via a LOW/MEDIUM/HIGH/
// VERY_HIGH pick per component. Only PRODUCER/AGENCY are ever editable
// this way — TELEMARKETER is platform-wide and has no agency to scope a
// custom config to. Every component key must be present (the real,
// current scored component set — never a stale or invented key) and
// every value must be one of the 4 valid level strings; the real numeric
// weights are always derived via levelsToWeights(), never accepted
// directly, so there is no "must sum to 100" validation to fail here —
// every valid combination of 4-level picks is automatically valid.
async function updateWeightConfigForAgency(role, agencyId, levels) {
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
  const expectedKeys = Object.keys(DEFAULT_LEVELS[role] || {}).sort();
  if (expectedKeys.length === 0) {
    const err = new Error(`Unknown Flow Score role: ${role}`);
    err.code = 'VALIDATION';
    throw err;
  }
  const givenKeys = Object.keys(levels || {}).sort();
  if (givenKeys.join(',') !== expectedKeys.join(',')) {
    const err = new Error(`Levels must include exactly: ${expectedKeys.join(', ')}.`);
    err.code = 'VALIDATION';
    throw err;
  }
  for (const key of expectedKeys) {
    if (!VALID_LEVELS.has(levels[key])) {
      const err = new Error(`${key} must be one of LOW, MEDIUM, HIGH, VERY_HIGH.`);
      err.code = 'VALIDATION';
      throw err;
    }
  }

  const normalizedLevels = expectedKeys.reduce((acc, key) => ({ ...acc, [key]: levels[key] }), {});
  const normalizedWeights = levelsToWeights(normalizedLevels, expectedKeys);

  const current = await prisma.flowScoreWeightConfig.findFirst({ where: { role, agencyId, isActive: true } });

  if (current) {
    await prisma.flowScoreWeightConfig.update({ where: { id: current.id }, data: { isActive: false } });
    return prisma.flowScoreWeightConfig.create({
      data: { role, agencyId, version: current.version + 1, levels: normalizedLevels, weights: normalizedWeights, isActive: true },
    });
  }
  return prisma.flowScoreWeightConfig.create({
    data: { role, agencyId, version: 1, levels: normalizedLevels, weights: normalizedWeights, isActive: true },
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

// ---- Call scoring, combined into 3 "moderately granular" groups ----

const CALL_SCORING_GROUPS = {
  openingDiscovery: ['Opening & Rapport', 'Discovery & Needs Analysis'],
  objectionClosing: ['Objection Handling', 'Closing Techniques'],
  pipelineControl: ['Follow-Up & Pipeline', 'Call Control'],
};

// Combines callScoring.js's 6 real drill categories into 3 groups — not
// the full 6-category split, not one blended number. Each group's value
// is the weighted average (by the real CATEGORIES drill-count weight) of
// whichever of its sub-categories actually have data; a sub-category with
// no data is simply left out of the average, never dragging a real score
// toward zero for missing data. sampleSize is the max of its
// sub-categories' own sample sizes (both come from the same scored-calls
// set, so summing would double-count). A group with zero data in both its
// sub-categories is excluded entirely, same as any other zero-sample
// component.
function combineCallScoringGroups(categoryBreakdown) {
  const byTitle = new Map((categoryBreakdown || []).map((c) => [c.category, c]));
  const weightByTitle = new Map(CATEGORIES.map((c) => [c.title, c.weight]));
  const result = {};
  for (const [groupKey, titles] of Object.entries(CALL_SCORING_GROUPS)) {
    const parts = titles
      .map((title) => ({ row: byTitle.get(title), weight: weightByTitle.get(title) || 0 }))
      .filter((p) => p.row);
    if (parts.length === 0) {
      result[groupKey] = { value: null, sampleSize: 0 };
      continue;
    }
    const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
    const value = totalWeight > 0
      ? Math.round(parts.reduce((sum, p) => sum + p.row.averageScore * p.weight, 0) / totalWeight)
      : Math.round(parts.reduce((sum, p) => sum + p.row.averageScore, 0) / parts.length);
    const sampleSize = Math.max(...parts.map((p) => p.row.sampleSize));
    result[groupKey] = { value, sampleSize };
  }
  return result;
}

// ---- PRODUCER ----

// Resolved statuses — a Winback/Cross-Sell Opportunity has actually been
// decided one way or another (matches pipelineDiscipline's own "only
// decided things count" rule). SNOOZED/CONTACTED/etc. haven't been
// decided yet and don't count toward the rate either way.
const RESOLVED_OPPORTUNITY_STATUSES = ['WON', 'DECLINED', 'INELIGIBLE'];

async function computeProducerScore(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { agencyId: true } });
  const agencyId = user?.agencyId || null;

  const leads = await prisma.lead.findMany({
    where: { assignedToId: userId },
    select: {
      status: true, assignedAt: true, firstAttemptAt: true, vendorId: true,
      moshpitEligible: true, isLiveTransfer: true, receivedAt: true,
    },
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

  // Moshpit claim speed — a pool-claim analog of the vendor-API
  // responsiveness component above; the two never overlap (a vendor-API
  // lead is never Moshpit-eligible).
  const moshpitLeads = leads.filter((l) => (l.moshpitEligible || l.isLiveTransfer) && l.assignedAt && l.receivedAt);
  const fastClaims = moshpitLeads.filter(
    (l) => l.assignedAt.getTime() - l.receivedAt.getTime() <= 15 * 60 * 1000
  );

  const [breakdown, opportunities, trainingAssignments, employeeProfile, goals] = await Promise.all([
    computeCoachingBreakdown({ prisma, agencyId, userId, from: new Date(0), to: new Date() }),
    prisma.opportunity.findMany({ where: { assignedToId: userId }, select: { status: true } }),
    prisma.trainingAssignment.findMany({ where: { userId }, select: { status: true, dueAt: true } }),
    prisma.hrEmployeeProfile.findUnique({ where: { userId }, select: { id: true } }),
    // Required here, lazily, instead of at module top — runningReport.js
    // itself requires flowScore.js (for explainScore), so a top-level
    // require here would create a load-order-dependent circular import.
    agencyId ? require('./runningReport').goalsWithProgress({ agencyId, userId }) : Promise.resolve([]),
  ]);
  const callGroups = combineCallScoringGroups(breakdown.categoryBreakdown);

  const resolvedOpportunities = opportunities.filter((o) => RESOLVED_OPPORTUNITY_STATUSES.includes(o.status));
  const wonOpportunities = resolvedOpportunities.filter((o) => o.status === 'WON');

  // Only assignments whose due date has actually passed are "decided" —
  // a still-pending assignment with a future due date doesn't count yet.
  const decidedTraining = trainingAssignments.filter((a) => a.dueAt && a.dueAt < now);
  const completedTraining = decidedTraining.filter((a) => a.status === 'COMPLETED');

  // Only RESOLVED_EXCUSED/RESOLVED_UNEXCUSED exceptions count — OPEN/
  // UNDER_REVIEW haven't been judged yet. This measures how attendance
  // problems were resolved, not overall punctuality: a producer with a
  // perfectly clean record and one who's simply never had an HR review
  // both show "no data" (sampleSize 0, excluded) — inventing a
  // punctuality rate from incomplete scheduling data would violate this
  // system's own no-fabrication rule.
  let resolvedAttendance = [];
  if (employeeProfile) {
    resolvedAttendance = await prisma.hrAttendanceException.findMany({
      where: { employeeProfileId: employeeProfile.id, status: { in: ['RESOLVED_EXCUSED', 'RESOLVED_UNEXCUSED'] } },
      select: { status: true },
    });
  }
  const excusedAttendance = resolvedAttendance.filter((a) => a.status === 'RESOLVED_EXCUSED');

  // Average of each currently-active individual goal's progress, each
  // capped at 100 before averaging (over-hitting one goal shouldn't push
  // the component past 100). Zero active goals = excluded.
  const ratedGoals = goals.filter((g) => g.progressPercent !== null);
  const avgGoalPace = ratedGoals.length > 0
    ? Math.round((ratedGoals.reduce((sum, g) => sum + Math.min(g.progressPercent, 100), 0) / ratedGoals.length) * 10) / 10
    : null;

  const rawComponents = {
    responsiveness: {
      label: COMPONENT_LABELS.PRODUCER.responsiveness,
      value: pct(fastAttempts.length, attemptedLeads.length),
      sampleSize: attemptedLeads.length,
    },
    pipelineDiscipline: {
      label: COMPONENT_LABELS.PRODUCER.pipelineDiscipline,
      value: pct(onTimeTasks.length, decidedTasks.length),
      sampleSize: decidedTasks.length,
    },
    conversion: {
      label: COMPONENT_LABELS.PRODUCER.conversion,
      value: pct(soldLeads.length, leads.length),
      sampleSize: leads.length,
    },
    openingDiscovery: { label: COMPONENT_LABELS.PRODUCER.openingDiscovery, ...callGroups.openingDiscovery },
    objectionClosing: { label: COMPONENT_LABELS.PRODUCER.objectionClosing, ...callGroups.objectionClosing },
    pipelineControl: { label: COMPONENT_LABELS.PRODUCER.pipelineControl, ...callGroups.pipelineControl },
    crossSellFollowThrough: {
      label: COMPONENT_LABELS.PRODUCER.crossSellFollowThrough,
      value: pct(wonOpportunities.length, resolvedOpportunities.length),
      sampleSize: resolvedOpportunities.length,
    },
    moshpitClaimSpeed: {
      label: COMPONENT_LABELS.PRODUCER.moshpitClaimSpeed,
      value: pct(fastClaims.length, moshpitLeads.length),
      sampleSize: moshpitLeads.length,
    },
    trainingCompliance: {
      label: COMPONENT_LABELS.PRODUCER.trainingCompliance,
      value: pct(completedTraining.length, decidedTraining.length),
      sampleSize: decidedTraining.length,
    },
    attendanceCompliance: {
      label: COMPONENT_LABELS.PRODUCER.attendanceCompliance,
      value: pct(excusedAttendance.length, resolvedAttendance.length),
      sampleSize: resolvedAttendance.length,
    },
    goalPace: {
      label: COMPONENT_LABELS.PRODUCER.goalPace,
      value: avgGoalPace,
      sampleSize: ratedGoals.length,
    },
  };

  return saveSnapshot({ subjectType: 'USER', subjectId: userId, role: 'PRODUCER', agencyId, rawComponents });
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

  const [breakdown, funnel, goals] = await Promise.all([
    computeCoachingBreakdown({ prisma, agencyId, userId: undefined, from: new Date(0), to: new Date() }),
    computeFunnel({ agencyId, from: new Date(0), to: new Date() }),
    // Lazily required — see the matching comment in computeProducerScore.
    require('./runningReport').goalsWithProgress({ agencyId }),
  ]);
  const callGroups = combineCallScoringGroups(breakdown.categoryBreakdown);

  const ratedGoals = goals.filter((g) => g.progressPercent !== null);
  const avgGoalPace = ratedGoals.length > 0
    ? Math.round((ratedGoals.reduce((sum, g) => sum + Math.min(g.progressPercent, 100), 0) / ratedGoals.length) * 10) / 10
    : null;

  const rawComponents = {
    responseSpeed: {
      label: COMPONENT_LABELS.AGENCY.responseSpeed,
      value: pct(fastAttempts.length, attemptedLeads.length),
      sampleSize: attemptedLeads.length,
    },
    funnelHealth: {
      label: COMPONENT_LABELS.AGENCY.funnelHealth,
      value: pct(soldLeads.length, leads.length),
      sampleSize: leads.length,
    },
    openingDiscovery: { label: COMPONENT_LABELS.AGENCY.openingDiscovery, ...callGroups.openingDiscovery },
    objectionClosing: { label: COMPONENT_LABELS.AGENCY.objectionClosing, ...callGroups.objectionClosing },
    pipelineControl: { label: COMPONENT_LABELS.AGENCY.pipelineControl, ...callGroups.pipelineControl },
    contactRate: {
      label: COMPONENT_LABELS.AGENCY.contactRate,
      value: funnel.contactRate,
      sampleSize: funnel.contactRateSampleSize,
    },
    quoteRate: {
      label: COMPONENT_LABELS.AGENCY.quoteRate,
      value: funnel.quoteRate,
      sampleSize: funnel.quoteRateSampleSize,
    },
    goalPace: {
      label: COMPONENT_LABELS.AGENCY.goalPace,
      value: avgGoalPace,
      sampleSize: ratedGoals.length,
    },
  };

  return saveSnapshot({ subjectType: 'AGENCY', subjectId: agencyId, role: 'AGENCY', agencyId, rawComponents });
}

// ---- Letter grade (A-F) ----

// Single source of truth for the A-F band — never duplicated as a second
// set of thresholds anywhere, server or client. Every client surface
// renders a grade string that always arrives via an API response field.
function scoreToGrade(score) {
  if (score === null || score === undefined) return null;
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
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
    grade: scoreToGrade(snapshot.score),
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
  scoreToGrade,
  getActiveWeightConfig,
  listWeightConfigsForAgency,
  updateWeightConfigForAgency,
  combineComponents,
  componentPlaceholders,
  COMPONENT_LABELS,
  DEFAULT_WEIGHTS,
  DEFAULT_LEVELS,
  LEVEL_POINTS,
  levelsToWeights,
};
