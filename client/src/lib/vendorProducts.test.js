import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VENDOR_PRODUCTS, vendorProductOptions } from './vendorProducts.js';

test('vendor choices retain the existing order and add exact Boat/Motorcycle labels', () => {
  assert.deepEqual(VENDOR_PRODUCTS, ['Auto', 'Home', 'Life', 'Health', 'Boat', 'Motorcycle']);
  assert.equal(new Set(VENDOR_PRODUCTS).size, VENDOR_PRODUCTS.length);
  assert.ok(Object.isFrozen(VENDOR_PRODUCTS));
});

test('each supported product appears exactly once', () => {
  for (const product of VENDOR_PRODUCTS) {
    assert.equal(vendorProductOptions(product).filter((value) => value === product).length, 1);
  }
});

test('editing a custom or differently cased existing product preserves its exact value', () => {
  for (const product of ['General', 'Renters', 'boat', 'BOAT', 'Motor Cycle', ' Boat ']) {
    assert.deepEqual(vendorProductOptions(product), [...VENDOR_PRODUCTS, product]);
  }
  assert.equal(VENDOR_PRODUCTS.length, 6, 'custom values must not mutate shared choices');
});

test('unset values do not introduce an empty or invalid option', () => {
  for (const product of [undefined, null, '', 0, {}]) {
    assert.deepEqual(vendorProductOptions(product), VENDOR_PRODUCTS);
  }
});
