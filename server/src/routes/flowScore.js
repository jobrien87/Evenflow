const express = require('express');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const {
  explainScore,
  componentPlaceholders,
  listWeightConfigsForAgency,
  updateWeightConfigForAgency,
} = require('../lib/flowScore');

// Only these roles' weights are ever agency-customizable from "Flow
// Settings" — TELEMARKETER stays platform-wide (see flowScore.js).
const EDITABLE_ROLES = ['PRODUCER', 'AGENCY'];

const router = express.Router();
router.use(requireAuth);

async function latestSnapshot(subjectType, subjectId) {
  return prisma.flowScoreSnapshot.findFirst({
    where: { subjectType, subjectId },
    orderBy: { computedAt: 'desc' },
  });
}

// The current user's own Flow Score (Producer or Telemarketer).
router.get('/me', async (req, res, next) => {
  try {
    if (!['PRODUCER', 'TELEMARKETER'].includes(req.user.role)) {
      return res.status(400).json({ success: false, error: 'NOT_APPLICABLE', message: 'Flow Score applies to Producers and Telemarketers.' });
    }
    const snapshot = await latestSnapshot('USER', req.user.id);
    if (!snapshot) {
      return res.json({
        success: true, snapshot: null,
        message: 'Not enough activity yet to compute a Flow Score.',
        componentPlaceholders: componentPlaceholders(req.user.role),
      });
    }
    return res.json({ success: true, snapshot, explanation: explainScore(snapshot) });
  } catch (err) {
    next(err);
  }
});

// Any user's Flow Score, scoped like every other route (own agency only,
// unless Platform Owner) — used by an Agency Owner/Manager to check a
// specific producer/telemarketer.
router.get('/user/:userId', async (req, res, next) => {
  try {
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && target.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const snapshot = await latestSnapshot('USER', target.id);
    if (!snapshot) {
      return res.json({
        success: true, snapshot: null,
        message: 'Not enough activity yet to compute a Flow Score.',
        componentPlaceholders: componentPlaceholders(target.role),
      });
    }
    return res.json({ success: true, snapshot, explanation: explainScore(snapshot) });
  } catch (err) {
    next(err);
  }
});

router.get('/agency/:agencyId', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    if (req.user.role !== 'PLATFORM_OWNER' && req.user.agencyId !== req.params.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const snapshot = await latestSnapshot('AGENCY', req.params.agencyId);
    if (!snapshot) {
      return res.json({
        success: true, snapshot: null,
        message: 'Not enough activity yet to compute an Agency Flow Score.',
        componentPlaceholders: componentPlaceholders('AGENCY'),
      });
    }
    return res.json({ success: true, snapshot, explanation: explainScore(snapshot) });
  } catch (err) {
    next(err);
  }
});

// Snapshot history for trend charts — same subject-scoping rules as above.
router.get('/history', async (req, res, next) => {
  try {
    const { subjectType, subjectId } = req.query;
    if (!['USER', 'AGENCY'].includes(subjectType) || !subjectId) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'subjectType (USER|AGENCY) and subjectId are required.' });
    }
    if (subjectType === 'USER') {
      if (subjectId !== req.user.id) {
        const target = await prisma.user.findUnique({ where: { id: subjectId } });
        if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
        if (req.user.role !== 'PLATFORM_OWNER' && target.agencyId !== req.user.agencyId) {
          return res.status(403).json({ success: false, error: 'FORBIDDEN' });
        }
      }
    } else if (req.user.role !== 'PLATFORM_OWNER' && subjectId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    const snapshots = await prisma.flowScoreSnapshot.findMany({
      where: { subjectType, subjectId },
      orderBy: { computedAt: 'desc' },
      take: 90,
      select: { id: true, score: true, computedAt: true },
    });
    return res.json({ success: true, snapshots });
  } catch (err) {
    next(err);
  }
});

// "Flow Settings" — an Agency Owner/Manager's real current Flow Score
// weights for every role (Agency, Producer, and the platform-wide
// Telemarketer config shown for visibility), used by the modal opened
// from the Main Stage Flow Score box.
router.get('/weights/:agencyId', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    if (req.user.role !== 'PLATFORM_OWNER' && req.user.agencyId !== req.params.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const configs = await listWeightConfigsForAgency(req.params.agencyId);
    return res.json({ success: true, configs });
  } catch (err) {
    next(err);
  }
});

// Save a new weight set for one role's agency-scoped config. Only
// PRODUCER/AGENCY are ever accepted here — TELEMARKETER is platform-wide
// and has no per-agency config to write.
router.patch('/weights/:agencyId/:role', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const { agencyId, role } = req.params;
    if (req.user.role !== 'PLATFORM_OWNER' && req.user.agencyId !== agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (!EDITABLE_ROLES.includes(role)) {
      return res.status(400).json({
        success: false, error: 'NOT_EDITABLE',
        message: 'Only Agency and Producer Flow Score weights can be customized here.',
      });
    }

    const before = await prisma.flowScoreWeightConfig.findFirst({ where: { role, agencyId, isActive: true } });
    const updated = await updateWeightConfigForAgency(role, agencyId, req.body?.weights);

    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      agencyId,
      action: 'flow_score.weights_updated',
      entityType: 'FlowScoreWeightConfig',
      entityId: updated.id,
      before: before ? { weights: before.weights, version: before.version } : null,
      after: { weights: updated.weights, version: updated.version },
      correlationId: req.correlationId,
    });

    return res.json({ success: true, config: { role, weights: updated.weights, version: updated.version } });
  } catch (err) {
    if (err.code === 'VALIDATION' || err.code === 'NOT_EDITABLE') {
      return res.status(400).json({ success: false, error: err.code, message: err.message });
    }
    next(err);
  }
});

module.exports = router;
