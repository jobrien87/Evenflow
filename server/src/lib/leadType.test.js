const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveLeadType, BULK_UPLOAD_CATEGORIES, applyBulkUploadCategory } = require('./leadType');

test('deriveLeadType: live transfer always wins regardless of vendor category', () => {
  assert.equal(deriveLeadType({ isLiveTransfer: true, vendorCategory: 'PAID_AD' }), 'TRANSFER');
});

test('deriveLeadType: maps a real vendor category when not a live transfer', () => {
  assert.equal(deriveLeadType({ isLiveTransfer: false, vendorCategory: 'PAID_AD' }), 'PAID_AD');
  assert.equal(deriveLeadType({ isLiveTransfer: false, vendorCategory: 'OTHER' }), 'MANUAL');
});

test('deriveLeadType: falls back to MANUAL with no signal at all', () => {
  assert.equal(deriveLeadType({}), 'MANUAL');
});

test('applyBulkUploadCategory: Winback/Cross-Sell set leadTypeOverride, never product', () => {
  assert.deepEqual(applyBulkUploadCategory('WINBACK'), { leadTypeOverride: 'WINBACK' });
  assert.deepEqual(applyBulkUploadCategory('CROSS_SELL'), { leadTypeOverride: 'CROSS_SELL' });
});

test('applyBulkUploadCategory: product categories set product, never leadTypeOverride', () => {
  assert.deepEqual(applyBulkUploadCategory('AUTO'), { product: 'Auto' });
  assert.deepEqual(applyBulkUploadCategory('COMMERCIAL'), { product: 'Commercial' });
});

test('applyBulkUploadCategory: UNKNOWN and an unrecognized value both apply nothing', () => {
  assert.deepEqual(applyBulkUploadCategory('UNKNOWN'), {});
  assert.deepEqual(applyBulkUploadCategory('NOT_A_REAL_CATEGORY'), {});
});

test('BULK_UPLOAD_CATEGORIES has exactly the 11 categories the bulk-upload UI offers', () => {
  assert.deepEqual(
    Object.keys(BULK_UPLOAD_CATEGORIES).sort(),
    ['AUTO', 'COMMERCIAL', 'CROSS_SELL', 'HEALTH', 'HOME', 'INTERNET', 'LIFE', 'REFERRAL', 'UNKNOWN', 'WALK_IN', 'WINBACK']
  );
});

test('applyBulkUploadCategory: Referral/Internet set leadTypeOverride, Walk In sets sourceOverride', () => {
  assert.deepEqual(applyBulkUploadCategory('REFERRAL'), { leadTypeOverride: 'REFERRAL' });
  assert.deepEqual(applyBulkUploadCategory('INTERNET'), { leadTypeOverride: 'INTERNET' });
  assert.deepEqual(applyBulkUploadCategory('WALK_IN'), { sourceOverride: 'walk_in' });
});
