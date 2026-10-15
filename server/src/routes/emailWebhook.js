// Inbound Brevo transactional-email delivery-event webhook. Public (no
// user session — Brevo itself calls this), so it is gated instead on a
// shared secret configured in Brevo's dashboard alongside the webhook
// URL, matching this app's standing "no public write surface is ever
// trust-free" rule. Unset secret -> honest 503 NOT_CONFIGURED, never a
// silent accept of unauthenticated data.
const express = require('express');
const { processBrevoWebhookEvents } = require('../lib/emailWebhook');

const router = express.Router();

function isAuthorized(req) {
  const expected = process.env.BREVO_WEBHOOK_SECRET;
  if (!expected) return false;
  const provided = req.get('x-brevo-webhook-secret') || req.query.secret;
  return typeof provided === 'string' && provided === expected;
}

router.post('/brevo', async (req, res, next) => {
  try {
    if (!process.env.BREVO_WEBHOOK_SECRET) {
      return res.status(503).json({ success: false, error: 'NOT_CONFIGURED', message: 'BREVO_WEBHOOK_SECRET is not set.' });
    }
    if (!isAuthorized(req)) {
      return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
    }

    // Brevo sends either one event object or an array of them depending
    // on the webhook's own batching configuration — normalize to an array
    // so the processor never has to branch on shape.
    const events = Array.isArray(req.body) ? req.body : [req.body];
    const summary = await processBrevoWebhookEvents(events);

    // Always 200 once authenticated and processed (even a partially-
    // unmatched batch) — Brevo retries on non-2xx, and a single malformed
    // event among real ones is not grounds to make it resend the whole
    // batch forever.
    return res.json({ success: true, ...summary });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
