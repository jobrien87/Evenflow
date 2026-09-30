// The one canonical insurance-product vocabulary — used by the per-lead
// product quote/sale tracker (LeadProductQuote) and shared with the client.
// Label strings match what crossSellDetection.js's COMPLEMENTARY_RULES
// already expects ('Auto', 'Home', 'Life') so a product marked SOLD here
// feeds the exact same cross-sell gap detection a Transfer-sourced sale
// already does.
const PRODUCTS = ['AUTO', 'HOME', 'RENTERS', 'LIFE', 'HEALTH', 'COMMERCIAL'];

const PRODUCT_LABELS = {
  AUTO: 'Auto',
  HOME: 'Home',
  RENTERS: 'Renters',
  LIFE: 'Life',
  HEALTH: 'Health',
  COMMERCIAL: 'Commercial',
};

module.exports = { PRODUCTS, PRODUCT_LABELS };
