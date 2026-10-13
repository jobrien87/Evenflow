// Vendor/lead intake products are exact, case-sensitive strings. This list
// is deliberately separate from the per-product quote/closed-sale catalog.
export const VENDOR_PRODUCTS = Object.freeze([
  'Auto', 'Home', 'Home - Landlord', 'Life', 'Health', 'Boat', 'Motorcycle',
]);

// The API also accepts existing custom product labels (e.g. General).
// Keep them selectable on edit rather than displaying Auto for a value
// the dropdown cannot represent, or normalizing an exact-match contract.
export function vendorProductOptions(currentProduct) {
  return typeof currentProduct === 'string' && currentProduct.length > 0 && !VENDOR_PRODUCTS.includes(currentProduct)
    ? [...VENDOR_PRODUCTS, currentProduct]
    : VENDOR_PRODUCTS;
}
