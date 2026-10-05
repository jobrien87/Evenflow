const express = require('express');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { assembleProducerReport, assembleAgencyReport } = require('../lib/runningReport');

const router = express.Router();
router.use(requireAuth);

// Optional real {from, to} override — used by both routes below so a
// caller can pick the same date range every other report already lets
// them pick, instead of being stuck on "this month." Missing/invalid
// values fall through to the library's own "this month to now" default.
function parseOptionalRange(req) {
  const from = req.query.from ? new Date(req.query.from) : undefined;
  const to = req.query.to ? new Date(req.query.to) : undefined;
  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return undefined;
  return { from, to };
}

// The caller's own running report (Producer/Telemarketer).
router.get('/me', async (req, res, next) => {
  try {
    if (!['PRODUCER', 'TELEMARKETER'].includes(req.user.role)) {
      return res.status(400).json({ success: false, error: 'NOT_APPLICABLE', message: 'Running Reports apply to Producers and Telemarketers.' });
    }
    const report = await assembleProducerReport(req.user.id, parseOptionalRange(req));
    return res.json({ success: true, report });
  } catch (err) {
    next(err);
  }
});

router.get('/agency/:agencyId', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    if (req.user.role !== 'PLATFORM_OWNER' && req.user.agencyId !== req.params.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const agency = await prisma.agency.findUnique({ where: { id: req.params.agencyId } });
    if (!agency) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    const report = await assembleAgencyReport(req.params.agencyId, parseOptionalRange(req));
    return res.json({ success: true, report });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
