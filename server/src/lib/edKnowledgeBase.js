// ED's static knowledge of how EvenFlow actually works — navigation, real
// feature behavior, concepts, and pricing. This is what makes ED able to
// answer "how do I..." and "what does X do" questions instead of refusing
// everything outside the live numeric CONTEXT block (lib/edContext.js).
//
// Every fact in here is real, grounded directly in the app's actual built
// behavior (navConfig.js's real nav items/routes, the real Plan/Stripe
// pricing constants, the real role/permission model) — nothing invented.
// This file is a pure data module (no DB, no I/O) so it's cheap to import
// and trivial to keep in sync by hand as real features change.
//
// Every entry is served to every role, deliberately. Nothing in this file
// is per-account data or a secret — it's all just "how EvenFlow works,"
// equally true regardless of who's asking, so there's no privacy reason to
// withhold any of it (a Producer knowing how an Owner invites someone, or
// how Factory Reset works, is no different than a user manual). The real
// privacy boundary is enforced elsewhere: lib/edContext.js scopes the live
// CONTEXT data to this one person's own account/role, and
// edPersonality.js's hard rules tell ED to explain a feature fully even
// when the asker's own role can't perform it, while being explicit about
// who can. The `roles` field here is kept only as documentation of who a
// feature is primarily for — it is NOT used to filter what's included.

const ALL = 'ALL';

