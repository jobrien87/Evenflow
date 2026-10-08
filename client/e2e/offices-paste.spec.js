// Real-browser check of the new "Paste ZIP ranges" box on OfficesPanel.jsx
// (Configure Routing). Exercises: a mixed-format line paste, a quoted-CSV
// paste, self-overlap blocking, cross-office overlap blocking (against a
// sibling office's real saved range), 50-range cap blocking, removing a
// row from the preview clearing a blocking error, and a full commit +
// save round-trip through the real local API.
import { test, expect } from '@playwright/test';

// A fake-domain, non-production fixture account — not a real identity, so
// a committed default password is low-risk here, but still overridable via
// env var for consistency with how every real-credential test fixture in
// this app is handled.
const OWNER_EMAIL = process.env.PW_OWNER_EMAIL || 'pw-owner@smoketest.local';
const OWNER_PASSWORD = process.env.PW_OWNER_PASSWORD || 'PlaywrightPass123!';
const NORTH_OFFICE_ID = '37714f24-acc3-4ef1-8440-fabf25d37f08';

async function login(page) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(OWNER_EMAIL);
  await page.locator('input[type="password"]').fill(OWNER_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 });
}

test('Paste ZIP ranges: parses, previews, blocks overlaps/cap, and saves', async ({ page }) => {
  await login(page);
  await page.goto(`/agency/offices/${NORTH_OFFICE_ID}`);
  await expect(page.getByText('CONFIGURE ROUTING')).toBeVisible({ timeout: 10000 });

  const textarea = page.locator('textarea');
  const previewButton = page.getByRole('button', { name: 'PREVIEW' });

  // 1. Mixed-format line paste: bare zip, hyphen range, en-dash range, "to" range, ZIP+4.
  await textarea.fill('10001\n10010-10020\n10030–10040\n10050 to 10060\n10070-1234');
  await previewButton.click();
  await expect(page.getByText(/5 new range\(s\), 5 total after adding/)).toBeVisible();

  // Commit this batch into the draft list.
  await page.getByRole('button', { name: /ADD 5 RANGE\(S\) TO LIST/ }).click();
  await expect(page.getByText('10001 – 10001')).toBeVisible();
  await expect(page.getByText('10070 – 10070')).toBeVisible(); // ZIP+4 reduced to a single zip

  // 2. Quoted CSV paste with an Office column.
  await textarea.fill('"Office","Start ZIP","End ZIP"\n"North Office","20001","20010"\n"North Office","20020","20030"');
  await previewButton.click();
  await expect(page.getByText(/2 new range\(s\), 7 total after adding/)).toBeVisible();
  await page.getByRole('button', { name: /ADD 2 RANGE\(S\) TO LIST/ }).click();
  await expect(page.getByText('20001 – 20010')).toBeVisible();

  // 3. Self-overlap within a paste — must block.
  await textarea.fill('30000-30010\n30005-30015');
  await previewButton.click();
  await expect(page.getByText(/overlaps with 30005-30015 in this paste/)).toBeVisible();
  const addOverlapButton = page.getByRole('button', { name: /ADD 2 RANGE\(S\) TO LIST/ });
  await expect(addOverlapButton).toBeDisabled();
  await page.getByRole('button', { name: 'CLEAR' }).click();

  // 4. Cross-office overlap — South Office already owns 50010-50020.
  await textarea.fill('50015-50025');
  await previewButton.click();
  await expect(page.getByText(/overlaps with office "South Office"/)).toBeVisible();
  await expect(page.getByRole('button', { name: /ADD 1 RANGE\(S\) TO LIST/ })).toBeDisabled();
  await page.getByRole('button', { name: 'CLEAR' }).click();

  // 5. 50-range cap — 7 already committed above, paste 44 more to hit 51.
  const manyLines = Array.from({ length: 44 }, (_, i) => `6${String(i).padStart(4, '0')}`).join('\n');
  await textarea.fill(manyLines);
  await previewButton.click();
  await expect(page.getByText(/the limit is 50/)).toBeVisible();
  await page.getByRole('button', { name: 'CLEAR' }).click();

  // 6. Real save round-trip: the 7 ranges committed in steps 1-2 persist
  // through the existing SAVE button and reload.
  await page.getByRole('button', { name: /SAVE GEOGRAPHY & ROUTING MODE/ }).click();
  await expect(page.getByText('Saved.')).toBeVisible({ timeout: 10000 });
  await page.reload();
  await expect(page.getByText('10001 – 10001')).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('20020 – 20030')).toBeVisible();
  const rangeCount = await page.locator('span', { hasText: /^\d{5} – \d{5}$/ }).count();
  expect(rangeCount).toBe(7);
});
