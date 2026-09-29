// Temporary, narrowly-scoped one-off data-import trigger — NOT part of the
// app's real feature set. Exists only because this deployment's operator
// has no direct database or shell access to their Render environment, so
// a one-time data import needs an HTTPS-reachable trigger instead of a
// CLI run. Gated by a shared secret (TRAINING_IMPORT_SECRET), not a user
// session, since this must be callable without an existing account.
//
// Intended to be removed (this file + its app.js mount + the env var)
// once the one-off import it exists for has been confirmed successful.

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { runTrainingDrillImport } = require('../lib/trainingDrillImport');

const router = express.Router();

const importLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' },
});

function secretMatches(provided, configured) {
  if (!configured || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(configured));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/import-training-drills', importLimiter, async (req, res, next) => {
  try {
    const configured = process.env.TRAINING_IMPORT_SECRET;
    if (!configured) {
      return res.status(503).json({ success: false, error: 'NOT_CONFIGURED', message: 'TRAINING_IMPORT_SECRET is not set on this environment.' });
    }
    const provided = req.headers['x-import-secret'];
    if (!secretMatches(provided, configured)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    const result = await runTrainingDrillImport();
    return res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
