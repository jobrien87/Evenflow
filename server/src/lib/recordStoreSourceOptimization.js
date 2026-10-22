// The 30-day rolling lead-source optimizer — Record Store's automatic
// "which of this lead program's sources are actually converting" sweep.
// A pure three-step pipeline per eligible subscription: compute real
// performance (lib/recordStoreSourcePerformance.js), decide whether a
// change is warranted (decideChanges, below — conservative: only ever
// DROPS an underperforming source, never adds an untested one EvenFlow
// has no data on, never drops below one source), then apply it for real
// (recordStoreProvisioning.js's updateAcceptedSources, the one place
// that actually talks to the lead exchange). Every run — whether it
// changes anything or not — leaves a RecordStoreSourceOptimization row
// and bumps lastSourceOptimizationAt, so "EvenFlow is optimizing your
// leads" is a real, inspectable, continuously-rolling claim an agency and
// a Platform Owner can both read back, not a one-time black box.
//
// Runs on the same in-process setInterval pattern every other periodic
// job in this codebase uses (see index.js) — idempotent per subscription
// via lastSourceOptimizationAt, so a redundant sweep tick just confirms
// "not due yet" and no-ops, same convention as agentOfMonth.js/
// hrLeaveAccrual.js.
const { prisma } = require('./db');
const { recordAudit } = require('./audit');
const { notifyAgencyOwners, notifyPlatformOwners } = require('./notifications');
const { computeSourcePerformance } = require('./recordStoreSourcePerformance');
const provisioning = require('./recordStoreProvisioning');

const WINDOW_DAYS = 30;
// A source is a drop candidate once its close rate falls to this
// fraction (or below) of the subscription's own best-performing source
// in the window — conservative on purpose: this spends real customer
// money, so it's never touched on a marginal difference.
const UNDERPERFORM_RATIO = 0.5;

function currentAcceptedSources(subscription, template) {
  const config = { ...(template.configurationJson || {}), ...(subscription.customConfigurationJson || {}) };
  const csv = config.Accepted_Sources;
  return csv ? String(csv).split(',').map((c) => c.trim()).filter(Boolean) : [];
}

// Pure decision function (no I/O) — kept separate from the sweep loop so
// it's directly unit-testable against hand-built performance data.
function decideChanges({ perSource, currentSources, minimumSampleSize }) {
  const eligible = perSource.filter((s) => currentSources.includes(s.sourceCode) && s.hasMinimumSample);

  if (eligible.length < 2) {
    return {
      changed: false,
      reasoning: eligible.length === 0
        ? `Not enough data yet — no source has reached the minimum sample of ${minimumSampleSize} leads in this window.`
        : 'Only one source has enough data to compare yet — nothing to optimize against.',
    };
  }

  // perSource arrives sorted best-closeRate-first; Array#filter preserves
  // relative order, so the first eligible entry is still the best one.
  const best = eligible[0];
  if (!best.closeRate) {
    return { changed: false, reasoning: 'No source converted any leads in this window yet — nothing to compare, so nothing was changed.' };
  }

  const toDrop = eligible.filter((s) => s !== best && (s.closeRate ?? 0) <= best.closeRate * UNDERPERFORM_RATIO);
  if (toDrop.length === 0) {
    return {
      changed: false,
      reasoning: `Checked ${eligible.length} source(s) with enough data to compare — all performing within range of your best source (${best.label}, ${best.closeRate}% close rate). No change needed.`,
    };
  }

  const newSources = currentSources.filter((code) => !toDrop.some((d) => d.sourceCode === code));
  const dropSummary = toDrop.map((d) => `${d.label} (${d.closeRate}% of ${d.leadCount})`).join(', ');
  const reasoning = `${dropSummary} converted well below ${best.label}'s ${best.closeRate}% close rate (${best.leadCount} leads) — dropped so your budget goes to what's actually converting.`;

  return { changed: true, newSources, droppedSources: toDrop.map((d) => d.sourceCode), reasoning };
}

