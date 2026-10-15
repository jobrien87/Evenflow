const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { PRODUCTS, PRODUCT_LABELS, reportingProductKey } = require('./products');

test('quote and closed-sale catalog appends explicit Boat/Motorcycle categories', () => {
  assert.deepEqual(PRODUCTS, [
    'AUTO', 'HOME', 'HOME_LANDLORD', 'RENTERS', 'LIFE', 'HEALTH', 'COMMERCIAL', 'BOAT', 'MOTORCYCLE',
    'MOTORHOME', 'JEWELRY', 'PET_HEALTH', 'ROADSIDE', 'UMBRELLA',
  ]);
  assert.equal(PRODUCT_LABELS.BOAT, 'Boat');
  assert.equal(PRODUCT_LABELS.MOTORCYCLE, 'Motorcycle');
  assert.equal(new Set(PRODUCTS).size, PRODUCTS.length);
  assert.deepEqual(Object.keys(PRODUCT_LABELS), PRODUCTS);
});

test('client product choices and labels mirror the server catalog exactly', async () => {
  const client = await import(pathToFileURL(path.resolve(__dirname, '../../../client/src/lib/productMeta.js')).href);
  assert.deepEqual(client.PRODUCTS, PRODUCTS);
  for (const product of PRODUCTS) {
    assert.equal(client.PRODUCT_META[product].label, PRODUCT_LABELS[product]);
    assert.ok(client.PRODUCT_META[product].icon);
  }
});

test('adding Boat/Motorcycle does not invent cross-sell rules', () => {
  const { detectCrossSellGaps } = require('./crossSellDetection');
  assert.deepEqual(detectCrossSellGaps(['Boat']), []);
  assert.deepEqual(detectCrossSellGaps(['Motorcycle']), []);
  assert.deepEqual(detectCrossSellGaps(['Boat', 'Motorcycle']), []);
  assert.deepEqual(detectCrossSellGaps(['Auto', 'Boat', 'Motorcycle']), detectCrossSellGaps(['Auto']));
});

test('reporting merges any casing of a known catalog code or label onto its one canonical label, never touching an unrecognized product', () => {
  for (const alias of ['Boat', 'BOAT', 'boat', ' Boat ']) assert.equal(reportingProductKey(alias), 'Boat');
  for (const alias of ['Motorcycle', 'MOTORCYCLE', 'motorcycle', ' Motorcycle ']) assert.equal(reportingProductKey(alias), 'Motorcycle');
  // Every other catalog product merges the same way now (a vendor/historical
  // free-text column can legitimately contain any casing of 'Auto') — this
  // is the generalization of the Boat/Motorcycle-only fix above, since the
  // same casing-mismatch bug applies to every product, not just those two.
  for (const alias of ['Auto', 'AUTO', 'auto', ' Auto ']) assert.equal(reportingProductKey(alias), 'Auto');
  for (const alias of ['Home - Landlord', 'HOME_LANDLORD', 'home - landlord']) assert.equal(reportingProductKey(alias), 'Home - Landlord');
  // An unrecognized product (never in PRODUCTS/PRODUCT_LABELS) is never
  // guessed at — it passes through exactly as stored, trimmed only.
  for (const product of ['SPL', 'Specialty', 'Boat Insurance', 'Motorcycle + Boat', 'Other']) {
    assert.equal(reportingProductKey(product), product);
  }
  assert.equal(reportingProductKey(' Other '), 'Other');
  for (const product of [null, undefined, '']) assert.equal(reportingProductKey(product), 'Unspecified');
  assert.ok(PRODUCTS.includes('BOAT') && PRODUCTS.includes('MOTORCYCLE'));
});
