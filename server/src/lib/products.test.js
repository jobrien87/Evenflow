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

test('reporting merges only known Boat/Motorcycle aliases without changing stored/API codes', () => {
  for (const alias of ['Boat', 'BOAT', 'boat', ' Boat ']) assert.equal(reportingProductKey(alias), 'Boat');
  for (const alias of ['Motorcycle', 'MOTORCYCLE', 'motorcycle', ' Motorcycle ']) assert.equal(reportingProductKey(alias), 'Motorcycle');
  for (const product of ['Auto', 'AUTO', 'SPL', 'Specialty', 'Boat Insurance', 'Motorcycle + Boat', ' Other ']) {
    assert.equal(reportingProductKey(product), product);
  }
  for (const product of [null, undefined, '']) assert.equal(reportingProductKey(product), 'Unspecified');
  assert.ok(PRODUCTS.includes('BOAT') && PRODUCTS.includes('MOTORCYCLE'));
});