// Runs the full suggest-then-apply pipeline for one subscription. Always
// writes a RecordStoreSourceOptimization row and bumps
// lastSourceOptimizationAt — even a no-op run — so the 30-day clock
// genuinely rolls rather than firing once and going silent forever.
async function runOptimizationForSubscription(subscription) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const performance = await computeSourcePerformance({ subscriptionId: subscription.id, from: windowStart, to: now });
  const currentSources = currentAcceptedSources(subscription, subscription.template);
  const decision = decideChanges({ perSource: performance.perSource, currentSources, minimumSampleSize: performance.minimumSampleSize });

  if (!decision.changed) {
    await prisma.$transaction([
      prisma.recordStoreSourceOptimization.create({
        data: {
          recordStoreSubscriptionId: subscription.id,
          windowStart,
          windowEnd: now,
          previousSources: currentSources,
          newSources: currentSources,
          droppedSources: [],
          reasoning: decision.reasoning,
          performanceSnapshot: performance.perSource,
          status: 'SKIPPED_NO_CHANGE',
        },
      }),
      prisma.recordStoreSubscription.update({ where: { id: subscription.id }, data: { lastSourceOptimizationAt: now } }),
    ]);
    return;
  }

  const applyResult = await provisioning.updateAcceptedSources(subscription.id, decision.newSources);

  await prisma.$transaction([
    prisma.recordStoreSourceOptimization.create({
      data: {
        recordStoreSubscriptionId: subscription.id,
        windowStart,
        windowEnd: now,
        previousSources: currentSources,
        newSources: decision.newSources,
        droppedSources: decision.droppedSources,
        reasoning: decision.reasoning,
        performanceSnapshot: performance.perSource,
        status: applyResult.success ? 'APPLIED' : 'FAILED',
        errorMessage: applyResult.success ? null : applyResult.errorMessage,
      },
    }),
    prisma.recordStoreSubscription.update({ where: { id: subscription.id }, data: { lastSourceOptimizationAt: now } }),
  ]);

  await recordAudit({
    agencyId: subscription.agencyId,
    action: applyResult.success ? 'RECORD_STORE_SOURCES_OPTIMIZED' : 'RECORD_STORE_SOURCE_OPTIMIZATION_FAILED',
    entityType: 'RecordStoreSubscription',
    entityId: subscription.id,
    after: { droppedSources: decision.droppedSources, newSources: decision.newSources },
  });

  if (applyResult.success) {
    await notifyAgencyOwners(subscription.agencyId, {
      type: 'record_store.sources_optimized',
      severity: 'INFO',
      title: `We optimized your ${subscription.productNameSnapshot} lead sources`,
      body: decision.reasoning,
      relatedEntityType: 'RecordStoreSubscription',
      relatedEntityId: subscription.id,
    });
  } else {
    // Never leak the raw provider error to the agency (same rule
    // FRIENDLY_ERROR enforces everywhere else in recordStoreProvisioning.js)
    // — a failed optimization attempt is Platform Owner's problem to chase,
    // not something that should alarm the customer with a backend error.
    await notifyPlatformOwners(subscription.agencyId, {
      type: 'record_store.source_optimization_failed',
      severity: 'ACTION',
      title: 'Automatic source optimization failed to apply',
      body: `${subscription.productNameSnapshot}: ${applyResult.errorMessage}`,
      relatedEntityType: 'RecordStoreSubscription',
      relatedEntityId: subscription.id,
    });
  }
}

// The actual recurring job — finds every subscription due for a look
// (ACTIVE, not opted out, provisioned, and either never evaluated-but-
// active 30+ days, or due again 30 days after its last evaluation) and
// runs the pipeline on each. One subscription's failure never stops the
// sweep for the rest, same isolation every other batch job in this
// codebase follows.
async function runSourceOptimizationSweep() {
  const dueCutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const due = await prisma.recordStoreSubscription.findMany({
    where: {
      status: 'ACTIVE',
      autoOptimizeSources: true,
      boberdooFilterSetId: { not: null },
      OR: [
        { lastSourceOptimizationAt: null, startedAt: { lte: dueCutoff } },
        { lastSourceOptimizationAt: { lte: dueCutoff } },
      ],
    },
    include: { template: true },
  });

  for (const subscription of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await runOptimizationForSubscription(subscription);
    } catch (err) {
      console.error('[recordStoreSourceOptimization] sweep failed for subscription', subscription.id, err.message);
    }
  }

  return { checked: due.length };
}

module.exports = { runSourceOptimizationSweep, runOptimizationForSubscription, decideChanges, currentAcceptedSources, WINDOW_DAYS };
