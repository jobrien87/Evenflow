// Role -> ordered nav items. `primary: true` marks the items promoted to
// the mobile bottom tab bar (kept to a handful per role so the brief's
// critical mobile workflows are each one tap away). `secondary: true`
// marks items rendered in their own block at the BOTTOM of the desktop
// sidebar/mobile drawer, just above the account controls (Log out) —
// utility/admin tabs that don't need to compete with daily work tabs for
// top-of-list attention.

export const NAV_BY_ROLE = {
  PRODUCER: [
    { label: 'Home', to: '/producer', icon: 'home', primary: true },
    { label: 'Drills', to: '/producer/drills', icon: 'sparkle' },
    { label: 'Tasks', to: '/producer/tasks', icon: 'checklist' },
    { label: 'My Leads', to: '/producer/my-leads', icon: 'leads', primary: true },
    { label: 'Team Chat', to: '/producer/team-chat', icon: 'chat', primary: true },
    { label: 'Call Coaching', to: '/producer/coaching', icon: 'phone', primary: true },
    { label: 'Training', to: '/producer/training', icon: 'book', primary: true },
    { label: 'Moshpit', to: '/producer/moshpit', icon: 'flame', primary: true },
    { label: 'Winbacks & Cross-Sells', to: '/producer/opportunities', icon: 'target' },
    { label: 'Record Store', to: '/producer/record-store', icon: 'vinyl', stub: true },
  ],
  TELEMARKETER: [
    { label: 'Home', to: '/telemarketer', icon: 'home', primary: true },
    { label: 'Drills', to: '/telemarketer/drills', icon: 'sparkle', primary: true },
    { label: 'Tasks', to: '/telemarketer/tasks', icon: 'checklist' },
    { label: 'Record Store', to: '/telemarketer/record-store', icon: 'vinyl', stub: true },
  ],
  AGENCY_OWNER: [
    { label: 'Main Stage', to: '/agency', icon: 'home', primary: true },
    { label: 'Drills', to: '/agency/drills', icon: 'sparkle' },
    { label: 'Tasks', to: '/agency/tasks', icon: 'checklist' },
    { label: 'Yield Transfers', to: '/agency/transfers', icon: 'transfer', primary: true },
    { label: 'Call Scoring', to: '/agency/call-scoring', icon: 'trophy', primary: true },
    { label: 'Moshpit', to: '/agency/moshpit', icon: 'flame' },
    { label: 'Winbacks & Cross-Sells', to: '/agency/opportunities', icon: 'target' },
    { label: 'Financials', to: '/agency/financials', icon: 'dollar', primary: true },
    { label: 'Goals', to: '/agency/goals', icon: 'flag', primary: true },
    { label: 'Vendors', to: '/agency/vendors', icon: 'vendor' },
    { label: 'Training', to: '/agency/training', icon: 'book' },
    { label: 'Hours Report', to: '/agency/hours-report', icon: 'clock', secondary: true },
    { label: 'Billing', to: '/agency/billing', icon: 'card', secondary: true },
    { label: 'Record Store', to: '/agency/record-store', icon: 'vinyl', stub: true, secondary: true },
    { label: 'Coaching', to: '/agency/coaching', icon: 'phone', secondary: true },
    { label: 'Support', to: '/agency/support', icon: 'support', secondary: true },
  ],
  PLATFORM_OWNER: [
    { label: 'Agencies', to: '/platform', icon: 'agencies', primary: true },
    { label: 'Drills', to: '/platform/drills', icon: 'sparkle' },
    { label: 'Tasks', to: '/platform/tasks', icon: 'checklist' },
    { label: 'Telemarketers', to: '/platform/telemarketers', icon: 'megaphone', primary: true },
    { label: 'Financials', to: '/platform/financials', icon: 'dollar', primary: true },
    { label: 'Support', to: '/platform/support', icon: 'support', primary: true },
    { label: 'Billing', to: '/platform/billing', icon: 'card' },
    { label: 'Training', to: '/platform/training', icon: 'book' },
    { label: 'Record Store', to: '/platform/record-store', icon: 'vinyl', stub: true },
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

// The two blocks the desktop Sidebar / mobile drawer render separately —
// main work tabs up top, secondary/utility tabs pinned above Log out.
export function mainNavForRole(role) {
  return navForRole(role).filter((item) => !item.secondary);
}

export function secondaryNavForRole(role) {
  return navForRole(role).filter((item) => item.secondary);
}

// Which nav item hosts the agency-wide team chat for a given role — used
// to place the unread dot (useTeamChatUnread) on the right tab. null for
// a role that isn't a chat participant (PLATFORM_OWNER).
export function teamChatNavPath(role) {
  if (role === 'AGENCY_OWNER' || role === 'AGENCY_MANAGER') return '/agency/transfers';
  if (role === 'PRODUCER') return '/producer/team-chat';
  if (role === 'TELEMARKETER') return '/telemarketer';
  return null;
}

export function basePathForRole(role) {
  if (role === 'PLATFORM_OWNER') return '/platform';
  if (role === 'AGENCY_OWNER' || role === 'AGENCY_MANAGER') return '/agency';
  if (role === 'TELEMARKETER') return '/telemarketer';
  return '/producer';
}
