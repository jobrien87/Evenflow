// Role -> ordered nav items. `primary: true` marks the items promoted to
// the mobile bottom tab bar (kept to a handful per role so the brief's
// critical mobile workflows are each one tap away). `secondary: true`
// marks items rendered in their own block at the BOTTOM of the desktop
// sidebar/mobile drawer, just above the account controls (Log out) —
// utility/admin tabs that don't need to compete with daily work tabs for
// top-of-list attention. `dataTour` is a stable slug rendered as a
// data-tour attribute on the item's NavLink (Sidebar.jsx/MobileDrawer.jsx)
// so the product tour (lib/tourSteps.js, ui/TourOverlay.jsx) can query and
// spotlight the real, live nav item instead of describing it in prose only.

export const NAV_BY_ROLE = {
  PRODUCER: [
    { label: 'Home', to: '/producer', icon: 'home', primary: true, dataTour: 'nav-home' },
    { label: 'Tasks', to: '/producer/tasks', icon: 'checklist', dataTour: 'nav-tasks' },
    { label: 'My Leads', to: '/producer/my-leads', icon: 'leads', primary: true, dataTour: 'nav-my-leads' },
    { label: 'Team Chat', to: '/producer/team-chat', icon: 'chat', primary: true, dataTour: 'nav-team-chat' },
    { label: 'Sales Studio', to: '/producer/sales-studio', icon: 'trophy', primary: true, dataTour: 'nav-sales-studio' },
    { label: 'Moshpit', to: '/producer/moshpit', icon: 'flame', primary: true, dataTour: 'nav-moshpit' },
    { label: 'Goals', to: '/producer/goals', icon: 'flag', dataTour: 'nav-goals' },
    { label: 'My HR', to: '/producer/my-hr', icon: 'briefcase', dataTour: 'nav-my-hr' },
    { label: 'Break Room', to: '/producer/break-room', icon: 'gamepad', dataTour: 'nav-break-room' },
  ],
  TELEMARKETER: [
    { label: 'Home', to: '/telemarketer', icon: 'home', primary: true, dataTour: 'nav-home' },
    { label: 'Drills', to: '/telemarketer/drills', icon: 'sparkle', primary: true, dataTour: 'nav-drills' },
    { label: 'Tasks', to: '/telemarketer/tasks', icon: 'checklist', dataTour: 'nav-tasks' },
    { label: 'My HR', to: '/telemarketer/my-hr', icon: 'briefcase', dataTour: 'nav-my-hr' },
    { label: 'Break Room', to: '/telemarketer/break-room', icon: 'gamepad', dataTour: 'nav-break-room' },
  ],
  // Ordered per the user's specified sequence: Main Stage, Moshpit, Live
  // Transfers, Leads, Goals, Billboard, Sales Studio, Record Store,
  // Vendors, Roster Settings — every other existing item except
  // Winbacks & Cross-Sells (removed from the sidebar — Leads replaces
  // it) is preserved, non-destructively, in a sensible position around
  // that sequence rather than removed.
  AGENCY_OWNER: [
    { label: 'Main Stage', to: '/agency', icon: 'home', primary: true, dataTour: 'nav-home' },
    { label: 'Moshpit', to: '/agency/moshpit', icon: 'flame', primary: true, dataTour: 'nav-moshpit' },
    { label: 'Live Transfers', to: '/agency/transfers', icon: 'transfer', primary: true, dataTour: 'nav-transfers' },
    { label: 'Team Chat', to: '/agency/team-chat', icon: 'chat', primary: true, dataTour: 'nav-team-chat' },
    { label: 'Leads', to: '/agency/leads', icon: 'leads', primary: true, dataTour: 'nav-leads' },
    { label: 'Tasks', to: '/agency/tasks', icon: 'checklist', dataTour: 'nav-tasks' },
    { label: 'Goals', to: '/agency/goals', icon: 'flag', primary: true, dataTour: 'nav-goals' },
    { label: 'Billboard', to: '/agency/billboard', icon: 'megaphone', dataTour: 'nav-billboard' },
    { label: 'Sales Studio', to: '/agency/sales-studio', icon: 'trophy', primary: true, dataTour: 'nav-sales-studio' },
    { label: 'Record Store', to: '/agency/record-store', icon: 'vinyl', dataTour: 'nav-record-store' },
    { label: 'Vendors', to: '/agency/vendors', icon: 'vendor', dataTour: 'nav-vendors' },
    { label: 'Financials', to: '/agency/financials', icon: 'dollar', dataTour: 'nav-financials', excludeRoles: ['AGENCY_MANAGER'] },
    { label: 'Back Catalog', to: '/agency/back-catalog', icon: 'archive', secondary: true, dataTour: 'nav-back-catalog' },
    { label: 'Backstage HR', to: '/agency/hr', icon: 'briefcase', secondary: true, dataTour: 'nav-backstage-hr' },
    { label: 'Roster Settings', to: '/agency/roster-settings', icon: 'handshake', secondary: true, dataTour: 'nav-roster-settings' },
    { label: 'Billing', to: '/agency/billing', icon: 'card', secondary: true, dataTour: 'nav-billing' },
    { label: 'Support', to: '/agency/support', icon: 'support', secondary: true, dataTour: 'nav-support' },
  ],
  PLATFORM_OWNER: [
    { label: 'Agencies', to: '/platform', icon: 'agencies', primary: true, dataTour: 'nav-home' },
    { label: 'Tasks', to: '/platform/tasks', icon: 'checklist', dataTour: 'nav-tasks' },
    { label: 'Telemarketers', to: '/platform/telemarketers', icon: 'megaphone', primary: true, dataTour: 'nav-telemarketers' },
    { label: 'Financials', to: '/platform/financials', icon: 'dollar', primary: true, dataTour: 'nav-financials' },
    { label: 'Support', to: '/platform/support', icon: 'support', primary: true, dataTour: 'nav-support' },
    { label: 'Billing', to: '/platform/billing', icon: 'card', dataTour: 'nav-billing' },
    { label: 'Sales Studio', to: '/platform/sales-studio', icon: 'trophy', dataTour: 'nav-sales-studio' },
    { label: 'Record Store', to: '/platform/record-store', icon: 'vinyl', dataTour: 'nav-record-store' },
    { label: 'Break Room Admin', to: '/platform/break-room-admin', icon: 'gamepad', secondary: true, dataTour: 'nav-break-room-admin' },
  ],
};

// AGENCY_MANAGER shares the Agency Owner's nav.
NAV_BY_ROLE.AGENCY_MANAGER = NAV_BY_ROLE.AGENCY_OWNER;

export function navForRole(role) {
  // `excludeRoles` lets a nav entry be filtered out for one role sharing
  // an array with another (e.g. AGENCY_MANAGER reuses AGENCY_OWNER's list
  // but shouldn't see every item on it) without duplicating the array.
  return (NAV_BY_ROLE[role] || []).filter((item) => !(item.excludeRoles || []).includes(role));
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
  if (role === 'AGENCY_OWNER' || role === 'AGENCY_MANAGER') return '/agency/team-chat';
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
