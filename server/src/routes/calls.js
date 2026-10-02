const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { save, storageHealth } = require('../lib/storage');
const { validateAudioUpload } = require('../lib/fileValidation');
const { enqueueCallProcessing, enqueueAnalysis } = require('../jobs/callProcessing');
const { read } = require('../lib/storage');
const { requireSalesStudioAccess } = require('../lib/entitlements');
const { computeDrillScore, computeCoachingBreakdown } = require('../lib/callScoring');
const bunnyStream = require('../lib/bunnyStream');

const router = express.Router();
router.use(requireAuth);
router.use(requireSalesStudioAccess);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

// bunnyEmbedUrl is only ever computed, never stored — so it always
// reflects the current BUNNY_STREAM_LIBRARY_ID and is simply absent
// (not a broken link) when a call has no video or Bunny isn't configured.
function withBunnyEmbed(call) {
  return {
    ...call,
    bunnyEmbedUrl: call.bunnyVideoId && bunnyStream.isConfigured() ? bunnyStream.embedUrl(call.bunnyVideoId) : null,
  };
}

router.get('/storage-health', requireRole('PLATFORM_OWNER'), (req, res) => {
  res.json({ success: true, ...storageHealth() });
});

router.get('/', async (req, res, next) => {
  try {
    const where = {};
    if (req.user.role !== 'PLATFORM_OWNER') {
      if (!req.user.agencyId) return res.json({ success: true, calls: [] });
      where.agencyId = req.user.agencyId;
    }
    if (req.user.role === 'PRODUCER') {
      where.uploadedById = req.user.id;
    } else if (req.query.uploadedById) {
      // Call Scoring's "sort/filter by producer" — never trust the id
      // blindly: confirm it's a real user in the caller's own agency
      // (PLATFORM_OWNER can target any agency), same ownership-check
      // idiom used elsewhere in this app (e.g. workqueue.js's ?userId=).
      const target = await prisma.user.findUnique({ where: { id: req.query.uploadedById }, select: { agencyId: true } });
      if (!target || (req.user.role !== 'PLATFORM_OWNER' && target.agencyId !== req.user.agencyId)) {
        return res.status(403).json({ success: false, error: 'FORBIDDEN' });
      }
      where.uploadedById = req.query.uploadedById;
    }
    if (req.query.status) where.status = req.query.status;
    if (req.query.from || req.query.to) {
      where.createdAt = {
        ...(req.query.from ? { gte: new Date(req.query.from) } : {}),
        ...(req.query.to ? { lte: new Date(req.query.to) } : {}),
      };
    }

    const calls = await prisma.call.findMany({
      where,
      include: {
        uploadedBy: { select: { id: true, firstName: true, lastName: true } },
        analysis: { select: { overallScore: true, reviewRecommended: true, dimensionScores: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    // Drill Score — computed from the AI's existing dimensionScores, not
    // a second analysis pass. See lib/callScoring.js.
    const callsWithDrillScore = calls.map((call) => withBunnyEmbed({
      ...call,
      drillScore: call.analysis ? computeDrillScore(call.analysis.dimensionScores)?.drillScore ?? null : null,
    }));

    return res.json({ success: true, calls: callsWithDrillScore });
  } catch (err) {
    next(err);
  }
});

// Registered before /:id — "coaching" would otherwise be swallowed as an
// id by that param route (same anti-shadowing pattern used throughout
// this app, e.g. leads.js's /funnel).
router.get('/coaching', requireRole('PRODUCER', 'AGENCY_MANAGER', 'AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    let targetUserId;
    let agencyId;

    if (req.user.role === 'PRODUCER') {
      // Self-service only — a Producer can see their own coaching
      // breakdown, never another producer's.
      targetUserId = req.user.id;
      agencyId = req.user.agencyId;
    } else {
      targetUserId = req.query.userId;
      if (!targetUserId) return res.status(400).json({ success: false, error: 'USER_REQUIRED', message: 'userId is required.' });
      const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { agencyId: true, role: true } });
      if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      if (req.user.role !== 'PLATFORM_OWNER' && target.agencyId !== req.user.agencyId) {
        return res.status(403).json({ success: false, error: 'FORBIDDEN' });
      }
      agencyId = target.agencyId;
    }

    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

    const breakdown = await computeCoachingBreakdown({ prisma, agencyId, userId: targetUserId, from, to });

    return res.json({ success: true, period: { from: from.toISOString(), to: to.toISOString() }, ...breakdown });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const call = await prisma.call.findUnique({
      where: { id: req.params.id },
      include: { uploadedBy: { select: { firstName: true, lastName: true } }, analysis: true, lead: { select: { id: true, customer: true } } },
    });
    if (!call) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && call.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const drill = call.analysis ? computeDrillScore(call.analysis.dimensionScores) : null;
    return res.json({ success: true, call: withBunnyEmbed({ ...call, drillScore: drill?.drillScore ?? null, drillCategoryScores: drill?.categoryScores ?? null }) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/audio', async (req, res, next) => {
  try {
    const call = await prisma.call.findUnique({ where: { id: req.params.id } });
    if (!call) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && call.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const buffer = await read(call.storageKey);
    res.set('Content-Type', call.mimeType || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${call.filename}"`);
    return res.send(buffer);
  } catch (err) {
    next(err);
  }
});

const transcriptSchema = z.object({ transcript: z.string().trim().min(1).max(50000) });

// Manual transcript entry — no transcription provider is configured in
// this environment (see lib/transcriptionProvider.js). This is the real,
// honest alternative for that case: a human enters the real transcript,
// then the same real analyzeTranscript() step the automatic pipeline uses
// runs on it. Only usable before a transcript already exists — once one
// does (auto or manual), this isn't an edit endpoint.
router.patch('/:id/transcript', requireRole('PRODUCER', 'AGENCY_MANAGER', 'AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = transcriptSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }

    const call = await prisma.call.findUnique({ where: { id: req.params.id } });
    if (!call) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && call.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (call.transcript) {
      return res.status(409).json({ success: false, error: 'TRANSCRIPT_EXISTS', message: 'This call already has a transcript.' });
    }

    const updated = await prisma.call.update({
      where: { id: call.id },
      data: { transcript: parsed.data.transcript, transcriptProvider: 'manual', status: 'TRANSCRIBED', failureReason: null },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: call.agencyId,
      action: 'call.transcript_entered_manually', entityType: 'Call', entityId: call.id,
      correlationId: req.correlationId,
    });

    enqueueAnalysis(call.id);

    return res.json({ success: true, call: updated });
  } catch (err) {
    next(err);
  }
});

const videoSchema = z.object({ bunnyVideoId: z.string().trim().min(1).max(200) });

// Attach (or replace) this call's Bunny Stream video — the video itself is
// uploaded directly in the Bunny.net dashboard; this only stores the GUID
// after confirming it's real, never re-uploads/re-hosts anything.
router.patch('/:id/video', requireRole('PRODUCER', 'AGENCY_MANAGER', 'AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = videoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }

    const call = await prisma.call.findUnique({ where: { id: req.params.id } });
    if (!call) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && call.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    if (!bunnyStream.isConfigured()) {
      return res.status(409).json({ success: false, error: 'NOT_CONFIGURED', message: 'Bunny Stream is not configured on this server yet.' });
    }

    let exists;
    try {
      exists = await bunnyStream.videoExists(parsed.data.bunnyVideoId);
    } catch (err) {
      return res.status(502).json({ success: false, error: 'BUNNY_ERROR', message: 'Could not reach Bunny Stream to verify this video.' });
    }
    if (!exists) {
      return res.status(400).json({ success: false, error: 'VIDEO_NOT_FOUND', message: 'No video with that id was found in the configured Bunny Stream library.' });
    }

    const updated = await prisma.call.update({ where: { id: call.id }, data: { bunnyVideoId: parsed.data.bunnyVideoId } });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: call.agencyId,
      action: 'call.video_attached', entityType: 'Call', entityId: call.id,
      correlationId: req.correlationId,
    });

    return res.json({ success: true, call: withBunnyEmbed(updated) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/video', requireRole('PRODUCER', 'AGENCY_MANAGER', 'AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const call = await prisma.call.findUnique({ where: { id: req.params.id } });
    if (!call) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && call.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const updated = await prisma.call.update({ where: { id: call.id }, data: { bunnyVideoId: null } });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: call.agencyId,
      action: 'call.video_removed', entityType: 'Call', entityId: call.id,
      correlationId: req.correlationId,
    });
    return res.json({ success: true, call: withBunnyEmbed(updated) });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireRole('PRODUCER', 'AGENCY_MANAGER', 'AGENCY_OWNER'), upload.single('recording'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'No file uploaded (expected multipart field "recording").' });
    }
    if (!req.user.agencyId) {
      return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    }

    const leadIdParsed = z.string().uuid().optional().safeParse(req.body.leadId || undefined);
    if (!leadIdParsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'leadId must be a valid UUID.' });
    }
    const leadId = leadIdParsed.data || null;
    if (leadId) {
      // Never trust a client-supplied leadId as belonging to the uploader's
      // own agency — confirm it before linking a call recording to it.
      const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { agencyId: true } });
      if (!lead || lead.agencyId !== req.user.agencyId) {
        return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'leadId does not belong to your agency.' });
      }
    }

    // Call Scoring's "upload a recording for a given agent" — a Manager/
    // Owner uploading a batch of recordings after the fact attributes each
    // one to the real producer who was on the call, not to themselves.
    // uploadedById drives Flow Score's callQuality attribution
    // (computeProducerScore), so this must be validated, never trusted
    // blindly, same as leadId above.
    let uploadedById = req.user.id;
    const producerIdParsed = z.string().uuid().optional().safeParse(req.body.producerId || undefined);
    if (!producerIdParsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'producerId must be a valid UUID.' });
    }
    if (producerIdParsed.data) {
      if (req.user.role === 'PRODUCER') {
        return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Producers can only upload calls as themselves.' });
      }
      const producer = await prisma.user.findUnique({ where: { id: producerIdParsed.data }, select: { agencyId: true, role: true } });
      if (!producer || producer.agencyId !== req.user.agencyId || producer.role !== 'PRODUCER') {
        return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'producerId must be a Producer in your agency.' });
      }
      uploadedById = producerIdParsed.data;
    }

    const validation = validateAudioUpload(req.file.buffer);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: 'INVALID_FILE', message: validation.reason });
    }

    let storageKey;
    try {
      storageKey = await save(req.file.buffer, req.file.originalname);
    } catch (err) {
      return res.status(500).json({ success: false, error: 'STORAGE_ERROR', message: err.message });
    }

    const call = await prisma.call.create({
      data: {
        agencyId: req.user.agencyId,
        uploadedById,
        leadId,
        source: 'MANUAL_UPLOAD',
        filename: req.file.originalname,
        storageKey,
        mimeType: validation.detectedType,
        fileSizeBytes: req.file.buffer.length,
        status: 'UPLOADED',
      },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.user.agencyId,
      action: 'call.uploaded', entityType: 'Call', entityId: call.id,
      after: { filename: call.filename }, correlationId: req.correlationId,
    });

    enqueueCallProcessing(call.id);

    return res.status(201).json({ success: true, call });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/retry', requireRole('PRODUCER', 'AGENCY_MANAGER', 'AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const call = await prisma.call.findUnique({ where: { id: req.params.id } });
    if (!call) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && call.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (call.status !== 'FAILED') {
      return res.status(409).json({ success: false, error: 'NOT_RETRYABLE', message: `Call is currently ${call.status}, only FAILED calls can be retried.` });
    }
    await prisma.call.update({ where: { id: call.id }, data: { status: 'UPLOADED', failureReason: null } });
    enqueueCallProcessing(call.id);
    return res.json({ success: true, message: 'Retry queued.' });
  } catch (err) {
    next(err);
  }
});

const reviewSchema = z.object({
  managerOverrideScore: z.number().int().min(0).max(100).optional(),
  managerComment: z.string().optional(),
});

router.post('/:id/review', requireRole('AGENCY_MANAGER', 'AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION' });

    const call = await prisma.call.findUnique({ where: { id: req.params.id }, include: { analysis: true } });
    if (!call || !call.analysis) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && call.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    const updated = await prisma.callAnalysis.update({
      where: { callId: call.id },
      data: { managerOverrideScore: parsed.data.managerOverrideScore, managerComment: parsed.data.managerComment },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: call.agencyId,
      action: 'call.reviewed', entityType: 'CallAnalysis', entityId: updated.id,
      after: { managerOverrideScore: parsed.data.managerOverrideScore }, correlationId: req.correlationId,
    });

    return res.json({ success: true, analysis: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
