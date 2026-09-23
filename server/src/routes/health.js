const express = require('express');
const { prisma } = require('../lib/db');
const { isConfigured: emailConfigured } = require('../lib/email');

const router = express.Router();

router.get('/', async (req, res) => {
  const status = { database: 'DOWN', email: 'NOT_CONFIGURED' };

  try {
    await prisma.$queryRaw`SELECT 1`;
    status.database = 'HEALTHY';
  } catch (err) {
    status.database = 'DOWN';
  }

  status.email = emailConfigured() ? 'HEALTHY' : 'NOT_CONFIGURED';

  const overall = status.database === 'HEALTHY' ? 'ok' : 'degraded';
  res.status(overall === 'ok' ? 200 : 503).json({ status: overall, checks: status, time: new Date().toISOString() });
});

module.exports = router;
