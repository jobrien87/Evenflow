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
    { label: 'Drills', to: '/producer/drills', icon: 'sparkle', dataTour: 'nav-drills' },
    { label: 'Tasks', to: '/producer/tasks', icon: 'checklist', dataTour: 'nav-tasks' },
    { label: 'My Leads', to: '/producer/my-leads', icon: 'leads', primary: true, dataTour: 'nav-my-leads' },
    { label: 'Team Chat', to: '/producer/team-chat', icon: 'chat', primary: true, dataTour: 'nav-team-chat' },
    { label: 'Call Coaching', to: '/producer/coaching', icon: 'phone', primary: true, dataTour: 'nav-call-coaching' },
    { label: 'Training', to: '/producer/training', icon: 'book', primary: true, dataTour: 'nav-training' },
    { label: 'Moshpit', to: '/producer/moshpit', icon: 'flame', primary: true, dataTour: 'nav-moshpit' },
    { label: 'Winbacks & Cross-Sells', to: '/producer/opportunities', icon: 'target', dataTour: 'nav-opportunities' },
    { label: 'Record Store', to: '/producer/record-store', icon: 'vinyl', stub: true, dataTour: 'nav-record-store' },
  ],
  TELEMARKETER: [
    { label: 'Home', to: '/telemarketer', icon: 'home', primary: true, dataTour: 'nav-home' },
    { label: 'Drills', to: '/telemarketer/drills', icon: 'sparkle', primary: true, dataTour: 'nav-drills' },
    { label: 'Tasks', to: '/telemarketer/tasks', icon: 'checklist', dataTour: 'nav-tasks' },
    { label: 'Record Store', to: '/telemarketer/record-store', icon: 'vinyl', stub: true, dataTour: 'nav-record-store' },
  ],
  AGENCY_OWNER: [
    { label: 'Main Stage', to: '/agency', icon: 'home', primary: true, dataTour: 'nav-home' },
    { label: 'Drills', to: '/agency/drills', icon: 'sparkle', dataTour: 'nav-drills' },
    { label: 'Tasks', to: '/agency/tasks', icon: 'checklist', dataTour: 'nav-tasks' },
    { label: 'Transfers', to: '/agency/transfers', icon: 'transfer', primary: true, dataTour: 'nav-transfers' },
    { label: 'Team Chat', to: '/agency/team-chat', icon: 'chat', primary: true, dataTour: 'nav-team-chat' },
    { label: 'Call Scoring', to: '/agency/call-scoring', icon: 'trophy', primary: true, dataTour: 'nav-call-scoring' },
    { label: 'Moshpit', to: '/agency/moshpit', icon: 'flame', dataTour: 'nav-moshpit' },
    { label: 'Winbacks & Cross-Sells', to: '/agency/opportunities', icon: 'target', dataTour: 'nav-opportunities' },
    { label: 'Financials', to: '/agency/financials', icon: 'dollar', primary: true, dataTour: 'nav-financials' },
    { label: 'Goals', to: '/agency/goals', icon: 'flag', primary: true, dataTour: 'nav-goals' },
    { label: 'Vendors', to: '/agency/vendors', icon: 'vendor', dataTour: 'nav-vendors' },
    { label: 'Training', to: '/agency/training', icon: 'book', dataTour: 'nav-training' },
    { label: 'Hours Report', to: '/agency/hours-report', icon: 'clock', secondary: true, dataTour: 'nav-hours-report' },
    { label: 'Billing', to: '/agency/billing', icon: 'card', secondary: true, dataTour: 'nav-billing' },
    { label: 'Record Store', to: '/agency/record-store', icon: 'vinyl', stub: true, secondary: true, dataTour: 'nav-record-store' },
    { label: 'Coaching', to: '/agency/coaching', icon: 'phone', secondary: true, dataTour: 'nav-coaching' },
    { label: 'Support', to: '/agency/support', icon: 'support', secondary: true, dataTour: 'nav-support' },
  ],
  PLATFORM_OWNER: [
    { label: 'Agencies', to: '/platform', icon: 'agencies', primary: true, dataTour: 'nav-home' },
    { label: 'Drills', to: '/platform/drills', icon: 'sparkle', dataTour: 'nav-drills' },
    { label: 'Tasks', to: '/platform/tasks', icon: 'checklist', dataTour: 'nav-tasks' },
    { label: 'Telemarketers', to: '/platform/telemarketers', icon: 'megaphone', primary: true, dataTour: 'nav-telemarketers' },
    { label: 'Financials', to: '/platform/financials', icon: 'dollar', primary: true, dataTour: 'nav-financials' },
    { label: 'Support', to: '/platform/support', icon: 'support', primary: true, dataTour: 'nav-support' },
    { label: 'Billing', to: '/platform/billing', icon: 'card', dataTour: 'nav-billing' },
    { label: 'Training', to: '/platform/training', icon: 'book', dataTour: 'nav-training' },
    { label: 'Record Store', to: '/platform/record-store', icon: 'vinyl', stub: true, dataTour: 'nav-record-store' },
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
