// In-process background job runner for call processing.
//
// This is intentionally lightweight: setImmediate() rather than a real queue
// (BullMQ/Redis). That's an honest tradeoff for early scale per spec's cost
// guidance ("avoid unnecessary paid infrastructure") — it means a server
// restart mid-processing loses in-flight jobs (they stay at whatever status
// they were in, and are retryable), and processing doesn't survive across
// multiple server instances. Before real volume, this should be replaced
// with a durable queue; that swap doesn't change the pipeline steps below.

const { prisma } = require('../lib/db');
const { read, remove } = require('../lib/storage');
const { transcribe } = require('../lib/transcriptionProvider');
const { analyzeTranscript } = require('../lib/callAnalysis');
const { redactTranscript } = require('../lib/transcriptRedaction');
const { estimateCostMicros } = require('../lib/aiCost');
const { notifyUser } = require('../lib/notifications');
const { computeProducerScore, computeAgencyScore } = require('../lib/flowScore');

async function setStatus(callId, status, extra = {}) {
  return prisma.call.update({ where: { id: callId }, data: { status, ...extra } });
}

// Compare-and-swap status transition: only writes if the row is still in
// one of `fromStatuses`, and reports whether it actually won the race.
// The automatic pipeline (enqueueCallProcessing) and a manually-entered
// transcript (enqueueAnalysis) are two independent, concurrently-fired
// background jobs that can both be in flight for the same call — without
// this guard, a slower automatic-pipeline step (e.g. "no transcription
// provider configured") can land its unconditional FAILED write after a
// faster manual-entry path has already completed scoring, silently
// regressing a COMPLETE call back to FAILED.
async function setStatusIfCurrently(callId, fromStatuses, status, extra = {}) {
  const result = await prisma.call.updateMany({ where: { id: callId, status: { in: fromStatuses } }, data: { status, ...extra } });
  return result.count > 0;
}

// Shared by the automatic pipeline (after a real transcription result) and
// the manual-transcript route (after a human pastes one in) — one real
// analysis step, never two divergent implementations of it. Guarded so
// that if both paths ever race to analyze the same call, only the one
// that wins the TRANSCRIBED -> ANALYZING transition actually runs it.
async function runAnalysis(callId) {
  const claimed = await setStatusIfCurrently(callId, ['TRANSCRIBED'], 'ANALYZING');
  if (!claimed) return;

  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call) return;

  let analysisResult;
  try {
    analysisResult = await analyzeTranscript(call.transcript);
  } catch (err) {
    await setStatus(callId, 'FAILED', {
      failureReason: `Call analysis failed: ${err.message}. The transcript is preserved and this can be retried.`,
    });
    return;
  }

  if (!analysisResult.available) {
    await setStatus(callId, 'FAILED', {
      failureReason: 'AI analysis service is not configured. The transcript is preserved and this can be retried once a provider is connected.',
    });
    return;
  }

  const a = analysisResult.analysis;
  await prisma.callAnalysis.create({
    data: {
      callId,
      summary: a.summary,
      productsDiscussed: a.products_discussed,
      objections: a.objections,
      buyingSignals: a.buying_signals,
      missedOpportunities: a.missed_opportunities,
      crossSellOpportunities: a.cross_sell_opportunities,
      followUpCommitments: a.follow_up_commitments,
      nextSteps: a.next_steps,
      strengths: a.strengths,
      coachingOpportunities: a.coaching_opportunities,
      overallScore: a.overall_score,
      dimensionScores: a.dimension_scores,
      reviewRecommended: a.review_recommended,
      reviewReason: a.review_reason || null,
      aiModel: analysisResult.model,
    },
  });

  const estimatedCostMicros = estimateCostMicros(analysisResult.model, analysisResult.inputTokens, analysisResult.outputTokens);
  await prisma.aiUsageLog.create({
    data: {
      feature: 'call_analysis',
      agencyId: call.agencyId,
      userId: call.uploadedById,
      model: analysisResult.model,
      inputTokens: analysisResult.inputTokens,
      outputTokens: analysisResult.outputTokens,
      estimatedCostMicros,
    },
  });

  // Scoring is done — the CallAnalysis row above is the permanent record
  // from here on. Burn the recording and discard the transcript; neither
  // is needed again, and per data-retention policy neither should exist
  // a moment longer than it has to. A storage cleanup failure is logged
  // but never blocks the call from reaching COMPLETE — a stray file is a
  // follow-up for an operator, not a reason to leave scoring stuck.
  let recordingDeletedAt = null;
  try {
    await remove(call.storageKey);
    recordingDeletedAt = new Date();
  } catch (err) {
    console.error(`[callProcessing] failed to delete recording for call ${callId} after scoring`, err.message);
  }
  await prisma.call.update({
    where: { id: callId },
    data: {
      status: 'COMPLETE',
      transcript: null,
      storageKey: null,
      transcriptDiscardedAt: new Date(),
      recordingDeletedAt,
    },
  });

  // A new scored call is exactly the kind of real state change that
  // should move a Flow Score — recompute now rather than on every
  // dashboard view (per spec: no synchronous recompute-on-every-click).
  Promise.all([
    computeProducerScore(call.uploadedById),
    computeAgencyScore(call.agencyId),
  ]).catch((err) => console.error('[flowScore] recompute after call analysis failed', err.message));

  await notifyUser({
    userId: call.uploadedById,
    agencyId: call.agencyId,
    type: 'call.analysis_complete',
    severity: 'INFO',
    title: 'Call analysis ready',
    body: `${call.filename} — score ${a.overall_score}/100`,
    relatedEntityType: 'Call',
    relatedEntityId: callId,
  }).catch((err) => console.error('[notifications] call.analysis_complete failed', err.message));
}

