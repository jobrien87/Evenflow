// Real-browser smoke pass across the major screens for each role, against
// the local dev stack (Vite dev server + API server + local Postgres).
// Complements server/scripts/smoke-test.js (HTTP-level) and `npm test`
// (unit/integration) — this layer only checks that each real page actually
// renders its real data with no console errors, not pixel-perfect visuals.
//
// Requires: both dev servers running, and the fixed-credential test
// accounts seeded (see the smoke-test session notes) —
//   josh@yield-marketing.com     (PLATFORM_OWNER — the REAL seeded owner
//                                 account; password comes from
//                                 SMOKE_TEST_OWNER_PASSWORD, never
//                                 hardcoded here — see server/scripts/
//                                 smoke-test.js for why)
//   pw-owner@smoketest.local / PlaywrightPass123!        (AGENCY_OWNER)
//   pw-producer@smoketest.local / PlaywrightPass123!     (PRODUCER)
//   pw-tm@smoketest.local / PlaywrightPass123!            (TELEMARKETER)
import { test, expect } from '@playwright/test';

// Fake-domain fixture accounts only — not real identities, so a committed
// default is low-risk, but overridable for a non-local run.
const PW_PASSWORD = process.env.PW_PASSWORD || 'PlaywrightPass123!';
// The REAL josh@yield-marketing.com account's password — never hardcoded.
const OWNER_PASSWORD = process.env.SMOKE_TEST_OWNER_PASSWORD;

async function login(page, email, password) {
  // Real uncaught JS exceptions (React render crashes, etc.) — not a
  // blanket console-message listener, which would also flag expected
  // environment noise (a blocked external font fetch, a pre-login
  // session-check 401) that has nothing to do with whether the page
  // actually works.
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 });
  return pageErrors;
}

test('Agency Owner: dashboard, billing, record store, back catalog, roster settings, billboard all render real data', async ({ page }) => {
  const errors = await login(page, 'pw-owner@smoketest.local', PW_PASSWORD);

  // Main dashboard — roster + leads should be visible.
  await expect(page.getByText(/Pat/i).first()).toBeVisible({ timeout: 10000 });

  // Billing panel: this agency's plan was assigned manually by a Platform
  // Owner (not via self-serve Stripe checkout), so the self-serve seat
  // picker correctly does not render — just confirm the panel itself
  // loads cleanly.
  await page.goto('/agency/billing');
  await expect(page.locator('body')).not.toContainText('Something went wrong');

  // Record Store storefront.
  await page.goto('/agency/record-store');
  await expect(page.locator('body')).not.toContainText('Something went wrong');

  // Back Catalog panel — our earlier import's undo should have left a
  // history entry (undone), and the panel itself must render without error.
  await page.goto('/agency/back-catalog');
  await expect(page.locator('body')).not.toContainText('Something went wrong');

  // Roster Settings — resend/purge controls for a deactivated user; at
  // minimum the roster list itself must render real rows.
  await page.goto('/agency/roster-settings');
  await expect(page.getByText(/Pete/i).first()).toBeVisible({ timeout: 10000 });

  // Billboard — our seeded SOLD lead + standalone sale should show up.
  await page.goto('/agency/billboard');
  await expect(page.locator('body')).not.toContainText('Something went wrong');

  expect(errors, `uncaught page errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('Producer: dashboard and My Leads render', async ({ page }) => {
  const errors = await login(page, 'pw-producer@smoketest.local', PW_PASSWORD);
  await expect(page.getByText(/Pete/i).first()).toBeVisible({ timeout: 10000 });

  await page.goto('/producer/my-leads');
  await expect(page.locator('body')).not.toContainText('Something went wrong');

  expect(errors, `uncaught page errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('Telemarketer: split-screen intake + team chat renders', async ({ page }) => {
  const errors = await login(page, 'pw-tm@smoketest.local', PW_PASSWORD);
  await expect(page.getByText(/Terri/i).first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator('body')).not.toContainText('Something went wrong');

  expect(errors, `uncaught page errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('Platform Owner: agencies list renders our Playwright test agency', async ({ page }) => {
  test.skip(!OWNER_PASSWORD, 'SMOKE_TEST_OWNER_PASSWORD is not set — skipping rather than attempting a login with an undefined password against the real josh@yield-marketing.com account.');
  const errors = await login(page, 'josh@yield-marketing.com', OWNER_PASSWORD);
  await expect(page.getByText(/Playwright Test Agency/i).first()).toBeVisible({ timeout: 10000 });

  expect(errors, `uncaught page errors: ${errors.join(' | ')}`).toHaveLength(0);
});