const ENTRIES = [
  // ---- Universal concepts (every role) ----
  {
    id: 'ed-itself',
    roles: ALL,
    title: 'What ED is',
    body: "ED is EvenFlow's own built-in assistant — not a separate app. ED can explain how any part of EvenFlow works, walk someone through a feature, and read real live numbers for the person it's talking to (their own leads, goals, Flow Score, etc.). ED cannot click buttons or take actions on anyone's behalf — ED can only explain how to do something, or point out who on the team can do it.",
  },
  {
    id: 'lead-lifecycle',
    roles: ALL,
    title: 'How a lead moves through the pipeline',
    body: "A lead starts at NEW, gets worked (ASSIGNED/ATTEMPTED/CONTACTED/QUOTED/QUOTED_HOT/APPOINTMENT), and ends at a terminal status: SOLD, LOST, LEFT_VM, NOT_INTERESTED, INELIGIBLE, BAD_CONTACT, DO_NOT_CONTACT, DUPLICATE, or ARCHIVED. Marking a lead SOLD records what was sold for history, but it is NOT what creates real production credit — that's a separate step (see 'Closed Sale vs. disposing a lead SOLD' below). DUPLICATE and ARCHIVED remove a lead from active lists entirely. DO_NOT_CONTACT should never be called again — the app will warn before logging a new call/text against a suppressed contact.",
  },
  {
    id: 'closed-sale-vs-disposition',
    roles: ALL,
    title: "Closed Sale vs. disposing a lead SOLD",
    body: "Dispositioning a Lead to SOLD updates its status and keeps a record of what was quoted, but it does NOT by itself create revenue or production credit — that's intentional, so a Lead's pipeline status stays separate from actual production bookkeeping. The real production record is a Closed Sale (My Sales for a Producer, Closed Sales for an Owner/Manager) — an actual dollar/policy entry that feeds Billboard, Financials, and goal progress. When a Lead is marked SOLD, the app offers a one-click prompt to also log the matching Closed Sale pre-filled from that lead's details — worth doing every time so production actually gets counted.",
  },
  {
    id: 'lead-type-icons',
    roles: ALL,
    title: 'Lead type icons',
    body: "Every lead shows a small icon indicating where it came from: a transfer icon for live telemarketer transfers, vendor-category icons for Paid Ad/Direct Mail/Meta Ad/Google Ad leads, a manual-entry icon, and a two-part combo icon (a product icon plus an exchange badge) for Winback/Cross-Sell leads — which shows which product the customer ALREADY has, so that product is intentionally not offered as a quote option on that lead (it's shown as context only).",
  },
  {
    id: 'flow-score',
    roles: ALL,
    title: 'Flow Score',
    body: "Flow Score is a 0-100 real-time performance score computed from actual activity, not a vibe or a manual rating. For a Producer it blends how fast they respond to new leads, how disciplined their pipeline work is, their conversion rate, and call-quality scores (when calls have been uploaded/scored). An Agency's own Flow Score blends team response speed, funnel health, and team call quality. Scores recompute automatically as real activity happens and keep a visible history/trend, not just a single number.",
  },
  {
    id: 'tasks',
    roles: ALL,
    title: 'Tasks',
    body: "Tasks is a real to-do list — due-today/overdue/upcoming, can be tied to a specific lead or stand alone, and can be assigned to anyone on the team. Completing a task is a simple one click action and feeds into Flow Score. Everyone — Producer, Telemarketer, Owner, Manager, Platform Owner — has a Tasks tab scoped to what they're allowed to see (a Producer sees their own; an Owner/Manager sees the whole agency's).",
  },
  {
    id: 'team-chat',
    roles: ALL,
    title: 'Team Chat',
    body: "Every agency has one persistent group chat room that automatically includes the Agency Owner, any Agency Managers, every active Producer, and any Telemarketer currently assigned to that agency — membership updates itself as people join/leave, nothing to configure. There's also a focused 'DISCUSS' thread on an individual lead for a tighter, lead-specific conversation separate from the main team room.",
  },
  {
    id: 'break-room',
    roles: ALL,
    title: 'Break Room',
    body: "Break Room is a small set of real arcade-style games (Congo Line, Buckets, Pill Pop, Full Send) people can play while genuinely on a break or on lunch — it's gated to actually being on break/lunch per the time clock, not open all the time. It has its own leaderboards and achievements.",
  },
  {
    id: 'my-hr',
    roles: ALL,
    title: 'My HR / Backstage HR basics',
    body: "Everyone has a personal HR view (My Time, My Schedule, My Time Off) showing their own timesheet derived from real clock-in/out data, their assigned shifts, and their PTO/leave balance and request history. Time clock itself (clock in/out, lunch, break) is a persistent small widget always available for Producers and Telemarketers.",
  },
  {
    id: 'notifications',
    roles: ALL,
    title: 'Notifications',
    body: "The bell icon shows real notifications — a new lead landing, a lead reassigned to you, an announcement, a chat message, a stale-lead reminder, and more. Clicking one takes you straight to the relevant lead, chat, or page. A person can mute specific notification types if they're too noisy.",
  },
  {
    id: 'announcements',
    roles: ALL,
    title: 'Announcements',
    body: "An Owner/Manager (for their own team) or a Platform Owner (platform-wide or targeted) can send a blast announcement that pops up and requires the recipient to acknowledge it before dismissing — used for anything that genuinely needs to be seen, not routine chatter.",
  },

  // ---- Producer ----
  {
    id: 'my-leads',
    roles: ['PRODUCER'],
    title: 'My Leads',
    body: "My Leads is a Producer's own queue — leads assigned to them, sorted by real priority (live transfers highest, then paid/direct-mail/meta/google ad leads, then manual, with winback/cross-sell lowest by default — an Owner can reorder this). Opening a lead shows full contact info, one-click Log Call/Log Text/Log Email/Add Note buttons, a Copy Intro Text button, an Attempts counter, and the disposition dropdown. There's also a Find a Lead search box that can locate an older lead across the whole agency by name/phone/email even if it's not currently assigned to you (read-only summary only unless it's actually your own lead).",
  },
  {
    id: 'my-sales',
    roles: ['PRODUCER'],
    title: 'My Sales',
    body: "My Sales is where a Producer's actual closed/production sales live — these are the real entries that count toward Billboard and goals (see 'Closed Sale vs. disposing a lead SOLD'). A Producer can add a sale manually (standalone, with no originating lead, for something like a referral) or from an existing lead, and can edit their own existing entries if a detail was wrong.",
  },
  {
    id: 'moshpit-producer',
    roles: ['PRODUCER'],
    title: 'Moshpit',
    body: "Moshpit is a shared pool of unassigned leads any eligible Producer can claim — fed by vendor leads configured for Moshpit distribution and by live-transfer telemarketer leads. First to click CLAIM gets it; it then behaves like any normal assigned lead.",
  },
  {
    id: 'sales-studio-producer',
    roles: ['PRODUCER'],
    title: 'Sales Studio',
    body: "Sales Studio has three parts: a Drill Library of real sales-technique lessons (with an AI roleplay partner to practice a drill live), Call Scoring (upload or paste a real call transcript and get a scored breakdown against the drill categories), and a Coaching view summarizing a Producer's own strengths/weaknesses from real call data. Sales Studio access can be gated by the agency — if it shows as locked, ask the Agency Owner.",
  },
  {
    id: 'goals-producer',
    roles: ['PRODUCER'],
    title: 'Goals',
    body: "Goals shows a Producer's own sales goal for the period with a real live pace bar (actual vs. where they should be by today) — goals are set by the Agency Owner/Manager, sometimes using plain-English AI parsing on their end ('get Jordan to 10 sales this month').",
  },

  // ---- Telemarketer ----
  {
    id: 'telemarketer-intake',
    roles: ['TELEMARKETER'],
    title: 'Submitting a lead as a Telemarketer',
    body: "The Telemarketer Home page has a rich intake form (contact info, vehicle/home details, current carrier, callback time, notes) side-by-side with the agency's Team Chat. Submitted leads appear instantly on that agency's Live Transfers view for the Owner/Manager/Producers to see — there's no accept/reject step. Checking 'this is a live transfer' flags it as urgent and also routes it straight into the Moshpit claim pool for any eligible Producer to grab immediately.",
  },
  {
    id: 'telemarketer-other',
    roles: ['TELEMARKETER'],
    title: 'A Telemarketer\'s other tabs',
    body: "My Recent Submissions shows every lead a Telemarketer has personally submitted, across every agency they're assigned to. Drills gives access to the same sales-technique drill library Producers use, for practice. A Telemarketer can be assigned to more than one agency at once and switches between them from the intake form.",
  },

  // ---- Agency Owner / Manager ----
  {
    id: 'main-stage',
    roles: ['AGENCY_OWNER', 'AGENCY_MANAGER'],
    title: 'Main Stage',
    body: "Main Stage is the Agency Owner/Manager home — the agency's Flow Score, a leads snapshot (total/in Moshpit/untouched/quoted/sold) over a selectable date range, the team roster with each producer's inline Flow Score, and office management.",
  },
  {
    id: 'live-transfers',
    roles: ['AGENCY_OWNER', 'AGENCY_MANAGER'],
    title: 'Live Transfers',
    body: "Live Transfers shows every lead that came in through a Telemarketer, with at-a-glance badges for which Telemarketer submitted it, plus the shared agency Team Chat alongside the list. If this looks empty or blocked, the agency's Transfers module may not be turned on yet — that's a Platform Owner/entitlement setting.",
  },
  {
    id: 'leads-tab',
    roles: ['AGENCY_OWNER', 'AGENCY_MANAGER'],
    title: 'Leads (Owner/Manager)',
    body: "The agency-wide Leads tab is every lead across the whole team, with the same Find a Lead search available to Producers. From here an Owner/Manager can also bulk-upload a spreadsheet of leads (fuzzy column matching, so headers don't need to match exactly), reassign a lead from one producer to another, and undo a recent bulk upload if something went wrong.",
  },
  {
    id: 'billboard',
    roles: ['AGENCY_OWNER', 'AGENCY_MANAGER'],
    title: 'Billboard',
    body: "Billboard is the leaderboard/reporting screen: Week (the most recently completed Mon-Fri), Month, Year, or All Years, each showing real sold counts, policy item counts, and premium totals, a producer leaderboard (trophy icon for #1), and breakdowns by product/vendor/zip. All figures are built from actual Closed Sales (plus any imported historical data), never from a lead merely marked SOLD with no real sale recorded.",
  },
  {
    id: 'closed-sales-owner',
    roles: ['AGENCY_OWNER', 'AGENCY_MANAGER'],
    title: 'Closed Sales (Owner/Manager)',
    body: "Closed Sales is the agency-wide version of a Producer's My Sales — every real production entry across the team, filterable by producer, with the ability to open and correct any entry (never creates a duplicate — editing updates the same record and the same revenue entry).",
  },
  {
    id: 'vendors',
    roles: ['AGENCY_OWNER', 'AGENCY_MANAGER'],
    title: 'Vendors',
    body: "Vendors is where lead sources are configured — name, product, category (Paid Ad / Direct Mail / Meta Ad / Google Ad / Other), cost per lead, and distribution mode: Round Robin (even rotation), Alpha Split (by the lead's last-name letter, per a configured map of producer-to-letters with a required fallback), Office Split (routed to a specific office first), Selected Agents (always to one or more named people), or Moshpit (dropped into the shared claim pool). A Paid Ad or Meta/Google Ad vendor can never be set to Moshpit — those always route to a specific person or rotation.",
  },
  {
    id: 'offices',
    roles: ['AGENCY_OWNER', 'AGENCY_MANAGER'],
    title: 'Offices & geographic routing',
    body: "Offices lets an agency with more than one physical location auto-route a lead to the right office by city name or ZIP range (a bulk 'paste ZIP ranges' box handles a long list in one go), with one office marked as the default fallback. Inside an office, routing can be Round Robin or Alpha Split by last-name letter among just that office's own producers (who can include an Agency Manager holding a letter seat, not just Producers).",
  },
  {
    id: 'financials-owner',
    roles: ['AGENCY_OWNER'],
    title: 'Financials',
    body: "Financials (Agency Owner only — not visible to Agency Manager) shows real revenue/cost/margin for the agency, broken down by vendor and by producer, plus the raw ledger of every revenue/cost event, over a selectable date range.",
  },
  {
    id: 'back-catalog',
    roles: ['AGENCY_OWNER', 'AGENCY_MANAGER'],
    title: 'Back Catalog',
    body: "Back Catalog imports historical records from a prior system (Performology, AgencyZoom, Ricochet, or other) via file upload, in two modes: 'Workable Leads' creates real archived Lead rows, and 'Historical Data' creates numbers-only records that are never assignable or workable but still count toward Billboard/Financials/goal totals for their real historical dates. Any import can be undone.",
  },
  {
    id: 'backstage-hr-owner',
    roles: ['AGENCY_OWNER', 'AGENCY_MANAGER'],
    title: 'Backstage HR',
    body: "Backstage HR covers employee profiles, departments/positions, real attendance built from actual clock-in/out data, shift scheduling, and PTO/leave policies and requests with a real accrual ledger. An Agency Owner always has full access; a Manager needs to be explicitly granted HR Admin or HR Auditor access by the Owner.",
  },
  {
    id: 'roster-settings',
    roles: ['AGENCY_OWNER', 'AGENCY_MANAGER'],
    title: 'Roster Settings',
    body: "Roster Settings is the hub for the team: the '+ INVITE' card (email, first/last name, role — Producer or Agency Manager) sends a real activation email with a 7-day link; RESEND re-sends it (works even for a deactivated account, to let someone reactivate); there's also hours reports, badges, birthdays, and PTO review here. A deactivated account with no real recorded activity can be permanently purged; one with real history (notes, calls, chat messages) is blocked from being purged to protect that shared history.",
  },
  {
    id: 'billing-owner',
    roles: ['AGENCY_OWNER'],
    title: 'Billing',
    body: "Standard pricing is $35 per active seat per month, plus a one-time $250 setup fee on an agency's first subscription, and an optional one-time $950 unlock for Sales Studio if it isn't already included. An agency can pick its own seat count self-serve; inviting past the paid seat count is blocked with a clear message until more seats are purchased or a Platform Owner adjusts the plan.",
  },
  {
    id: 'agency-settings',
    roles: ['AGENCY_OWNER'],
    title: 'Agency Settings',
    body: "Agency Settings holds the lead-priority configuration (which lead types rank first, and time-based rules like 'bump up a QUOTED lead after 3 days with no movement'), office hours/products, and a Danger Zone with Factory Reset — a permanent, type-to-confirm wipe of the agency's leads/financial/historical data (never touches logins, vendors, offices, or goals).",
  },
  {
    id: 'support-owner',
    roles: ['AGENCY_OWNER', 'AGENCY_MANAGER'],
    title: 'Support',
    body: "Support lets anyone file a real ticket to the EvenFlow team — ED's own escalation button creates one too, carrying along the conversation context.",
  },

  // ---- Platform Owner ----
  {
    id: 'agencies-platform',
    roles: ['PLATFORM_OWNER'],
    title: 'Agencies (Platform Owner)',
    body: "The Agencies list is every agency on the platform with roster counts, plan, and MRR, each opening into a full detail page (roster, activity feed, entitlement toggles, plan). '+ INVITE AGENCY' creates a brand-new agency and its first Owner in one step, and can also set a custom per-seat price (overriding the standard $35), comp the account entirely (no monthly charge), and choose exactly which modules (CRM, Yield Transfers, Sales Studio, Sales Studio enforcement, Break Room, Backstage HR) that agency starts with.",
  },
  {
    id: 'telemarketers-platform',
    roles: ['PLATFORM_OWNER'],
    title: 'Telemarketers (Platform Owner)',
    body: "Telemarketers is the platform-wide roster of every Telemarketer and which agencies each is currently assigned to — a Telemarketer can be assigned/unassigned to one or more agencies from here.",
  },
  {
    id: 'financials-platform',
    roles: ['PLATFORM_OWNER'],
    title: 'Financials (Platform Owner)',
    body: "Platform Financials aggregates revenue/cost/ROI across every agency on the platform. For a per-vendor or per-producer breakdown, an agency must be specified — there's no unscoped, unbounded platform-wide breakdown by design.",
  },
  {
    id: 'billing-platform',
    roles: ['PLATFORM_OWNER'],
    title: 'Billing (Platform Owner)',
    body: "A Platform Owner can manually assign any agency to any Plan (including a flat/comped plan with no Stripe billing at all) independent of the self-serve seat-based flow, and can see AI usage/estimated cost platform-wide under the usage summary.",
  },
  {
    id: 'record-store-platform',
    roles: ['PLATFORM_OWNER'],
    title: 'Record Store (Platform Owner)',
    body: "For a Platform Owner, Record Store is the real admin control center for the wholesale lead marketplace — provisioning, pausing/resuming, and volume changes for agencies that have purchased lead programs. For an Agency Owner today, Record Store is a browsable preview of the live storefront — a 'COMING SOON' banner is shown and every purchase/account button is disabled, but the full page and purchase wizard can be explored.",
  },
  {
    id: 'support-platform',
    roles: ['PLATFORM_OWNER'],
    title: 'Support (Platform Owner)',
    body: "Support tickets from every agency land here for the Platform Owner to triage and resolve, including any ticket ED itself escalated on someone's behalf.",
  },
  {
    id: 'break-room-admin',
    roles: ['PLATFORM_OWNER'],
    title: 'Break Room Admin',
    body: "Break Room Admin lets a Platform Owner review Break Room leaderboards/achievements platform-wide and manage anti-cheat flags.",
  },
];

// Returns one plain-text block (no markdown) ED's system prompt can include
// verbatim — the FULL knowledge base, every entry, regardless of role (see
// the module comment above for why). The `role` parameter is accepted for
// call-site stability and so a future genuinely role-specific entry has
// somewhere to hook in, but today every role gets everything.
function buildKnowledgeBaseForRole(_role) {
  return ENTRIES.map((e) => `${e.title}: ${e.body}`).join('\n\n');
}

module.exports = { buildKnowledgeBaseForRole, ENTRIES };
