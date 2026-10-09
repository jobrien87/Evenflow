// One shared lead-type vocabulary (label + icon + Badge tone) for every
// place a Lead's leadType shows up — AgencySettingsModal's priority
// reorder list, and every lead-row rendering across the app. Keeps a
// single source of truth instead of each page reinventing its own label
// map (AgencySettingsModal.jsx used to keep a private copy of this).
export const LEAD_TYPE_META = {
  TRANSFER: { label: 'Transfer', icon: 'transfer', tone: 'warning' },
  REFERRAL: { label: 'Referral', icon: 'handshake', tone: 'accent' },
  PAID_AD: { label: 'Paid Ad', icon: 'megaphone', tone: 'neutral' },
  META_AD: { label: 'Meta Ad', icon: 'megaphone', tone: 'neutral' },
  INTERNET: { label: 'Internet', icon: 'globe', tone: 'neutral' },
  DIRECT_MAIL: { label: 'Direct Mail', icon: 'mail', tone: 'neutral' },
  MANUAL: { label: 'Manual / Organic', icon: 'pencil', tone: 'neutral' },
  WINBACK: { label: 'Winback', icon: 'refresh', tone: 'accent' },
  CROSS_SELL: { label: 'Cross-Sell', icon: 'tag', tone: 'accent' },
  // AI-booked phone appointment synced in from an external calendar
  // provider (After Hours Appts) — one fixed color everywhere this type
  // renders, per the accessible-icon convention this file already uses.
  AI_APPOINTMENT: { label: 'After Hours Appts', icon: 'calendar', tone: 'accent' },
};

export const LEAD_TYPE_LABELS = Object.fromEntries(
  Object.entries(LEAD_TYPE_META).map(([key, meta]) => [key, meta.label])
);
