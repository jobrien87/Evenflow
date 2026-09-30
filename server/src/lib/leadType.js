// Derives a Lead's leadType automatically at creation — never picked by
// hand. Single source of truth for both intake paths (leads.js's
// createLeadRecord and vendorApi.js's vendor-sourced creation) so the
// mapping never drifts between the two.

const VENDOR_CATEGORY_TO_LEAD_TYPE = {
  PAID_AD: 'PAID_AD',
  DIRECT_MAIL: 'DIRECT_MAIL',
  META_AD: 'META_AD',
  INTERNET: 'INTERNET',
  OTHER: 'MANUAL',
};

function deriveLeadType({ isLiveTransfer, vendorCategory }) {
  if (isLiveTransfer) return 'TRANSFER';
  if (vendorCategory) return VENDOR_CATEGORY_TO_LEAD_TYPE[vendorCategory] || 'MANUAL';
  return 'MANUAL';
}

// The explicit "what kind of list is this" categorization an Agency
// Owner/Manager picks at bulk-upload time — a bulk list has no vendor
// category or live-transfer signal for deriveLeadType to work from, so
// this is the one place a human tells the system directly. Winback/
// Cross-Sell set the real leadType (overriding deriveLeadType's default
// MANUAL); the product categories set Lead.product for the whole batch,
// taking precedence over whatever a CSV's own "product" column said,
// since the person uploading is explicitly declaring what this list is.
// sourceOverride replaces the call site's default 'bulk_upload' source string
// (see routes/leads.js's bulk-import handler) — only WALK_IN uses this,
// since a walk-in isn't really a "bulk upload," it's a batch of in-person
// visits being entered after the fact.
const BULK_UPLOAD_CATEGORIES = {
  WINBACK: { leadTypeOverride: 'WINBACK' },
  CROSS_SELL: { leadTypeOverride: 'CROSS_SELL' },
  REFERRAL: { leadTypeOverride: 'REFERRAL' },
  INTERNET: { leadTypeOverride: 'INTERNET' },
  WALK_IN: { sourceOverride: 'walk_in' },
  AUTO: { product: 'Auto' },
  HOME: { product: 'Home' },
  COMMERCIAL: { product: 'Commercial' },
  LIFE: { product: 'Life' },
  HEALTH: { product: 'Health' },
  UNKNOWN: {},
};

function applyBulkUploadCategory(category) {
  return BULK_UPLOAD_CATEGORIES[category] || {};
}

module.exports = { deriveLeadType, BULK_UPLOAD_CATEGORIES, applyBulkUploadCategory };
