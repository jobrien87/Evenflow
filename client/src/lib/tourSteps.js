// Product tour content, one step array per role. Kept as plain data (not
// JSX) so TourOverlay is the only place that has to render it. Every step
// names a real, shipped feature — nothing here promises anything that
// isn't actually in the app today.
//
// Each step is { icon, title, body, route?, selector? }. `route` is a real
// path from layout/navConfig.js — TourOverlay navigates there if the user
// isn't already on it. `selector` is a real data-tour attribute value
// (rendered on the matching NavLink in Sidebar.jsx/MobileDrawer.jsx, or on
// a specific element like FlowScoreCard/EdWidget/NotificationBell) that
// TourOverlay spotlights once the element mounts. A step with neither
// field renders as a plain centered card (used only for the opening
// welcome and, for roles with no real "ask for help" nav tab, the closing
// step).

const WELCOME = {
  icon: 'home',
  title: 'Welcome to EvenFlow',
  body: "Quick walk through the app — it'll actually take you to each tab as we go. Skip anytime.",
};

const ED_STEP = {
  icon: 'sparkle',
  title: 'ED, your AI sidekick',
  body: 'The bubble in the corner. Ask ED anything, or glance at the ED SUGGESTS boxes scattered around the app for a proactive nudge.',
  selector: '[data-tour="ed-widget"]',
};

const NOTIFICATIONS_STEP = {
  icon: 'support',
  title: 'Notifications',
  body: 'Every real update — a new lead, a chat message, a stale-lead nudge — lands here first.',
  selector: '[data-tour="notification-bell"]',
};

const NO_SUPPORT_CLOSING = {
  icon: 'support',
  title: 'Need something turned on?',
  body: "If a tab looks locked or you want a feature your plan doesn't include, ask your agency owner or platform contact — that's the fastest way to get it opened up.",
};

