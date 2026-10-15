// The one canonical insurance-product vocabulary — used by the per-lead
// product quote/sale tracker (LeadProductQuote) and shared with the client.
// Label strings match what crossSellDetection.js's COMPLEMENTARY_RULES
// already expects ('Auto', 'Home', 'Life') so a product marked SOLD here
// feeds the exact same cross-sell gap detection a Transfer-sourced sale
// already does.
const PRODUCTS = [
  'AUTO', 'HOME', 'HOME_LANDLORD', 'RENTERS', 'LIFE', 'HEALTH', 'COMMERCIAL', 'BOAT', 'MOTORCYCLE',
  'MOTORHOME', 'JEWELRY', 'PET_HEALTH', 'ROADSIDE', 'UMBRELLA',
];

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
  MOTORHOME: 'Motorhome',
  JEWELRY: 'Jewelry',
  PET_HEALTH: 'Pet Health',
  ROADSIDE: 'Roadside',
  UMBRELLA: 'Umbrella',
};

// Case-insensitive label lookup, e.g. 'AUTO' -> 'Auto', 'HOME - LANDLORD' -> 'Home - Landlord'.
const PRODUCT_LABEL_LOOKUP = Object.fromEntries(
  Object.values(PRODUCT_LABELS).map((label) => [label.toUpperCase(), label]),
);

// Read-time grouping only: vendor intake stores exact title-case strings,
// quote/Sale records store catalog codes, and historical exports (free-text,
// unvalidated spreadsheet columns) can use either, or any casing of either
// ('Auto', 'AUTO', 'auto'). Merge any casing of a known catalog code or
// label onto its one canonical label, without rewriting any stored row or
// changing API validation. A product that matches neither (e.g. 'SPL') is
// never guessed at — it passes through exactly as stored.
function reportingProductKey(product) {
  if (typeof product !== 'string' || !product.trim()) return 'Unspecified';
  const trimmed = product.trim();
  const code = trimmed.toUpperCase();
  return PRODUCT_LABELS[code] || PRODUCT_LABEL_LOOKUP[code] || trimmed;
}

module.exports = { PRODUCTS, PRODUCT_LABELS, reportingProductKey };
