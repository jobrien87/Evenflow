const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { save, storageHealth } = require('../lib/storage');
const { validateAudioUpload } = require('../lib/fileValidation');
const { enqueueCallProcessing } = require('../jobs/callProcessing');
const { requireModuleEnabled } = require('../lib/entitlements');

const router = express.Router();
router.use(requireAuth);
router.use(requireModuleEnabled('coachingEnabled'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

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
    }
    if (req.query.status) where.status = req.query.status;

    const calls = await prisma.call.findMany({
      where,
      include: {
        uploadedBy: { select: { firstName: true, lastName: true } },
        analysis: { select: { overallScore: true, reviewRecommended: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return res.json({ success: true, calls });
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
    return res.json({ success: true, call });
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

    const leadId = req.body.leadId || null;

    const call = await prisma.call.create({
      data: {
        agencyId: req.user.agencyId,
        uploadedById: req.user.id,
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
