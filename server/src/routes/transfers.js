// Yield Transfers rebuild: the accept/reject/routing/revenue/credit-request
// workflow that used to live here has been retired (telemarketer
// submissions now become real Lead rows — see routes/leads.js and
// lib/flowScore.js's rebuilt Telemarketer components). Historical Transfer
// data is left in the database untouched (no destructive migration), and
// these two read-only routes remain so it stays inspectable — nothing new
// gets written here going forward.

const express = require('express');
const { prisma } = require('../lib/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    let where = {};
    if (req.user.role === 'TELEMARKETER') {
      where = { createdByTMId: req.user.id };
    } else if (req.user.role !== 'PLATFORM_OWNER') {
      if (!req.user.agencyId) return res.json({ success: true, transfers: [] });
      where = { agencyId: req.user.agencyId };
    } else if (req.query.agencyId) {
      where = { agencyId: req.query.agencyId };
    }
    if (req.query.status) where.status = req.query.status;

    const transfers = await prisma.transfer.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { createdByTM: { select: { firstName: true, lastName: true } } },
    });
    return res.json({ success: true, transfers });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const transfer = await prisma.transfer.findUnique({
      where: { id: req.params.id },
      include: { events: { orderBy: { createdAt: 'desc' } }, creditRequests: true },
    });
    if (!transfer) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    const allowed =
      req.user.role === 'PLATFORM_OWNER' ||
      (req.user.role === 'TELEMARKETER' && transfer.createdByTMId === req.user.id) ||
      (transfer.agencyId && transfer.agencyId === req.user.agencyId);
    if (!allowed) return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    return res.json({ success: true, transfer });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
