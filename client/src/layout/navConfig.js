// Role -> ordered nav items. `primary: true` marks the items promoted to
// the mobile bottom tab bar (kept to a handful per role so the brief's
// critical mobile workflows are each one tap away).

export const NAV_BY_ROLE = {
  PRODUCER: [
    { label: 'Home', to: '/producer', icon: 'home', primary: true },
    { label: 'Coaching', to: '/producer/coaching', icon: 'phone', primary: true },
    { label: 'Training', to: '/producer/training', icon: 'book', primary: true },
    { label: 'Winbacks & Cross-Sells', to: '/producer/opportunities', icon: 'target', primary: true },
  ],
  TELEMARKETER: [
    { label: 'Home', to: '/telemarketer', icon: 'home', primary: true },
  ],
  AGENCY_OWNER: [
    { label: 'Team & Leads', to: '/agency', icon: 'home', primary: true },
    { label: 'Yield Transfers', to: '/agency/transfers', icon: 'transfer', primary: true },
    { label: 'Financials', to: '/agency/financials', icon: 'dollar', primary: true },
    { label: 'Goals', to: '/agency/goals', icon: 'flag', primary: true },
    { label: 'Vendors', to: '/agency/vendors', icon: 'vendor' },
    { label: 'Support', to: '/agency/support', icon: 'support' },
    { label: 'Coaching', to: '/agency/coaching', icon: 'phone' },
    { label: 'Billing', to: '/agency/billing', icon: 'card' },
    { label: 'Training', to: '/agency/training', icon: 'book' },
    { label: 'Winbacks & Cross-Sells', to: '/agency/opportunities', icon: 'target' },
  ],
  PLATFORM_OWNER: [
    { label: 'Agencies', to: '/platform', icon: 'agencies', primary: true },
    { label: 'Telemarketers', to: '/platform/telemarketers', icon: 'megaphone', primary: true },
    { label: 'Financials', to: '/platform/financials', icon: 'dollar', primary: true },
    { label: 'Support', to: '/platform/support', icon: 'support', primary: true },
    { label: 'Billing', to: '/platform/billing', icon: 'card' },
    { label: 'Training', to: '/platform/training', icon: 'book' },
  ],
};

// AGENCY_MANAGER shares the Agency Owner's nav.
NAV_BY_ROLE.AGENCY_MANAGER = NAV_BY_ROLE.AGENCY_OWNER;

export function navForRole(role) {
  return NAV_BY_ROLE[role] || [];
}

export function primaryNavForRole(role) {
  return navForRole(role).filter((item) => item.primary);
}

export function basePathForRole(role) {
  if (role === 'PLATFORM_OWNER') return '/platform';
  if (role === 'AGENCY_OWNER' || role === 'AGENCY_MANAGER') return '/agency';
  if (role === 'TELEMARKETER') return '/telemarketer';
  return '/producer';
}
