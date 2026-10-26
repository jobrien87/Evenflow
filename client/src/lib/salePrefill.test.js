import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSalePrefillFromLead } from './salePrefill.js';

function lead(productQuotes) {
  return { customer: {}, productQuotes };
}

test('items is absent from the prefill when there are no SOLD product quotes', () => {
  assert.equal(buildSalePrefillFromLead(lead([])).items, undefined);
  assert.equal(buildSalePrefillFromLead(lead([{ product: 'AUTO', status: 'QUOTED' }])).items, undefined);
  assert.equal(buildSalePrefillFromLead({ customer: {} }).items, undefined);
});

test('items equals the count of SOLD product quotes, as a string', () => {
  assert.equal(buildSalePrefillFromLead(lead([{ product: 'AUTO', status: 'SOLD' }])).items, '1');
  assert.equal(
    buildSalePrefillFromLead(lead([
      { product: 'AUTO', status: 'SOLD' },
      { product: 'HOME', status: 'SOLD' },
    ])).items,
    '2',
  );
  assert.equal(
    buildSalePrefillFromLead(lead([
      { product: 'AUTO', status: 'SOLD' },
      { product: 'HOME', status: 'SOLD' },
      { product: 'LIFE', status: 'QUOTED' },
    ])).items,
    '2',
  );
});
