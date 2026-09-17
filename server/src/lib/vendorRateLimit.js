// Per-vendor sliding-window rate limit, in-memory. Fine for a single-instance
// deployment; if EvenFlow scales to multiple server instances, this should
// move to a shared store (Redis) — noted here rather than silently
// pretending a single-process limiter protects a multi-instance deployment.

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 120;

const hits = new Map(); // vendorId -> array of timestamps

function checkVendorRateLimit(vendorId) {
  const now = Date.now();
  const timestamps = (hits.get(vendorId) || []).filter((t) => now - t < WINDOW_MS);
  timestamps.push(now);
  hits.set(vendorId, timestamps);
  return timestamps.length <= MAX_PER_WINDOW;
}

module.exports = { checkVendorRateLimit };
