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
const { read } = require('../lib/storage');
const { transcribe } = require('../lib/transcriptionProvider');
const { analyzeTranscript } = require('../lib/callAnalysis');
const { estimateCostMicros } = require('../lib/aiCost');
const { notifyUser } = require('../lib/notifications');

async function setStatus(callId, status, extra = {}) {
  return prisma.call.update({ where: { id: callId }, data: { status, ...extra } });
}

async function processCall(callId) {
  try {
    await setStatus(callId, 'QUEUED');
    await setStatus(callId, 'TRANSCRIBING');

    const call = await prisma.call.findUnique({ where: { id: callId } });
    if (!call) return;

    const audioBuffer = await read(call.storageKey);
    const transcriptionResult = await transcribe(audioBuffer, call.mimeType);

    if (!transcriptionResult.available) {
      await setStatus(callId, 'FAILED', {
        failureReason: 'Transcription service is not configured. The recording is safely stored and can be retried once a provider is connected.',
      });
      return;
    }

    await setStatus(callId, 'TRANSCRIBED', {
      transcript: transcriptionResult.transcript,
      transcriptProvider: transcriptionResult.provider,
    });

    await setStatus(callId, 'ANALYZING');

    let analysisResult;
    try {
      analysisResult = await analyzeTranscript(transcriptionResult.transcript);
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

    await setStatus(callId, 'COMPLETE');

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
  } catch (err) {
    console.error(`[callProcessing] unexpected failure for call ${callId}`, err);
    await setStatus(callId, 'FAILED', {
      failureReason: 'An unexpected error occurred while processing this call. It can be retried.',
    }).catch(() => {});
  }
}

function enqueueCallProcessing(callId) {
  setImmediate(() => {
    processCall(callId).catch((err) => console.error('[callProcessing] fatal', err));
  });
}

module.exports = { enqueueCallProcessing, processCall };
