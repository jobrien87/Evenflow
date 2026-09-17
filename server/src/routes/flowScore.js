const express = require('express');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { explainScore } = require('../lib/flowScore');

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
      return res.json({ success: true, snapshot: null, message: 'Not enough activity yet to compute a Flow Score.' });
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
      return res.json({ success: true, snapshot: null, message: 'Not enough activity yet to compute a Flow Score.' });
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
      return res.json({ success: true, snapshot: null, message: 'Not enough activity yet to compute an Agency Flow Score.' });
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

module.exports = router;
