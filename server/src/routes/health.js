const express = require('express');
const { prisma } = require('../lib/db');

const router = express.Router();

router.get('/', async (req, res) => {
  const status = { database: 'DOWN', email: 'NOT_CONFIGURED' };

  try {
    await prisma.$queryRaw`SELECT 1`;
    status.database = 'HEALTHY';
  } catch (err) {
    status.database = 'DOWN';
  }

  status.email = process.env.RESEND_API_KEY ? 'HEALTHY' : 'NOT_CONFIGURED';

  const overall = status.database === 'HEALTHY' ? 'ok' : 'degraded';
  res.status(overall === 'ok' ? 200 : 503).json({ status: overall, checks: status, time: new Date().toISOString() });
});

module.exports = router;
