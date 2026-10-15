// The real, enforced module-access flags on Agency (server/src/lib/
// entitlements.js's requireModuleEnabled/requireSalesStudioAccess read
// these exact fields). Shared by AgencyDetailPage.jsx's MODULE ACCESS
// toggles and AgenciesPanel.jsx's invite-time setup so both render the
// same checkbox list from one source.
export const ENTITLEMENT_FIELDS = [
  { key: 'crmEnabled', label: 'CRM' },
  { key: 'transfersEnabled', label: 'Yield Transfers' },
  { key: 'coachingEnabled', label: 'Sales Studio (unlocked)' },
  { key: 'salesStudioGateEnabled', label: 'Sales Studio gate enforced (off = always open)' },
  { key: 'breakRoomEnabled', label: 'Break Room Arcade' },
  { key: 'hrEnabled', label: 'Backstage HR' },
];

// The real Agency schema defaults (server/prisma/schema.prisma) — used to
// seed a brand-new invite form so leaving every checkbox untouched creates
// an agency with exactly today's defaults, unchanged.
export const DEFAULT_ENTITLEMENTS = {
  crmEnabled: true,
  transfersEnabled: false,
  coachingEnabled: false,
  salesStudioGateEnabled: true,
  breakRoomEnabled: true,
  hrEnabled: true,
};
