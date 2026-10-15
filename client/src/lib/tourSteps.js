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
    { icon: 'checklist', title: 'Tasks', body: 'Everything on your plate — follow-ups, callbacks, appointments — lives here.', route: '/producer/tasks', selector: '[data-tour="nav-tasks"]' },
    { icon: 'leads', title: 'My Leads', body: 'Your real, live queue — click into any lead for full contact info, activity log, and one-click actions.', route: '/producer/my-leads', selector: '[data-tour="nav-my-leads"]' },
    { icon: 'leads', title: 'At a glance', body: 'Total leads, how many are still untouched, and your real contact, quote, and close rates.', route: '/producer/my-leads', selector: '[data-tour="my-leads-stats-row"]' },
    { icon: 'leads', title: 'Vendor breakdown', body: 'See exactly which vendors are sending you leads and how well you are converting each one.', route: '/producer/my-leads', selector: '[data-tour="my-leads-vendor-breakdown"]' },
    { icon: 'leads', title: 'Filter by status', body: 'Narrow your queue down to just one status — handy when you are focused on follow-ups.', route: '/producer/my-leads', selector: '[data-tour="my-leads-status-filter"]' },
    { icon: 'leads', title: 'Your queue', body: 'The UNTOUCHED badge means nobody has logged a first attempt yet — those are your priority.', route: '/producer/my-leads', selector: '[data-tour="my-leads-table"]' },
    { icon: 'dollar', title: 'My Sales', body: 'Every closed sale credited to you — click one to correct it in place if something needs fixing.', route: '/producer/my-sales', selector: '[data-tour="nav-my-sales"]' },
    { icon: 'chat', title: 'Team Chat', body: 'Talk to your agency and any telemarketer feeding you leads, right from this tab.', route: '/producer/team-chat', selector: '[data-tour="nav-team-chat"]' },
    { icon: 'trophy', title: 'Sales Studio', body: 'Everything coaching-related in one place — two real tabs below.', route: '/producer/sales-studio', selector: '[data-tour="nav-sales-studio"]' },
    { icon: 'trophy', title: 'TP Sales Process', body: 'Your own coaching breakdown from every scored call, plus the sales training video series.', route: '/producer/sales-studio', selector: '[data-tour="sales-studio-tab-diagnostics"]' },
    { icon: 'trophy', title: 'Drills', body: 'The full 75-drill library with AI roleplay — practice real scenarios any time.', route: '/producer/sales-studio', selector: '[data-tour="sales-studio-tab-drills"]' },
    { icon: 'flame', title: 'The Moshpit', body: 'Some vendor leads go straight to a claim pool instead of one producer — first to hit CLAIM gets it. Check it often.', route: '/producer/moshpit', selector: '[data-tour="nav-moshpit"]' },
    { icon: 'flame', title: 'Claim it fast', body: 'Hit CLAIM the moment you see one you want — it is first come, first served.', route: '/producer/moshpit', selector: '[data-tour="moshpit-claim-button"]' },
    { icon: 'flag', title: 'Goals', body: 'Whatever target your manager sets for you, watch your real, live pace against it here.', route: '/producer/goals', selector: '[data-tour="nav-goals"]' },
    { icon: 'flag', title: 'Live pace', body: 'Actual-vs-target progress, updated automatically as you work — no guessing where you stand.', route: '/producer/goals', selector: '[data-tour="goals-pace-bar"]' },
    { icon: 'briefcase', title: 'My HR', body: 'Your own profile, time clock history, schedule, and time-off requests, all in one place.', route: '/producer/my-hr', selector: '[data-tour="nav-my-hr"]' },
    { icon: 'gamepad', title: 'Break Room', body: 'Take a real break — games, leaderboards, and achievements, unlocked while you are actually on break.', route: '/producer/break-room', selector: '[data-tour="nav-break-room"]' },
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
    ED_STEP,
    NOTIFICATIONS_STEP,
    { icon: 'support', title: 'Questions?', body: 'Ask the agency you are assigned to, right in that same chat panel on your Home tab.' },
  ],

  AGENCY_OWNER: [
    WELCOME,
    { icon: 'home', title: 'Main Stage', body: 'Your home base — full roster and your Agency Flow Score.', route: '/agency', selector: '[data-tour="nav-home"]' },
    { icon: 'trophy', title: 'Your Agency Flow Score', body: 'One score for pace, quality and conversion across your whole team — plus vendor and producer leaderboards further down this page.', route: '/agency', selector: '[data-tour="flow-score"]' },
    { icon: 'handshake', title: 'Your team', body: 'Your full roster, right on the home page — click anyone to see their own detail and coaching profile.', route: '/agency', selector: '[data-tour="agency-roster-section"]' },
    { icon: 'trophy', title: 'Who is leading', body: 'A quick producer leaderboard preview — the full version lives on Billboard.', route: '/agency', selector: '[data-tour="agency-leaderboard-section"]' },
    { icon: 'flame', title: 'The Moshpit', body: 'A live pool of claimable leads — first producer to hit CLAIM gets it.', route: '/agency/moshpit', selector: '[data-tour="nav-moshpit"]' },
    { icon: 'transfer', title: 'Live Transfers', body: 'Every telemarketer-submitted lead lands here the instant it is sent — no accept or reject, just a real lead to work.', route: '/agency/transfers', selector: '[data-tour="nav-transfers"]' },
    { icon: 'transfer', title: 'Discuss any lead', body: 'Click DISCUSS on any lead here to open a focused thread about just that one, separate from the agency-wide room.', route: '/agency/transfers', selector: '[data-tour="transfers-leads-list"]' },
    { icon: 'chat', title: 'Team Chat', body: 'The agency-wide room — you, your producers, and any assigned telemarketers, all in one thread.', route: '/agency/team-chat', selector: '[data-tour="nav-team-chat"]' },
    { icon: 'leads', title: 'Leads', body: 'Every lead your agency has — bulk-upload a list, add one manually, or drill in from a funnel stage.', route: '/agency/leads', selector: '[data-tour="nav-leads"]' },
    { icon: 'leads', title: 'Upload a lead list', body: 'Drop in a spreadsheet and we match columns automatically — nothing silently gets dropped.', route: '/agency/leads', selector: '[data-tour="leads-bulk-upload-button"]' },
    { icon: 'leads', title: 'Add one lead by hand', body: 'No file to upload? Add a single lead right here instead.', route: '/agency/leads', selector: '[data-tour="leads-add-button"]' },
    { icon: 'checklist', title: 'Tasks', body: 'Every open follow-up across your agency, in one place.', route: '/agency/tasks', selector: '[data-tour="nav-tasks"]' },
    { icon: 'flag', title: 'Goals', body: 'Describe a goal in plain English and ED parses it for you, then watch live pace against it.', route: '/agency/goals', selector: '[data-tour="nav-goals"]' },
    { icon: 'flag', title: 'Describe a goal', body: 'Type something like "get producers to 10 sales this month" — ED turns it into a real target automatically.', route: '/agency/goals', selector: '[data-tour="goals-ai-box"]' },
    { icon: 'flag', title: 'Live pace', body: 'Every goal shows real actual-vs-target progress and whether it is on pace, right on its own card.', route: '/agency/goals', selector: '[data-tour="goals-pace-bar"]' },
    { icon: 'megaphone', title: 'Billboard', body: 'A real leaderboard — sold count and premium by producer and product line, with a trend line by day, week, month, or year.', route: '/agency/billboard', selector: '[data-tour="nav-billboard"]' },
    { icon: 'megaphone', title: 'Switch periods', body: 'Jump between Week, Month, Year, and All Years — the whole page updates to match.', route: '/agency/billboard', selector: '[data-tour="billboard-period-tabs"]' },
    { icon: 'megaphone', title: 'Producer Leaderboard', body: 'Every active producer shows up here, even at $0 sold — the top producer each period gets the trophy.', route: '/agency/billboard', selector: '[data-tour="billboard-leaderboard"]' },
    { icon: 'megaphone', title: 'By Vendor', body: 'See exactly which vendor is producing — sold count and premium side by side.', route: '/agency/billboard', selector: '[data-tour="billboard-by-vendor"]' },
    { icon: 'megaphone', title: 'Export as CSV', body: 'Pull any breakdown as a CSV whenever you need the raw numbers.', route: '/agency/billboard', selector: '[data-tour="billboard-export"]' },
    { icon: 'dollar', title: 'Closed Sales', body: 'Every closed sale your agency has recorded — click into one to correct it in place if something is wrong.', route: '/agency/closed-sales', selector: '[data-tour="nav-closed-sales"]' },
    { icon: 'trophy', title: 'Sales Studio', body: 'Everything coaching and training lives in one place now — three real tabs below.', route: '/agency/sales-studio', selector: '[data-tour="nav-sales-studio"]' },
    { icon: 'trophy', title: 'TP Sales Process', body: "Upload any producer's call and get a real transcript plus an AI-scored breakdown.", route: '/agency/sales-studio', selector: '[data-tour="sales-studio-tab-diagnostics"]' },
    { icon: 'trophy', title: 'Drills', body: 'The full 75-drill library — anyone on your team can practice real scenarios with AI roleplay.', route: '/agency/sales-studio', selector: '[data-tour="sales-studio-tab-drills"]' },
    { icon: 'trophy', title: 'Call Scoring', body: "Upload a call on a producer's behalf, then open their full Call Scoring profile for the deeper breakdown.", route: '/agency/sales-studio', selector: '[data-tour="sales-studio-tab-scoring"]' },
    { icon: 'vinyl', title: 'Record Store', body: "Coming soon: a marketplace to purchase Real Time Internet leads at wholesale prices. For now this opens a 'coming soon' notice, not the real page.", selector: '[data-tour="nav-record-store"]' },
    { icon: 'vendor', title: 'Vendors', body: "Connect lead vendors, track cost-per-lead, and pick exactly how each vendor's leads get distributed.", route: '/agency/vendors', selector: '[data-tour="nav-vendors"]' },
    { icon: 'vendor', title: 'Add a vendor', body: 'Pick its distribution mode — Round Robin, hand-picked agents, Alpha Split, Office Split, or the Moshpit — and you get a one-time API key to hand them.', route: '/agency/vendors', selector: '[data-tour="vendors-add-button"]' },
    { icon: 'vendor', title: 'Credentials & logs', body: "CREDENTIALS shows every key issued to a vendor; LOGS shows every lead they've actually posted.", route: '/agency/vendors', selector: '[data-tour="vendors-credentials-logs"]' },
    { icon: 'dollar', title: 'Financials', body: 'Revenue, cost, margin, and vendor cost-efficiency — real numbers, not vibes.', route: '/agency/financials', selector: '[data-tour="nav-financials"]' },
    { icon: 'archive', title: 'Back Catalog', body: "Import historical leads or pure numbers-only data from a prior system — it feeds your real reports without cluttering anyone's queue.", route: '/agency/back-catalog', selector: '[data-tour="nav-back-catalog"]' },
    { icon: 'briefcase', title: 'Backstage HR', body: "Departments, time & attendance, scheduling, and PTO — your whole team's HR picture in one tab.", route: '/agency/hr', selector: '[data-tour="nav-backstage-hr"]' },
    { icon: 'handshake', title: 'Roster Settings', body: 'Your whole team lives here — invite people, award badges, and manage PTO and hours. This is the one you will use most.', route: '/agency/roster-settings', selector: '[data-tour="nav-roster-settings"]' },
    { icon: 'handshake', title: 'Invite a Producer', body: 'Fill in their email, first and last name right here.', route: '/agency/roster-settings', selector: '[data-tour="roster-invite-card"]' },
    { icon: 'handshake', title: 'Pick their role', body: 'Producer is the default — switch to Agency Manager if they need to manage the team too.', route: '/agency/roster-settings', selector: '[data-tour="roster-invite-role-select"]' },
    { icon: 'handshake', title: 'Send the invite', body: 'Click INVITE and they get a real email with a 7-day activation link the moment you do.', route: '/agency/roster-settings', selector: '[data-tour="roster-invite-submit"]' },
    { icon: 'handshake', title: "Didn't get it?", body: 'RESEND sends a fresh link any time — right from this same row.', route: '/agency/roster-settings', selector: '[data-tour="roster-resend-button"]' },
    { icon: 'handshake', title: 'PTO requests', body: 'Switch to this tab to review and approve time-off requests.', route: '/agency/roster-settings', selector: '[data-tour="roster-tab-pto"]' },
    { icon: 'handshake', title: 'Hours report', body: 'And here for the real clock-in/out hours report, pulled straight from the time clock.', route: '/agency/roster-settings', selector: '[data-tour="roster-tab-hours"]' },
    { icon: 'card', title: 'Billing', body: 'Manage your plan and payment method here.', route: '/agency/billing', selector: '[data-tour="nav-billing"]' },
    { icon: 'support', title: 'Support', body: 'Open a ticket here any time something looks locked or broken — it reaches your platform contact directly.', route: '/agency/support', selector: '[data-tour="nav-support"]' },
    ED_STEP,
    NOTIFICATIONS_STEP,
    { icon: 'sparkle', title: "You're all set", body: 'That\'s the full agency toolkit. Re-open this tour from the Tour button any time you need a refresher — it\'ll pick up right where you are.' },
  ],

  AGENCY_MANAGER: null, // filled in below — identical to AGENCY_OWNER

  PLATFORM_OWNER: [
    WELCOME,
    { icon: 'agencies', title: 'Agencies', body: 'Every agency, its MRR, roster counts, and entitlements — click into any one for the full detail page.', route: '/platform', selector: '[data-tour="nav-home"]' },
    { icon: 'checklist', title: 'Tasks', body: 'Open tasks across the platform.', route: '/platform/tasks', selector: '[data-tour="nav-tasks"]' },
    { icon: 'megaphone', title: 'Telemarketers', body: 'Invite telemarketers, assign them to agencies, and watch assignment status roll in.', route: '/platform/telemarketers', selector: '[data-tour="nav-telemarketers"]' },
    { icon: 'dollar', title: 'Financials', body: 'Platform-wide revenue and cost, scoped per agency to keep every number real.', route: '/platform/financials', selector: '[data-tour="nav-financials"]' },
    { icon: 'support', title: 'Support', body: 'Every support ticket across every agency lands here.', route: '/platform/support', selector: '[data-tour="nav-support"]' },
    { icon: 'card', title: 'Billing', body: 'Create plans, assign subscriptions to agencies, and watch MRR roll up.', route: '/platform/billing', selector: '[data-tour="nav-billing"]' },
    { icon: 'trophy', title: 'Sales Studio', body: 'The full 75-drill training library, plus course management for the training assigned platform-wide.', route: '/platform/sales-studio', selector: '[data-tour="nav-sales-studio"]' },
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
