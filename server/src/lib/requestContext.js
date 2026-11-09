// A tiny per-request ambient context, carried via Node's AsyncLocalStorage
// so it survives through every async call started from inside the
// request — no need to thread a value through every function signature
// along the way. Used for exactly one thing today: letting recordAudit
// (lib/audit.js) tag an audit event as performed via impersonation without
// requiring every one of its ~130 call sites across the app to remember to
// pass that in by hand (something that reliably gets missed over time —
// see middleware/auth.js's attachUser, which sets this once per request).
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

function runWithContext(context, fn) {
  return storage.run(context, fn);
}

function getContext() {
  return storage.getStore() || null;
}

module.exports = { runWithContext, getContext };
