// First-login product tour content, one step array per role. Kept as plain
// data (not JSX) so TourOverlay is the only place that has to render it.
// Every step names a real, shipped feature — nothing here promises
// anything that isn't actually in the app today.

const CLOSING_CONTACT = {
  icon: 'support',
  title: 'Need something turned on?',
  body: "If a tab looks locked or you want a feature your plan doesn't include, hit Support (or ask your platform contact) — that's the fastest way to get it opened up.",
};

const STEPS_BY_ROLE = {
  PRODUCER: [
    { icon: 'home', title: 'Welcome to EvenFlow', body: "Quick lap around the app — under a minute, skip anytime." },
    { icon: 'trophy', title: 'Your Flow Score', body: 'One score for pace, quality and conversion — right at the top of your Home dashboard.' },
    { icon: 'target', title: 'Your Funnel', body: 'Real contact, quote and close rates for your own leads, updated live.' },
    { icon: 'trophy', title: 'Agency Leaderboard', body: 'See exactly where you rank against every producer at your agency, right on your dashboard.' },
    { icon: 'sparkle', title: 'ED, your AI sidekick', body: "The bubble in the corner. Ask ED anything, or glance at the ED SUGGESTS boxes scattered around the app for a proactive nudge." },
    { icon: 'chat', title: 'Team Chat', body: 'Talk to your agency and any telemarketer feeding you leads, right from the Team Chat tab.' },
    { icon: 'phone', title: 'Coaching & Training', body: 'Call review scoring and assigned courses live here — ask your agency owner if either looks locked.' },
    { icon: 'vinyl', title: 'Record Store', body: "Coming soon: buy leads directly via Boberdoo webhooks/API. For now it's a placeholder." },
    CLOSING_CONTACT,
  ],
  AGENCY_OWNER: [
    { icon: 'home', title: 'Welcome to EvenFlow', body: "Quick lap around the app — under a minute, skip anytime." },
    { icon: 'home', title: 'Team & Leads', body: 'Your home base — full roster, live leads, and your Agency Flow Score.' },
    { icon: 'trophy', title: 'Leaderboards', body: 'Vendor and producer rankings, right on your dashboard — see who is actually earning their keep.' },
    { icon: 'transfer', title: 'Yield Transfers', body: 'Every telemarketer-submitted lead lands here instantly, with a live team chat right alongside it.' },
    { icon: 'dollar', title: 'Financials', body: 'Revenue, cost, margin, and vendor cost-efficiency — real numbers, not vibes.' },
    { icon: 'flag', title: 'Goals', body: 'Describe a goal in plain English and ED parses it for you, then watch live pace against it.' },
    { icon: 'vendor', title: 'Vendors', body: 'Connect lead vendors and track cost-per-lead, cost-per-quote, and cost-per-sale.' },
    { icon: 'sparkle', title: 'ED, your AI sidekick', body: 'Ask ED anything from the bubble in the corner, or check the ED SUGGESTS boxes for a proactive read on your numbers.' },
    { icon: 'card', title: 'Billing', body: 'Manage your plan and payment method here.' },
    { icon: 'vinyl', title: 'Record Store', body: 'Coming soon: a marketplace to sell leads directly via webhooks/API.' },
    CLOSING_CONTACT,
  ],
  AGENCY_MANAGER: null, // filled in below — identical to AGENCY_OWNER
  PLATFORM_OWNER: [
    { icon: 'home', title: 'Welcome to EvenFlow', body: "Quick lap around the app — under a minute, skip anytime." },
    { icon: 'agencies', title: 'Agencies', body: 'Every agency, its MRR, roster counts, and entitlements — click into any one for the full detail page.' },
    { icon: 'megaphone', title: 'Telemarketers', body: 'Invite telemarketers, assign them to agencies, and watch assignment status roll in.' },
    { icon: 'dollar', title: 'Financials', body: 'Platform-wide revenue and cost, scoped per agency to keep every number real.' },
    { icon: 'support', title: 'Support', body: 'Every support ticket across every agency lands here.' },
    { icon: 'card', title: 'Billing', body: 'Create plans, assign subscriptions to agencies, and watch MRR roll up.' },
    { icon: 'book', title: 'Training', body: 'Manage the courses assigned platform-wide.' },
    { icon: 'vinyl', title: 'Record Store', body: 'Coming soon: a marketplace to sell leads directly via webhooks/API.' },
    { icon: 'sparkle', title: "That's the whole platform", body: 'You run it from here. If an agency needs something, Support is where it surfaces.' },
  ],
  TELEMARKETER: [
    { icon: 'home', title: 'Welcome to EvenFlow', body: "Quick lap around the app — under a minute, skip anytime." },
    { icon: 'home', title: 'Your split-screen Home', body: 'Submit a rich lead on the left, chat live with your agency team on the right — at the same time.' },
    { icon: 'trophy', title: 'Your Flow Score', body: 'Lead quality and close rate, tracked automatically from what you submit.' },
    { icon: 'leads', title: 'My Recent Submissions', body: 'Every lead you have sent, with live status — watch them turn SOLD.' },
    { icon: 'vinyl', title: 'Record Store', body: 'Coming soon.' },
    { icon: 'support', title: 'Questions?', body: 'Ask the agency you are assigned to, right in that same chat panel.' },
  ],
};

STEPS_BY_ROLE.AGENCY_MANAGER = STEPS_BY_ROLE.AGENCY_OWNER;

export function stepsForRole(role) {
  return STEPS_BY_ROLE[role] || null;
}
