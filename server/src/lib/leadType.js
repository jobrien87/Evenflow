// Derives a Lead's leadType automatically at creation — never picked by
// hand. Single source of truth for both intake paths (leads.js's
// createLeadRecord and vendorApi.js's vendor-sourced creation) so the
// mapping never drifts between the two.

const VENDOR_CATEGORY_TO_LEAD_TYPE = {
  PAID_AD: 'PAID_AD',
  DIRECT_MAIL: 'DIRECT_MAIL',
  META_AD: 'META_AD',
  OTHER: 'MANUAL',
};

function deriveLeadType({ isLiveTransfer, vendorCategory }) {
  if (isLiveTransfer) return 'TRANSFER';
  if (vendorCategory) return VENDOR_CATEGORY_TO_LEAD_TYPE[vendorCategory] || 'MANUAL';
  return 'MANUAL';
}

module.exports = { deriveLeadType };
