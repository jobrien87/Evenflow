// Small pub-sub for one-off celebration moments (a sale, a completed
// goal, a first login, a birthday) — matches ui/Toast.jsx's existing
// module-level listener-array convention, no new state-management
// dependency. Anything in the app can call fireCelebration(); only
// ui/CelebrationHost.jsx (mounted once in AppLayout) listens.
let listeners = [];

export function onCelebration(fn) {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

// effect: one of FallingEffectOverlay's FALLING_EFFECTS values.
// opts.message: optional short text shown in a small toast-style badge
// alongside the effect (e.g. "Sale logged!"); opts.popup: { title, body }
// renders a bigger modal moment (used for birthdays) instead of just the
// falling effect.
export function fireCelebration(effect, opts = {}) {
  listeners.forEach((fn) => fn({ effect, ...opts }));
}