async function processCall(callId) {
  try {
    // Each transition only proceeds if the call is still where this
    // pipeline left it — if a manually-entered transcript has already
    // moved it on (see enqueueAnalysis), these become no-ops rather than
    // clobbering whatever that faster path already wrote.
    if (!(await setStatusIfCurrently(callId, ['UPLOADED'], 'QUEUED'))) return;
    if (!(await setStatusIfCurrently(callId, ['QUEUED'], 'TRANSCRIBING'))) return;

    const call = await prisma.call.findUnique({ where: { id: callId } });
    if (!call) return;

    const audioBuffer = await read(call.storageKey);
    const transcriptionResult = await transcribe(audioBuffer, call.mimeType);

    if (!transcriptionResult.available) {
      await setStatusIfCurrently(callId, ['TRANSCRIBING'], 'FAILED', {
        failureReason: 'Transcription service is not configured. The recording is safely stored and can be retried once a provider is connected, or a transcript can be entered manually.',
      });
      return;
    }

    // Redact the moment a transcript is captured — a raw, unredacted
    // transcript is never written to the database, not even transiently.
    if (!(await setStatusIfCurrently(callId, ['TRANSCRIBING'], 'TRANSCRIBED', {
      transcript: redactTranscript(transcriptionResult.transcript),
      transcriptProvider: transcriptionResult.provider,
    }))) return;

    await runAnalysis(callId);
  } catch (err) {
    console.error(`[callProcessing] unexpected failure for call ${callId}`, err);
    await setStatusIfCurrently(callId, ['QUEUED', 'TRANSCRIBING'], 'FAILED', {
      failureReason: 'An unexpected error occurred while processing this call. It can be retried.',
    }).catch(() => {});
  }
}

function enqueueCallProcessing(callId) {
  setImmediate(() => {
    processCall(callId).catch((err) => console.error('[callProcessing] fatal', err));
  });
}

function enqueueAnalysis(callId) {
  setImmediate(() => {
    runAnalysis(callId).catch((err) => console.error('[callProcessing] analysis fatal', err));
  });
}

module.exports = { enqueueCallProcessing, enqueueAnalysis, processCall, runAnalysis, setStatusIfCurrently };
