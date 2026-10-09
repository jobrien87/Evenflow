// Where a signed-out user is sent — the public marketing site, not back
// into the app's own login form. Configured at build time via
// VITE_MARKETING_URL (see render.yaml); falls back to the real
// evenflow-marketing Render service so this still works before a custom
// domain is wired up.
export const MARKETING_URL = import.meta.env.VITE_MARKETING_URL || 'https://evenflow-marketing.onrender.com';

export function goToMarketingSite() {
  window.location.href = MARKETING_URL;
}
