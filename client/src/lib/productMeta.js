// One shared insurance-product vocabulary (label + icon) for the per-lead
// product quote/sale tracker — mirrors server/src/lib/products.js exactly
// (same codes, same label strings), so PRODUCTS.map(...) stays in the same
// order the server derives Lead.saleProduct in.
export const PRODUCT_META = {
  AUTO: { label: 'Auto', icon: 'car' },
  HOME: { label: 'Home', icon: 'home' },
  HOME_LANDLORD: { label: 'Home - Landlord', icon: 'home' },
  RENTERS: { label: 'Renters', icon: 'key' },
  LIFE: { label: 'Life', icon: 'heart' },
  HEALTH: { label: 'Health', icon: 'pulse' },
  COMMERCIAL: { label: 'Commercial', icon: 'briefcase' },
  BOAT: { label: 'Boat', icon: 'tag' },
  MOTORCYCLE: { label: 'Motorcycle', icon: 'tag' },
};

export const PRODUCTS = Object.keys(PRODUCT_META);
