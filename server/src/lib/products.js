// The one canonical insurance-product vocabulary — used by the per-lead
// product quote/sale tracker (LeadProductQuote) and shared with the client.
// Label strings match what crossSellDetection.js's COMPLEMENTARY_RULES
// already expects ('Auto', 'Home', 'Life') so a product marked SOLD here
// feeds the exact same cross-sell gap detection a Transfer-sourced sale
// already does.
const PRODUCTS = ['AUTO', 'HOME', 'HOME_LANDLORD', 'RENTERS', 'LIFE', 'HEALTH', 'COMMERCIAL', 'BOAT', 'MOTORCYCLE'];

const PRODUCT_LABELS = {
  AUTO: 'Auto',
  HOME: 'Home',
  HOME_LANDLORD: 'Home - Landlord',
  RENTERS: 'Renters',
  LIFE: 'Life',
  HEALTH: 'Health',
  COMMERCIAL: 'Commercial',
  BOAT: 'Boat',
  MOTORCYCLE: 'Motorcycle',
};

// Read-time grouping only: vendor intake stores exact title-case strings,
// quote/Sale records store catalog codes, and historical exports can use
// either. Merge these two known product aliases without rewriting rows,
// changing API validation, or reclassifying any other product (e.g. SPL).
function reportingProductKey(product) {
  const code = typeof product === 'string' ? product.trim().toUpperCase() : '';
  return code === 'BOAT' || code === 'MOTORCYCLE'
    ? PRODUCT_LABELS[code]
    : product || 'Unspecified';
}

module.exports = { PRODUCTS, PRODUCT_LABELS, reportingProductKey };
