const express = require('express');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { assembleProducerReport, assembleAgencyReport } = require('../lib/runningReport');

const router = express.Router();
router.use(requireAuth);

// The caller's own running report (Producer/Telemarketer).
router.get('/me', async (req, res, next) => {
  try {
    if (!['PRODUCER', 'TELEMARKETER'].includes(req.user.role)) {
      return res.status(400).json({ success: false, error: 'NOT_APPLICABLE', message: 'Running Reports apply to Producers and Telemarketers.' });
    }
    const report = await assembleProducerReport(req.user.id);
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
    const report = await assembleAgencyReport(req.params.agencyId);
    return res.json({ success: true, report });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
