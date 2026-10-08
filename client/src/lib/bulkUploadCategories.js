// Keep in sync with server/src/lib/leadType.js's BULK_UPLOAD_CATEGORIES —
// what kind of list this is. Winback/Cross-Sell set the real leadType;
// the product options set Lead.product for the whole batch (taking
// precedence over whatever a CSV's own "product" column said, since the
// person uploading is explicitly declaring what this list is). Shared by
// every bulk-upload surface (the live lead-list upload and the Back
// Catalog historical import) so this list is defined once.
export const CATEGORY_OPTIONS = [
  { value: 'WINBACK', label: 'Winbacks' },
  { value: 'CROSS_SELL', label: 'Cross-Sell' },
  { value: 'AUTO_NO_HOME', label: 'Auto No Home' },
  { value: 'HOME_NO_AUTO', label: 'Home No Auto' },
  { value: 'REFERRAL', label: 'Referral' },
  { value: 'INTERNET', label: 'Internet' },
  { value: 'WALK_IN', label: 'Walk In' },
  { value: 'AUTO', label: 'Auto' },
  { value: 'HOME', label: 'Home' },
  { value: 'COMMERCIAL', label: 'Commercial' },
  { value: 'LIFE', label: 'Life' },
  { value: 'HEALTH', label: 'Health' },
  { value: 'UNKNOWN', label: 'Unknown' },
];
