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

test('deriveLeadType: an APPOINTMENT_WEBHOOK vendor always yields AI_APPOINTMENT, regardless of category, unless it is a live transfer', () => {
  assert.equal(deriveLeadType({ vendorIntegrationType: 'APPOINTMENT_WEBHOOK', vendorCategory: 'OTHER' }), 'AI_APPOINTMENT');
  assert.equal(deriveLeadType({ vendorIntegrationType: 'APPOINTMENT_WEBHOOK', vendorCategory: 'PAID_AD' }), 'AI_APPOINTMENT');
  assert.equal(deriveLeadType({ isLiveTransfer: true, vendorIntegrationType: 'APPOINTMENT_WEBHOOK' }), 'TRANSFER');
});

test('deriveLeadType: a plain LEAD_POST vendor (or no integrationType at all) is unaffected by the AI_APPOINTMENT branch', () => {
  assert.equal(deriveLeadType({ vendorIntegrationType: 'LEAD_POST', vendorCategory: 'PAID_AD' }), 'PAID_AD');
  assert.equal(deriveLeadType({ vendorCategory: 'OTHER' }), 'MANUAL');
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

test('BULK_UPLOAD_CATEGORIES has exactly the 13 categories the bulk-upload UI offers', () => {
  assert.deepEqual(
    Object.keys(BULK_UPLOAD_CATEGORIES).sort(),
    ['AUTO', 'AUTO_NO_HOME', 'COMMERCIAL', 'CROSS_SELL', 'HEALTH', 'HOME', 'HOME_NO_AUTO', 'INTERNET', 'LIFE', 'REFERRAL', 'UNKNOWN', 'WALK_IN', 'WINBACK']
  );
});

test('applyBulkUploadCategory: AUTO_NO_HOME/HOME_NO_AUTO set leadTypeOverride, the available product, and the already-held product', () => {
  assert.deepEqual(applyBulkUploadCategory('AUTO_NO_HOME'), { leadTypeOverride: 'CROSS_SELL', product: 'Home', crossSellHaveProduct: 'AUTO' });
  assert.deepEqual(applyBulkUploadCategory('HOME_NO_AUTO'), { leadTypeOverride: 'CROSS_SELL', product: 'Auto', crossSellHaveProduct: 'HOME' });
});

test('applyBulkUploadCategory: Referral/Internet set leadTypeOverride, Walk In sets sourceOverride', () => {
  assert.deepEqual(applyBulkUploadCategory('REFERRAL'), { leadTypeOverride: 'REFERRAL' });
  assert.deepEqual(applyBulkUploadCategory('INTERNET'), { leadTypeOverride: 'INTERNET' });
  assert.deepEqual(applyBulkUploadCategory('WALK_IN'), { sourceOverride: 'walk_in' });
});
