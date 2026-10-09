// Where a signed-out user is sent. Configured at build time via
// VITE_MARKETING_URL (see render.yaml) — set it to the real public
// marketing site (e.g. https://evenflow.live) once that's actually live
// in Render (the evenflow-marketing service in render.yaml isn't
// created automatically; it needs a Blueprint sync or manual setup in
// the Render dashboard). Until then, falls back to the real deployed
// app itself, which correctly bounces a signed-out visitor to /login.
export const MARKETING_URL = import.meta.env.VITE_MARKETING_URL || 'https://evenflow-client.onrender.com';

export function goToMarketingSite() {
  window.location.href = MARKETING_URL;
}