const STEPS_BY_ROLE = {
  PRODUCER: [
    WELCOME,
    { icon: 'home', title: 'Home', body: 'This is your Home tab — Flow Score, funnel, and what to work next, always one click away.', route: '/producer', selector: '[data-tour="nav-home"]' },
    { icon: 'trophy', title: 'Your Flow Score', body: 'One score for pace, quality and conversion — right at the top of your Home dashboard.', route: '/producer', selector: '[data-tour="flow-score"]' },
    { icon: 'sparkle', title: 'Drills', body: 'Practice real sales scenarios with AI roleplay, drill by drill.', route: '/producer/drills', selector: '[data-tour="nav-drills"]' },
    { icon: 'checklist', title: 'Tasks', body: 'Everything on your plate — follow-ups, callbacks, appointments — lives here.', route: '/producer/tasks', selector: '[data-tour="nav-tasks"]' },
    { icon: 'leads', title: 'My Leads', body: 'Your real, live queue — click into any lead for full contact info, activity log, and one-click actions.', route: '/producer/my-leads', selector: '[data-tour="nav-my-leads"]' },
    { icon: 'chat', title: 'Team Chat', body: 'Talk to your agency and any telemarketer feeding you leads, right from this tab.', route: '/producer/team-chat', selector: '[data-tour="nav-team-chat"]' },
    { icon: 'phone', title: 'Call Coaching', body: 'Real call scoring against the training library, plus your own coaching breakdown.', route: '/producer/coaching', selector: '[data-tour="nav-call-coaching"]' },
    { icon: 'book', title: 'Training', body: 'Assigned courses and the full 75-drill library live here — browse and practice anytime.', route: '/producer/training', selector: '[data-tour="nav-training"]' },
    { icon: 'flame', title: 'The Moshpit', body: 'Some vendor leads go straight to a claim pool instead of one producer — first to hit CLAIM gets it. Check it often.', route: '/producer/moshpit', selector: '[data-tour="nav-moshpit"]' },
    { icon: 'vinyl', title: 'Record Store', body: "Coming soon: a marketplace to purchase Real Time Internet leads at wholesale prices. For now it's a placeholder.", route: '/producer/record-store', selector: '[data-tour="nav-record-store"]' },
    ED_STEP,
    NOTIFICATIONS_STEP,
    NO_SUPPORT_CLOSING,
  ],

  TELEMARKETER: [
    WELCOME,
    { icon: 'home', title: 'Your split-screen Home', body: 'Submit a rich lead on the left, chat live with your agency team on the right — at the same time.', route: '/telemarketer', selector: '[data-tour="nav-home"]' },
    { icon: 'trophy', title: 'Your Flow Score', body: 'Lead quality and close rate, tracked automatically from what you submit.', route: '/telemarketer', selector: '[data-tour="flow-score"]' },
    { icon: 'sparkle', title: 'Drills', body: 'Practice real sales scenarios with AI roleplay, drill by drill.', route: '/telemarketer/drills', selector: '[data-tour="nav-drills"]' },
    { icon: 'checklist', title: 'Tasks', body: 'Follow-ups and callbacks assigned to you live here.', route: '/telemarketer/tasks', selector: '[data-tour="nav-tasks"]' },
    { icon: 'vinyl', title: 'Record Store', body: 'Coming soon.', route: '/telemarketer/record-store', selector: '[data-tour="nav-record-store"]' },
    ED_STEP,
    NOTIFICATIONS_STEP,
    { icon: 'support', title: 'Questions?', body: 'Ask the agency you are assigned to, right in that same chat panel on your Home tab.' },
  ],

  AGENCY_OWNER: [
    WELCOME,
    { icon: 'home', title: 'Main Stage', body: 'Your home base — full roster and your Agency Flow Score.', route: '/agency', selector: '[data-tour="nav-home"]' },
    { icon: 'trophy', title: 'Your Agency Flow Score', body: 'One score for pace, quality and conversion across your whole team — plus vendor and producer leaderboards further down this page.', route: '/agency', selector: '[data-tour="flow-score"]' },
    { icon: 'flame', title: 'The Moshpit', body: 'A live pool of claimable leads — first producer to hit CLAIM gets it.', route: '/agency/moshpit', selector: '[data-tour="nav-moshpit"]' },
    { icon: 'transfer', title: 'Live Transfers', body: 'Every telemarketer-submitted lead lands here instantly, with a live team chat right alongside it.', route: '/agency/transfers', selector: '[data-tour="nav-transfers"]' },
    { icon: 'chat', title: 'Team Chat', body: 'The agency-wide room — you, your producers, and any assigned telemarketers, all in one thread.', route: '/agency/team-chat', selector: '[data-tour="nav-team-chat"]' },
    { icon: 'leads', title: 'Leads', body: 'Every lead your agency has — bulk-upload a list, add one manually, or drill in from a funnel stage.', route: '/agency/leads', selector: '[data-tour="nav-leads"]' },
    { icon: 'checklist', title: 'Tasks', body: 'Every open follow-up across your agency, in one place.', route: '/agency/tasks', selector: '[data-tour="nav-tasks"]' },
    { icon: 'flag', title: 'Goals', body: 'Describe a goal in plain English and ED parses it for you, then watch live pace against it.', route: '/agency/goals', selector: '[data-tour="nav-goals"]' },
    { icon: 'megaphone', title: 'Billboard', body: 'A real leaderboard — sold count and premium by producer and product line, with a trend line by day, week, month, or year.', route: '/agency/billboard', selector: '[data-tour="nav-billboard"]' },
    { icon: 'trophy', title: 'Sales Studio', body: "The full 75-drill training library with AI roleplay, plus Call Scoring — upload a producer's call for a real Drill Score, then use the Coaching Box to see any producer's weak spots over a date range.", route: '/agency/sales-studio', selector: '[data-tour="nav-sales-studio"]' },
    { icon: 'vinyl', title: 'Record Store', body: 'Coming soon: a marketplace to purchase Real Time Internet leads at wholesale prices.', route: '/agency/record-store', selector: '[data-tour="nav-record-store"]' },
    { icon: 'vendor', title: 'Vendors', body: "Connect lead vendors, track cost-per-lead, and pick exactly how each vendor's leads get distributed — Round Robin, hand-picked agents, or the Moshpit claim pool.", route: '/agency/vendors', selector: '[data-tour="nav-vendors"]' },
    { icon: 'dollar', title: 'Financials', body: 'Revenue, cost, margin, and vendor cost-efficiency — real numbers, not vibes.', route: '/agency/financials', selector: '[data-tour="nav-financials"]' },
    { icon: 'book', title: 'Training', body: 'Assign courses, track completion, and manage the drill library for your whole team.', route: '/agency/training', selector: '[data-tour="nav-training"]' },
    { icon: 'handshake', title: 'Roster Settings', body: 'Your whole team in one place — invite/deactivate, award badges, upcoming birthdays, PTO requests, and the real clock-in/out hours report.', route: '/agency/roster-settings', selector: '[data-tour="nav-roster-settings"]' },
    { icon: 'card', title: 'Billing', body: 'Manage your plan and payment method here.', route: '/agency/billing', selector: '[data-tour="nav-billing"]' },
    { icon: 'phone', title: 'Coaching', body: "A focused view into any one producer's call breakdown — the same real scoring data as Call Scoring, framed for a 1:1 conversation.", route: '/agency/coaching', selector: '[data-tour="nav-coaching"]' },
    { icon: 'support', title: 'Support', body: 'Open a ticket here any time something looks locked or broken — it reaches your platform contact directly.', route: '/agency/support', selector: '[data-tour="nav-support"]' },
    ED_STEP,
    NOTIFICATIONS_STEP,
    { icon: 'sparkle', title: "You're all set", body: 'That\'s the full agency toolkit. Re-open this tour from the Tour button any time you need a refresher — it\'ll pick up right where you are.' },
  ],

  AGENCY_MANAGER: null, // filled in below — identical to AGENCY_OWNER

  PLATFORM_OWNER: [
    WELCOME,
    { icon: 'agencies', title: 'Agencies', body: 'Every agency, its MRR, roster counts, and entitlements — click into any one for the full detail page.', route: '/platform', selector: '[data-tour="nav-home"]' },
    { icon: 'sparkle', title: 'Drills', body: 'The full 75-drill training library, managed platform-wide.', route: '/platform/drills', selector: '[data-tour="nav-drills"]' },
    { icon: 'checklist', title: 'Tasks', body: 'Open tasks across the platform.', route: '/platform/tasks', selector: '[data-tour="nav-tasks"]' },
    { icon: 'megaphone', title: 'Telemarketers', body: 'Invite telemarketers, assign them to agencies, and watch assignment status roll in.', route: '/platform/telemarketers', selector: '[data-tour="nav-telemarketers"]' },
    { icon: 'dollar', title: 'Financials', body: 'Platform-wide revenue and cost, scoped per agency to keep every number real.', route: '/platform/financials', selector: '[data-tour="nav-financials"]' },
    { icon: 'support', title: 'Support', body: 'Every support ticket across every agency lands here.', route: '/platform/support', selector: '[data-tour="nav-support"]' },
    { icon: 'card', title: 'Billing', body: 'Create plans, assign subscriptions to agencies, and watch MRR roll up.', route: '/platform/billing', selector: '[data-tour="nav-billing"]' },
    { icon: 'book', title: 'Training', body: 'Manage the courses assigned platform-wide.', route: '/platform/training', selector: '[data-tour="nav-training"]' },
    { icon: 'vinyl', title: 'Record Store', body: 'Coming soon: a marketplace to purchase Real Time Internet leads at wholesale prices.', route: '/platform/record-store', selector: '[data-tour="nav-record-store"]' },
    ED_STEP,
    NOTIFICATIONS_STEP,
    { icon: 'sparkle', title: "That's the whole platform", body: 'You run it from here. If an agency needs something, Support is where it surfaces.' },
  ],
};

STEPS_BY_ROLE.AGENCY_MANAGER = STEPS_BY_ROLE.AGENCY_OWNER;

export function stepsForRole(role) {
  return STEPS_BY_ROLE[role] || null;
}
