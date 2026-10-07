// Constants for the Add Closed Sale form — dropdown vocabulary observed on
// the reference form's own inspected UI (see the user's field inventory).
// Shared across every agency for now (same precedent as lib/products.js's
// PRODUCTS list) rather than a full per-agency configurable catalog, which
// is real future scope, not built this round. "OTHER" is always present on
// every carrier's policy-type list so an unconfigured/uncovered carrier
// never blocks entry — the producer can still type a free-text policy type.

const LEAD_SOURCE_OPTIONS = [
  'Allstate Web Lead', 'Call-In', 'Cross-Sale at Cross Sell - LIST', 'Cross-Sale at New Business',
  'Cross-Sale at Onboarding List', 'Cross-Sale at Service', 'Everquote', 'Family & Friends',
  'Goal Lead', 'Inferno Leads', 'Live transfer', 'Mailers', 'New Business', 'Quote Nerds',
  'Realtor Referral', 'Referral at Cross Sell - LIST', 'Referral at New Business',
  'Referral at Onboarding List', 'Referral at Service', 'Requote', 'Rewrite', 'Walk-In', 'Winback List',
];

const PRIOR_CARRIER_OPTIONS = [
  'ASI', 'Auto Owners', 'Farm Bureau', 'Farmers', 'Foremost', 'Frontline', 'Geico', 'Gulfstream',
  'Hartford', 'Infinity', 'KIN', 'Liberty Mutual', 'Mercury', 'Nationwide', 'Olympus', 'Progressive',
  'Safeco', 'State Farm', 'USAA',
];

const REASON_OPTIONS = [
  'Agent Change', 'Auto - Declination Of Late Payment', 'Bundled', 'Bundled (Preferred)',
  'Can/Rewrite (Approved)', 'Cancel/Rewrite', 'Dissatisfied - Claims', 'Dissatisfied - Service',
  'Intra-Agency Transfer', 'Monoline', 'Multi-category', 'New Purchase', 'No Prior Ins',
  'Non-Payment', 'Other', 'Property - Declination Of Late Payment', 'Rates', 'Rewrite',
  'Underwriting', 'Winback',
];

// Carrier -> detailed policy-type list. Only the two carriers actually
// inspected have a real list; every other carrier (and every policy type
// not in these two lists) falls through to the 'Other' free-text entry
// below, which the client always offers regardless of carrier.
const CARRIER_POLICY_TYPES = {
  'Allstate': [
    'Allstate Basic Term', 'Allstate Bridge UL', 'Allstate FutureBuilder UL', 'Allstate FutureGrowth UL',
    'Allstate Lifetime UL', 'Allstate TrueFit', 'Auto-Non Standard', 'Auto-Specialty', 'Auto-Standard',
    'Boat', 'Business Owners Policy', 'Business Package Policy', 'Commercial Auto',
    'Commercial Auto - Fleet', 'Commercial Umbrella', 'Condo', 'Fixed Annuity', 'Flood',
    'General Liability', 'Home', 'Inland Marine', 'Landlord', 'Mobile Home', 'Motor Club',
    'Motorcycle', 'Motorhome (RV)', 'Mutual Fund', 'Off-Road Vehicle (ATV)', 'Production Credit',
    'PUP', 'Renters', 'Scheduled Personal Property', 'Term Life - Other', 'Trailers',
    'Universal Life - Other', 'Variable Annuity', 'Variable Life', 'Whole Life',
    'Whole Life Advantage', 'Whole Life Tribute',
  ],
  'National General': [
    'Antique Auto', 'ATV', 'Auto', 'Commercial', 'Condo', 'Dental (Indiv)', 'Disability (Short-term)',
    'Flood', 'Home', 'Mobile Home', 'Other', 'Renters', 'RV', 'Short Term Medical', 'Vision (Indiv)',
  ],
};

// The full carrier/"Company" dropdown from the reference form's own
// inspected list.
const CARRIER_OPTIONS = [
  'Allstate', 'American Heritage Life', 'American Integrity', 'AMIG', 'Answer Financial', 'AXA',
  'Braishfield', 'Burns & Wilcox', 'Cabrillo Coastal', 'Chubb', 'Citizens (Fair Plan)',
  'Crump Brokerage Group', 'Cypress P&C', 'Edison', 'Federated National', 'FL Peninsula',
  'Foremost', 'GeoVera Specialty', 'Gerber Life Ins', 'Griffin Underwriting Srvs', 'Hagerty',
  'JIBNA (Jewelry Broker)', 'Lincoln Benefit Life', 'MAPFRE', 'National General',
  'Northeast Agencies', 'Northlight', 'Olympus', 'Protective Life', 'Prudential', 'RLI Corp',
  'Security First', 'Southern Fidelity', 'St James', 'St Johns', 'The Hartford', 'To Be Determined',
  'TowerHill', 'United P&C', 'Universal North America', 'Voya Financial',
];

function policyTypesForCarrier(carrier) {
  return [...(CARRIER_POLICY_TYPES[carrier] || []), 'Other'];
}

module.exports = {
  LEAD_SOURCE_OPTIONS,
  PRIOR_CARRIER_OPTIONS,
  REASON_OPTIONS,
  CARRIER_OPTIONS,
  CARRIER_POLICY_TYPES,
  policyTypesForCarrier,
};
