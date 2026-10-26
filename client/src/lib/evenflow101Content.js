// EvenFlow 101 — the agency-facing reference guide for Agency Owners and
// Agency Managers, covering what every real feature/setting in the app is,
// exactly how to configure it, and what it actually does. Static content,
// authored once (not database-backed, no admin editor) — update this file
// directly when something changes, the same way every other feature in
// this codebase gets maintained. Visually modeled on the Drill Library's
// icon-coded module cards (see DrillDetailPage.jsx), but intentionally NOT
// using Drill's data model — no quiz, no progress tracking, no AI
// roleplay. Every topic below was traced directly against the real code
// (AgencySettingsModal.jsx, the Agency schema, RosterSettingsPanel.jsx,
// BackCatalogPanel.jsx, VendorsPanel.jsx, OfficesPanel.jsx, GoalsPanel.jsx,
// etc.) rather than written from general SaaS knowledge, so a setting's
// default value and real effect here match production behavior.
//
// Shape:
//   category: { id, title, description, icon, topics: [topic, ...] }
//   topic:    { id, title, icon, summary, sections: [section, ...] }
//   section:  { heading, label, icon, tone, body: { type, items } }
//   tone:     'accent' | 'neutral' | 'danger' | 'warning'
//   body.type: 'prose' (each item is a paragraph) | 'steps' (ordered list)
//              | 'warnings' (bullet list)

export const EVENFLOW_101_CATEGORIES = [
  {
    id: 'lead-flow-automation',
    title: 'Lead Flow & Automation',
    description: 'How leads get prioritized, routed, followed up on, and flagged automatically — the settings that keep leads moving instead of going cold.',
    icon: 'target',
    topics: [
      {
        id: 'priority-rules',
        title: 'Lead Priority Rules',
        icon: 'target',
        summary: 'Controls which leads your producers see first, and auto-bumps or drops a lead the longer it sits in a status.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'Priority Rules decide the order leads appear in a producer\'s Work Queue. There are two parts: Working Order, an ordered list of lead types (for example, Live Transfer leads should outrank a cold internet lead), and Status Rules, which automatically bump a lead up, bump it down, or drop it off the active queue after it has sat in a given status for a set number of days.',
              'This is purely about ordering and visibility — it never creates a task, sends a notification, or changes a lead\'s actual status. It just controls what a producer sees as "next" when they open their queue.',
            ] },
          },
          {
            heading: 'HOW TO SET IT UP',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'From your Main Stage dashboard, click AGENCY SETTINGS.',
              'Find the Lead Flow section and the Working Order list — use the up/down arrows to rank lead types from highest to lowest priority.',
              'In the Status Rules table, add a row for any status you want to auto-manage: pick the status, how many days it can sit there, and whether it should Bump Up, Bump Down, or Drop Off after that.',
              'Save. The new order applies the next time queues are recalculated — no need to touch individual leads.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'Add a rule: FOLLOW_UP, after 3 days, Bump Down. A lead that\'s been sitting in Follow-Up for three-plus days without a new touch quietly sinks in priority so fresher leads surface first — it isn\'t removed, it\'s just no longer hogging the top of the queue while it goes stale.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'If you\'ve never touched this setting, it isn\'t "off" — your agency is already running on EvenFlow\'s seeded default ranking and rules, a sensible starting point, not a blank slate.',
              'This only reorders the queue. If you actually want a task created automatically after N days in a status, that\'s a separate setting — Follow-Up Scheduling, right below this one.',
            ] },
          },
        ],
      },
      {
        id: 'follow-up-scheduling',
        title: 'Follow-Up Scheduling',
        icon: 'checklist',
        summary: 'Automatically creates a real Follow-Up Task N days after a lead hits a given status — the setting that actually puts something on a producer\'s to-do list.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'Follow-Up Scheduling is easy to confuse with Priority Rules, but it does something different and more concrete: for any status you configure, it automatically creates a real Follow-Up Task a set number of days later. That task shows up on the producer\'s Work Queue just like any manually created to-do.',
              'Without this turned on for a status, nothing automatic happens when a lead sits there — it\'s on the producer to remember to circle back, with no system backstop.',
            ] },
          },
          {
            heading: 'HOW TO SET IT UP',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Open AGENCY SETTINGS from your dashboard.',
              'Find the Follow-Up Scheduling section.',
              'For each status worth auto-scheduling (Quoted, Appointment, Left Voicemail, etc.), set how many days later a Follow-Up Task should be created.',
              'Save. The rule applies going forward — it does not retroactively create tasks for leads already sitting in that status.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'Set FOLLOW_UP to 2 days. The moment a producer dispositions a lead to Follow-Up, a real Follow-Up Task is created with a due date two days out. The lead never silently disappears even if the producer forgets — it reappears as a task.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'An empty rule set here means nothing is auto-scheduled — which is the default if you\'ve never configured this. If your team relies on memory for callbacks, this is one of the single highest-leverage settings in the app to turn on.',
            ] },
          },
        ],
      },
      {
        id: 'speed-to-lead-sla',
        title: 'Speed-to-Lead SLA & Stale-Lead Reminders',
        icon: 'clock',
        summary: 'Two timers that catch a lead going cold — one watches the very first contact attempt, the other watches ongoing inactivity.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'Two related, but distinct, automatic alerts. Speed-to-Lead SLA watches how fast a brand-new lead gets its very first contact attempt — the clock starts the moment the lead arrives and defaults to 30 minutes if you never set it. Stale-Lead Reminders separately watches any lead, already worked or not, that has gone quiet for too long — defaulting to 4 hours of inactivity.',
              'Think of it this way: Speed-to-Lead is about the first touch only; Stale-Lead Reminders is about every touch after that.',
            ] },
          },
          {
            heading: 'HOW TO SET IT UP',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Open AGENCY SETTINGS.',
              'Find "First Attempt SLA (minutes)" — the field placeholder shows the real default, 30, if left blank.',
              'Find "Stale Lead Hours" — placeholder shows the real default, 4, if left blank.',
              'Set either number to whatever response cadence fits your team, and save.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'A team pushing a fast-response culture might tighten Speed-to-Lead to 15 minutes while leaving Stale-Lead Reminders at the 4-hour default for ongoing follow-up pacing — the two don\'t have to move together.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'Speed-to-Lead SLA only applies to real vendor-API intake — it isn\'t tracking manually entered or Back Catalog leads, since those were never a live first-response race to begin with.',
              'Setting either number too aggressively for your team\'s real capacity just creates alert fatigue that gets ignored. Pick a number your team can actually hit, then tighten it over time.',
            ] },
          },
        ],
      },
      {
        id: 'duplicate-sale-window',
        title: 'Duplicate Sale Detection Window',
        icon: 'refresh',
        summary: 'How many days EvenFlow checks around a sale date to catch the same customer being logged twice — also what keeps Billboard from double-counting history against live sales.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'Your Duplicate Sale Window (default 3 days) is a name-and-date-based check used in two places: it warns you when logging a new Closed Sale that looks like it might duplicate an existing historical record, and — just as important — it\'s what prevents Billboard from counting the same real policy twice when it exists both as an imported Back Catalog record AND a live logged Closed Sale.',
            ] },
          },
          {
            heading: 'HOW TO SET IT UP',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Open AGENCY SETTINGS.',
              'Find "Duplicate Sale Window (days)."',
              'Set a window that fits your real sales volume — wider catches more potential duplicates but has more chance of a false match; narrower is stricter but could miss a genuine duplicate logged a few days apart.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'With the default 3-day window: you import a Back Catalog file containing "John Smith, $5,000" dated May 10. Two days later someone logs a live Closed Sale for "John Smith, $5,000" dated May 12. EvenFlow recognizes these as the same real policy and Billboard counts it once, not twice.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'This is a first-name/last-name-plus-date-window match, not a hard unique ID — two genuinely different customers who happen to share a name and close within the window could theoretically be treated as the same sale. Rare, but worth knowing if your agency has a lot of volume and common names.',
              'The check on creating a NEW sale is a soft warning only, always overridable — it never blocks you from logging a real sale. The Billboard-side protection against double-counting history is the one that actually changes a number automatically.',
            ] },
          },
        ],
      },
      {
        id: 'disposition-closed-statuses',
        title: 'Disposition Notes & Closed Statuses',
        icon: 'pencil',
        summary: 'Which lead statuses require a note before a producer can use them, and which statuses count as fully "closed out" of the active pipeline.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'Two related settings. Required Disposition Notes names which statuses demand a written note before a producer can disposition a lead into them — useful for capturing a real reason, not just a status flip. Closed Lead Statuses names which statuses count as fully closed out of the active pipeline, which exempts a lead from Speed-to-Lead SLA alerts, Stale-Lead reminders, and ongoing priority recalculation once it lands there.',
            ] },
          },
          {
            heading: 'HOW TO SET IT UP',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Open AGENCY SETTINGS.',
              'Find the Required Disposition Notes chip grid — toggle on any status where you want a note mandatory (Lost and Not Interested are common choices).',
              'Find the Closed Lead Statuses chip grid — toggle which statuses should be treated as fully closed (defaults to the standard 8: Sold, Lost, Not Interested, Bad Contact, Duplicate, Do Not Contact, Ineligible, Archived).',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'Requiring a note on Lost and Not Interested means every producer leaves a real reason behind when a lead falls out — genuinely useful later for coaching conversations and for spotting patterns in why leads aren\'t converting.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'Closed Lead Statuses is distinct from the app\'s own fixed Work Queue grouping logic — changing it affects alerts and priority recompute, but does not change what actually shows up in the Work Queue itself.',
            ] },
          },
        ],
      },
      {
        id: 'coaching-threshold',
        title: 'Coaching Threshold',
        icon: 'target',
        summary: 'The call-scoring line below which a category gets flagged as a real coaching opportunity on a producer\'s profile.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'When a call is scored (see the Sales Studio topic), each scoring category gets a 0-100 result. Your Coaching Threshold (default 75) is the line below which a category is called out as a real coaching opportunity on that producer\'s Call Scoring profile, instead of blending into the noise of every score shown equally.',
            ] },
          },
          {
            heading: 'HOW TO SET IT UP',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Open AGENCY SETTINGS.',
              'Find "Coaching Threshold" and set the score below which a category should be flagged.',
              'Only meaningful once Call Scoring/Coaching is actually enabled for your agency — see the Platform Entitlements topic if it isn\'t available yet.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'Lower it to 65 if you only want the most severe issues flagged; raise it to 85 if you\'re actively pushing a team toward excellence and want more categories surfaced for discussion.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'This never changes how a call is actually scored — only the line at which a given category gets called out as needing coaching.',
            ] },
          },
        ],
      },
    ],
  },
  {
    id: 'agency-settings-admin',
    title: 'Agency Settings & Administration',
    description: 'The foundational identity fields, the module switches only your Platform Owner controls, and the one truly irreversible action in the app.',
    icon: 'gear',
    topics: [
      {
        id: 'agency-identity-basics',
        title: 'Agency Identity Basics',
        icon: 'building',
        summary: 'Agency name, timezone, and your products list — the foundational fields nearly everything else is built on top of.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'Your agency name, timezone, and the list of insurance product lines you sell. These look simple, but Timezone in particular is load-bearing — it drives the "working day" math behind Goals pacing, exactly when SLA alerts fire, and where Billboard\'s calendar-period boundaries fall.',
            ] },
          },
          {
            heading: 'HOW TO SET IT UP',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Open AGENCY SETTINGS from your Main Stage dashboard.',
              'Confirm your agency name is correct.',
              'Set your timezone in standard format (for example, America/Chicago, America/New_York, America/Denver, America/Los_Angeles).',
              'Confirm your Products list reflects everything you actually sell — this feeds choices elsewhere in the app, like Vendor and Goal setup.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'An agency actually operating on Central time but left on the default America/New_York setting will see SLA alerts, Billboard periods, and Goal pacing all running an hour off from the real workday — a simple fix once you know to look here.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'Timezone is a free-text field today with no validation against a real list — a typo won\'t be caught automatically, so enter it carefully in the standard America/City format.',
            ] },
          },
        ],
      },
      {
        id: 'platform-entitlements',
        title: 'Platform Entitlements',
        icon: 'lock',
        summary: 'The module on/off switches that live on your agency but are controlled only by your Platform Owner, not self-serve.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'A handful of module switches — CRM, Live Transfers, Coaching/Call Scoring, Break Room, Backstage HR, and a Sales Studio compliance gate — live on your agency record, but unlike the settings elsewhere in this guide, you can\'t flip these yourself. They\'re controlled by your Platform Owner, normally tied to your agency\'s plan.',
            ] },
          },
          {
            heading: 'WHERE TO SEE IT',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'There\'s nothing to configure here yourself — this topic exists so a greyed-out or unavailable module makes sense when you see it.',
              'One visible example: Roster Settings\' Break Room tab shows your Break Room module\'s current status read-only ("Module status: ON/OFF"), with a note that your Platform Owner controls it.',
              'If you want a module turned on, reach out to your Platform Owner directly.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'If Coaching/Call Scoring looks unavailable in Sales Studio even though you want to use it, that\'s almost always this — an entitlement that hasn\'t been turned on — not a bug to work around.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'Don\'t confuse these platform-level switches with the settings you genuinely do control yourself one level down — for example, once Break Room the module is on, which individual games are on is entirely your own call in Roster Settings.',
            ] },
          },
        ],
      },
      {
        id: 'factory-reset',
        title: 'Factory Reset (Danger Zone)',
        icon: 'alert',
        summary: 'Permanently wipes every lead, sale, and historical record for your agency. Not reversible. Meant for clearing test data, never a live book of business.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'warning',
            body: { type: 'prose', items: [
              'A danger-zone action at the bottom of AGENCY SETTINGS that permanently deletes every lead, every orphaned customer, transfer, opportunity, call, revenue and cost ledger entry, historical record, and import batch belonging to your agency.',
            ] },
          },
          {
            heading: 'HOW IT WORKS',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Open AGENCY SETTINGS and scroll to the Danger Zone.',
              'Review the preview of exactly what will be deleted before doing anything else.',
              'Retype your agency\'s exact name to confirm — this is the only safeguard, so take it seriously.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'The real use case is clearing out test/demo data you created while setting up EvenFlow for the first time, so you start your real production data clean — not something to reach for once you\'re live.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'danger',
            body: { type: 'warnings', items: [
              'This is NOT reversible. Every lead and every dollar of logged production is gone for good once confirmed.',
              'It deliberately spares your Users, Vendors, Offices, and Goals, so your team and routing setup survive a reset — only business data is wiped.',
            ] },
          },
        ],
      },
    ],
  },
  {
    id: 'uploads-data',
    title: 'Uploads & Data',
    description: 'Bringing leads, historical sales, and existing customer books into EvenFlow — and the real gotchas each upload path has.',
    icon: 'upload',
    topics: [
      {
        id: 'back-catalog',
        title: 'Back Catalog',
        icon: 'archive',
        summary: 'Two upload modes for backfilling legacy data: real workable leads, or history-only numbers for reporting.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'Back Catalog has two genuinely different modes. "Workable Leads" creates real Lead rows — unassigned and never dropped into Moshpit, since this is backfill, not fresh volume to ping a producer about. "Historical Data (numbers only)" creates HistoricalRecord rows instead — never workable, never visible to a producer, used purely to feed reporting and trend history like Billboard\'s historical line.',
            ] },
          },
          {
            heading: 'HOW TO SET IT UP',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Go to the Back Catalog page and choose a mode.',
              'For Workable Leads: pick your prior Source System and a Lead Category, then upload your CSV.',
              'For Historical Data: your file needs a real date column — the import is rejected outright without one — then upload.',
              'Either mode auto-matches your column headers against a wide library of recognized synonyms (name, phone, email, product, premium, items, and more), so your export doesn\'t need to match EvenFlow\'s exact field names.',
              'Review the import summary, and check Import History afterward for the undo window on this batch.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'Use Historical Data mode to pull in three years of past sales from your old system so Billboard can show a real historical trend line — those records never show up to a producer and never get "claimed" by anyone.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'danger',
            body: { type: 'warnings', items: [
              'Items and premium are never guessed. A blank cell in either column stays genuinely unknown — it is never silently defaulted to 0 or 1 — so Billboard separately tracks an "unknown" count rather than fabricating a number.',
              'Uploading the same historical file twice, or uploading history for a period where you were also logging live Closed Sales, carries a real double-counting risk. EvenFlow only catches this one direction automatically (a historical row is excluded from Billboard\'s totals if it matches a live Sale by name within your Duplicate Sale Window) — best practice is to upload history BEFORE you start logging live sales for that same period, and never re-run the same file.',
              'Every import can be undone, but only within a time-limited window shown in Import History. Once that window closes, Historical Data deletions are permanent (Workable Leads undo only un-claims leads nobody has touched yet).',
            ] },
          },
        ],
      },
      {
        id: 'bulk-lead-upload',
        title: 'Bulk Lead Upload (Live)',
        icon: 'upload',
        summary: 'The day-to-day version of a bulk upload — real, immediately assignable leads, routed by whatever distribution mode you pick.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'The live counterpart to Back Catalog\'s Workable Leads mode — same underlying engine, but these leads are immediately real and assignable, not backfill. The key difference: you pick a real Lead Distribution mode before uploading, since these leads actually get routed and producers get notified.',
            ] },
          },
          {
            heading: 'HOW TO SET IT UP',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Available from AGENCY SETTINGS and your Main Stage dashboard.',
              'Choose a Lead Distribution mode — Moshpit (unclaimed pool), Round Robin, Office Split, Alpha Split, or Selected Agents.',
              'Upload your CSV — the same fuzzy column matching as Back Catalog applies.',
              'Review the summary: leads created, how they were routed, and any rows skipped.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'Uploading a fresh batch of 200 leads from a new vendor relationship with distribution set to Round Robin spreads them evenly across your active producers right away, with real notifications firing.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'Choosing the wrong distribution mode on a large upload (say, Moshpit when you meant Round Robin) means the whole batch lands in the shared claim pool instead of being assigned directly — double-check the mode before confirming.',
            ] },
          },
        ],
      },
      {
        id: 'bulk-cross-sell-upload',
        title: 'Bulk Cross-Sell Upload',
        icon: 'exchange',
        summary: 'Import an existing book of business and turn matched customers into real Cross-Sell Opportunities.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'Uploads an externally-sourced book-of-business export — for example, "every customer with Auto but no Home" — and turns each matched row into a real Customer record plus a Cross-Sell Opportunity, ready for a producer to work.',
            ] },
          },
          {
            heading: 'HOW TO SET IT UP',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Export the relevant book from your AMS.',
              'Pick the "has X / needs Y" product pair you\'re targeting — the two products must be different (for example, has Auto, needs Home).',
              'Upload the file and review the summary: customers created versus matched to existing ones, opportunities created, and skipped rows.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'Import your AMS\'s "Auto only" book, pair Auto → Home, and every matched customer gets a real Home cross-sell Opportunity queued up to work, without anyone hand-entering a single row.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'A row missing both a name and any contact info can\'t be matched to anything and is silently skipped — always check the skipped-row count after a large import so nothing important falls through.',
            ] },
          },
        ],
      },
    ],
  },
  {
    id: 'lead-sources-routing',
    title: 'Lead Sources & Routing',
    description: 'Where your leads actually come from, how they get split across your team or offices, and buying ready-made lead programs.',
    icon: 'vendor',
    topics: [
      {
        id: 'vendors',
        title: 'Vendors',
        icon: 'vendor',
        summary: 'Every real source your leads come from, how much they cost, and exactly how each one\'s leads get routed.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'A Vendor record represents one real lead source — name, an optional Vendor Brand (groups several connections under one reportable identity, useful when one real source sends leads through multiple feeds), a category, a cost-per-lead, and a Lead Distribution mode. The category also sets the lead\'s type, which feeds directly into your Lead Priority Rules.',
            ] },
          },
          {
            heading: 'HOW TO SET IT UP',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Go to Vendors → + ADD VENDOR.',
              'Enter a name, optional Vendor Brand, and pick a category: Paid Ad, Direct Mail, Meta Ad, Google Ad, Internet, or Other.',
              'Set a cost-per-lead if you want accurate Financials/ROI reporting for this source.',
              'Choose a Lead Distribution mode: Round Robin, Selected Agents, Alpha Split, Office Split, or Moshpit.',
              'A new vendor starts at Pending status and moves through Testing → Verified → Live as you confirm it — make sure it\'s actually Live before expecting real volume.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'A new Google Ads vendor should be set to the Paid Ad category with a direct distribution mode — not Moshpit — so every lead you paid for reaches a producer immediately rather than sitting in an unclaimed pool.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'Paid Ad, Meta Ad, and Google Ad vendors are blocked from using Moshpit distribution — enforced on both the form and the server. You paid for these leads, so they can never be left to sit unclaimed by accident.',
              'An API credential is shown only once when generated — rotate it (don\'t just regenerate blindly) if a vendor integration needs a new key.',
            ] },
          },
        ],
      },
      {
        id: 'offices',
        title: 'Offices & Geography Routing',
        icon: 'building',
        summary: 'Two-stage routing for multi-office agencies: which office a lead belongs to by geography, then which producer within that office.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'If your agency has more than one physical office or territory, Offices handle two-stage routing. Stage 1 decides which office a lead belongs to, by exact city match or zip-code range. Stage 2 decides which specific producer within that office gets the lead.',
            ] },
          },
          {
            heading: 'HOW TO SET IT UP',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Open an office\'s detail page.',
              'Stage 1 — Geography: list exact cities and/or paste zip-code ranges. Mark exactly one office as the Default, which catches any lead that doesn\'t match a specific range.',
              'Stage 2 — Producer routing: choose Round Robin (optionally including managers, off by default) or Alpha Split (last-name-letter grid, with exactly one producer required as the fallback for unclaimed letters).',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'Zip ranges 60601–60699 route straight to your Chicago office\'s own producer rotation; anything outside every configured range falls to whichever office you\'ve marked Default.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'Zip ranges are checked for overlap both within the same paste and against every other office — a conflicting range is rejected outright rather than silently causing ambiguous routing later. You\'re capped at 50 ranges per office.',
              'Alpha Split needs exactly one fallback producer, or a lead with an unusual last name has nowhere to land.',
            ] },
          },
        ],
      },
      {
        id: 'record-store',
        title: 'Record Store',
        icon: 'vinyl',
        summary: 'EvenFlow\'s built-in marketplace for buying pre-packaged or custom lead programs wholesale, powered by Boberdoo.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'A marketplace inside EvenFlow for buying lead programs directly — either a ready-made template (like Auto Basic) or a custom program you request a quote on. One Boberdoo "Partner" account is created automatically for your agency the first time you need it — never one per product, just one per agency.',
            ] },
          },
          {
            heading: 'HOW TO SET IT UP',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Go to Record Store.',
              'Pick a template to buy directly, or use Build Your Own to request a custom quote.',
              'Make sure your agency\'s address and phone are on file (same fields as Agency Identity Basics) — Boberdoo requires these before it will set up your account.',
              'Fund the program\'s deposit once approved — leads start flowing automatically once funding clears.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'Select "Auto Basic" to start receiving live auto leads at a fixed daily volume, drawn automatically from your funded deposit balance — no manual ordering needed once it\'s set up.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'Status is shown in plain language (Live / Paused / Awaiting Deposit / Setup Required / Sync Issue) instead of raw provider codes. If you see "Setup Required," it usually means your agency\'s address or phone still needs to be filled in.',
            ] },
          },
        ],
      },
    ],
  },
  {
    id: 'team-roster',
    title: 'Team & Roster',
    description: 'Managing who\'s on your team, tracking goals and to-dos, and the morale features that keep people engaged.',
    icon: 'handshake',
    topics: [
      {
        id: 'roster-settings',
        title: 'Roster Settings',
        icon: 'handshake',
        summary: 'Your team management hub — invite and manage people, approve PTO, review hours, and configure Break Room.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'Roster Settings is a single page with four tabs: Roster (manage your team), Hours Report, PTO, and Break Room configuration. It\'s the one place you\'ll come back to most often for day-to-day team administration.',
            ] },
          },
          {
            heading: 'HOW TO SET IT UP — ROSTER TAB',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Use + INVITE to add a Producer or Agency Manager by email, first name, and last name.',
              'Each team member can be Deactivated (soft — their history is preserved) or, once deactivated, permanently Deleted — a permanent delete is blocked if they have any real history (notes, calls, messages, sales, coaching notes, and more).',
              'Award recognition badges manually (First Year, Five Year, Ten Year, PC/Life license) — Agent of the Month is computed automatically from real SOLD counts each month, not awarded by hand.',
              'Telemarketers are managed slightly differently here: "Remove From Agency" only ends that telemarketer\'s assignment to your specific agency — it never deletes their own account, since only a Platform Owner can do that.',
            ] },
          },
          {
            heading: 'HOW TO SET IT UP — PTO & BREAK ROOM TABS',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'PTO: team members submit a request with start/end dates and an optional reason; Managers Approve or Deny pending requests; a requester can cancel their own still-pending request.',
              'Break Room: toggle each of the four games individually, whether lunch-time play is allowed, the pick-me-up joke button, sounds, achievements, and which leaderboard scopes (office and/or agency) show — see the separate Break Room topic for the player-facing side of this.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'A permanent delete being blocked when someone has real history is intentional, not a bug — deactivate instead if you\'re ever unsure, since deactivation can always be reconsidered later and preserves everything.',
            ] },
          },
        ],
      },
      {
        id: 'goals',
        title: 'Goals',
        icon: 'flag',
        summary: 'Set and track sales goals per producer or agency-wide, with a real pacing projection, across 8 trackable metrics.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'Goals let you set a target for a producer or your whole agency across 8 metrics — sales, quotes, calls, contacts, premium, cross-sells, winbacks, and transfers — over a monthly, weekly, quarterly, or custom period, with a live pacing projection showing whether you\'re on track.',
            ] },
          },
          {
            heading: 'HOW TO SET IT UP',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Go to Goals → + NEW GOAL.',
              'Pick a metric, a target value (dollars for premium goals, a count for everything else), and a period.',
              'Or just describe it in plain English — for example, "John should close 15 sales this month" — and let the AI parser pre-fill the form for you to review and confirm.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'An agency-wide premium goal rolls up by summing every producer\'s individual target and actual — a deliberately honest combined pacing number, rather than averaging percentages, which can hide a struggling producer behind one strong one.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'Pacing projections account for your agency\'s real timezone and how many working days have actually elapsed in the period — not a naive straight-line average — so a goal set mid-month will show realistic pacing from day one.',
            ] },
          },
        ],
      },
      {
        id: 'tasks',
        title: 'Tasks',
        icon: 'checklist',
        summary: 'Discrete to-dos tied to a lead or standalone — and exactly how they feed into the Work Queue alongside everything else.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'Tasks are discrete to-dos — types include Follow-Up, Callback, Appointment, Manager, Training, Winback, and Cross-Sell — each with a due date and status, optionally tied to a specific lead.',
            ] },
          },
          {
            heading: 'HOW TO SET IT UP',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Create one manually from a lead\'s detail view, or from the Tasks page directly for something not tied to a specific lead.',
              'Or let Follow-Up Scheduling (see the Lead Flow category) create them automatically after a lead hits a configured status.',
              'Everyone sees their own list grouped into overdue, due today, and upcoming.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'A Manager-type task can flag something that needs a manager\'s specific attention — separate from the lead-related to-dos filling a producer\'s own queue.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'Tasks aren\'t a separate silo to check in addition to everything else — open tasks feed directly into the Work Queue\'s single ranked priority list alongside leads and opportunities.',
            ] },
          },
        ],
      },
      {
        id: 'break-room',
        title: 'Break Room',
        icon: 'gamepad',
        summary: 'A team-morale arcade — mini-games, leaderboards, and achievements — unlocked automatically when someone\'s actually on break.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'Break Room is a morale feature — four mini-games (Congo Line, Buckets, Full Send, Pill Pop), leaderboards, jokes, and achievements — gated behind actually being on a scheduled break or lunch, not available to click into any time.',
            ] },
          },
          {
            heading: 'HOW IT WORKS',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'For a team member: it unlocks automatically the moment they clock into Break or Lunch via the time clock widget — nothing to set up as a player.',
              'For you as Owner/Manager: configuration lives on Roster Settings\' Break Room tab — see that topic for exactly which switches you control.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'Leaderboards can be scoped to just your office, your whole agency, or both — a nice small-team morale boost without needing to compete against a much bigger sister office.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'If Break Room isn\'t showing up for your team at all, that\'s most likely the platform-level entitlement (see Platform Entitlements), not your own per-game toggles — check the module status shown read-only on the Roster Settings Break Room tab first.',
            ] },
          },
        ],
      },
    ],
  },
  {
    id: 'leads-transfers-work-queue',
    title: 'Leads, Transfers & the Work Queue',
    description: 'How a lead actually moves through your pipeline day to day, and the mandatory gate that keeps production honest.',
    icon: 'leads',
    topics: [
      {
        id: 'moshpit-work-queue',
        title: 'Moshpit & the Work Queue',
        icon: 'flame',
        summary: 'The shared unclaimed-lead pool, and the ranked "what\'s next" list every producer works from.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'Moshpit is your agency\'s shared, unclaimed lead pool — first-come-first-served — for leads from vendors configured with Moshpit distribution, or leads flagged as live transfers. The Work Queue is a producer\'s own dashboard: it merges their open leads, open tasks, and open opportunities into one ranked "what\'s next" list, driven by your Lead Priority Rules.',
            ] },
          },
          {
            heading: 'HOW IT WORKS',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Nothing to configure on these pages directly — they\'re driven entirely by Vendor distribution modes and Lead Priority Rules, covered elsewhere in this guide.',
              'Claiming a Moshpit lead is atomic — if two producers go for the same lead at once, only one wins; the other gets a friendly "too slow" message, never a silent double-assignment.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'A live transfer lands in Moshpit and immediately pings every available producer — whichever one claims it first gets it in their own Work Queue instantly.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'A lead sitting unclaimed in Moshpit isn\'t a routing bug — Moshpit is meant to be watched and claimed fast. If leads are piling up there, that\'s a team-engagement conversation, not a setting to adjust.',
            ] },
          },
        ],
      },
      {
        id: 'live-transfers',
        title: 'Live Transfers',
        icon: 'transfer',
        summary: 'Telemarketer-submitted leads with a caller live on the phone right now — urgent, immediate, and tracked separately.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'A lead becomes a Live Transfer when a telemarketer submits it with the caller actually live on the phone right now. It\'s immediately Moshpit-claimable and fires an urgent, action-level notification to available producers — this is deliberately a faster path than a normal lead.',
            ] },
          },
          {
            heading: 'HOW IT WORKS',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Nothing to configure — this is automatic based on how the telemarketer submits the lead.',
              'Use the Live Transfers page to monitor telemarketer-submitted leads: a LIVE tab with bulk-disposition tools, and a HISTORY tab.',
              'Check the per-telemarketer leaderboard here — it shows leads submitted, sold, and sold rate for each telemarketer.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'Use the telemarketer leaderboard to see which telemarketers are actually generating sold production, not just raw submission volume — a much better quality signal than call count alone.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'danger',
            body: { type: 'warnings', items: [
              'A Live Transfer needs a producer to claim it fast — if nobody\'s watching Moshpit when a transfer comes in, a real caller is sitting on hold with nobody picking up.',
            ] },
          },
        ],
      },
      {
        id: 'closed-sale-logging',
        title: 'The Closed-Sale Logging Gate',
        icon: 'dollar',
        summary: 'Why marking a lead SOLD always pops a mandatory sale-logging form — and why that\'s the single most important gate in the app.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'Whenever any lead is dispositioned to SOLD, anywhere in the app, a mandatory pop-up requires logging a real Closed Sale — carrier, policy type, premium, issued/effective/expiration dates, items count — before it goes away. Cancel reverts the lead\'s status back to what it was, rather than leaving an orphaned SOLD lead with no sale behind it.',
              'This exists because a SOLD lead with no logged sale is exactly how real revenue silently disappears from Billboard and Financials — the gate makes that structurally impossible.',
            ] },
          },
          {
            heading: 'HOW IT WORKS',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Nothing to configure — this gate is always on for every role that can disposition a lead.',
              'When a producer marks a lead SOLD (from the Work Queue\'s quick action, the lead detail status dropdown, or a product quote reaching SOLD), the sale-logging form opens immediately, pre-filled with everything already known about the lead.',
              'Review Closed Sales afterward — a Producer sees only their own sales; Owners and Managers see the whole agency, with a producer filter and date-range presets.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'If a sale needs correcting after the fact — wrong premium, wrong carrier — click the row in Closed Sales to reopen the same form in edit mode. There\'s no hard delete, only Void (Owner/Manager/Platform Owner only), which preserves history instead of erasing it.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'This is not optional and can\'t be configured off — treat it as a feature, not friction. It\'s the one thing standing between a real sale and a number that quietly never shows up anywhere.',
            ] },
          },
        ],
      },
    ],
  },
  {
    id: 'dashboards-coaching-communication',
    title: 'Dashboards, Coaching & Communication',
    description: 'Where to actually look to understand performance and profitability, how your team gets better, and how everyone talks to each other.',
    icon: 'megaphone',
    topics: [
      {
        id: 'billboard-vs-financials',
        title: 'Billboard vs. Financials',
        icon: 'megaphone',
        summary: 'Two dashboards that look similar but answer very different questions — who\'s producing, versus whether you\'re actually profitable.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'Billboard is the "who\'s producing" scoreboard — sold counts and premium totals by producer and by product for a selectable period, visible to everyone including producers. Financials is the real profit-and-loss view — actual revenue events against actual cost events, margin %, and ROI % — visible only to Agency Owner and Platform Owner, never Producers.',
              'Both pull from the exact same real logged-sale data — never from a lead simply reaching SOLD with no sale actually logged (see the Closed-Sale Logging Gate topic) — so the two numbers should always agree on what counts as real.',
            ] },
          },
          {
            heading: 'HOW TO USE THEM',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Check Billboard for team competition, leaderboard standings, and a quick pulse on sold volume for a period.',
              'Check Financials when the question is actually "are we making money" — it factors in vendor lead costs, telemarketer costs, and other real expenses that Billboard never touches.',
              'Financials also shows a per-vendor cost/ROI breakdown at the agency level — useful for deciding whether a given lead source is actually worth its cost.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'Billboard tells you Sarah sold 12 policies this month. Financials tells you whether your agency, after vendor costs and telemarketer costs, is actually making money this month — two different and both necessary questions.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'Billboard includes historical Back Catalog data when available (shown as "includes N historical" next to the total); Closed Sales, the Leaderboard, and the Running Report do not. A number that looks different between two dashboards is usually this, not an error.',
            ] },
          },
        ],
      },
      {
        id: 'sales-studio',
        title: 'Sales Studio',
        icon: 'trophy',
        summary: 'The single home for coaching and training — call analysis, the Drills library, and Call Scoring.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'Sales Studio bundles everything coaching- and training-related in one place. TP Sales Process covers call upload, transcript, and AI analysis, plus a Coaching Video Theater. Drills is a 75-drill practice library with live AI roleplay — the same visual style this EvenFlow 101 guide is built in. Call Scoring (Owner/Manager only) lets you upload a producer\'s call on their behalf and review their full scoring breakdown.',
            ] },
          },
          {
            heading: 'HOW TO SET IT UP',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Go to Sales Studio and pick the relevant tab for what you need.',
              'Availability of Coaching/Call Scoring specifically depends on the Coaching entitlement — see Platform Entitlements if it\'s not showing up yet.',
              'A Producer\'s course/lesson completion progress now lives inside Drills itself — there isn\'t a separate standalone Training tab for agency roles anymore.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'After a tough call, a producer can pull up the matching Drill for a quick refresher and even run an AI roleplay of the exact scenario, or an Owner/Manager can upload that same call for scoring and review it together.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'If Call Scoring looks missing entirely, check the Coaching entitlement first — it\'s a platform-controlled switch, not something to search for inside Sales Studio itself.',
            ] },
          },
        ],
      },
      {
        id: 'team-chat-dms',
        title: 'Team Chat & Direct Messages',
        icon: 'chat',
        summary: 'One agency-wide chat room, focused per-lead discussion threads, and 1:1 Direct Messages.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'Team Chat is one agency-wide room every team member — including producers — is automatically part of. The same chat component also powers focused per-lead discussion threads, and 1:1 Direct Messages.',
            ] },
          },
          {
            heading: 'HOW TO USE IT',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Nothing to configure — Team Chat is automatic for every team member.',
              'React to a message with a quick emoji, or reply-to a specific message to keep a side conversation threaded.',
              'Type @FirstName LastName to notify someone directly, or @team to ping the whole room.',
              'Open a lead\'s own Discuss thread for a focused conversation scoped to that lead specifically.',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              '@mention a producer directly inside a lead\'s own discussion thread to ask a quick question without ever leaving that lead\'s page.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'Only a Platform Owner can START a brand-new Direct Message with anyone platform-wide. As an Agency Owner or Manager, you can reply to a DM once someone starts one with you, but you won\'t see your own DM-starting picker.',
            ] },
          },
        ],
      },
      {
        id: 'ed-ai-assistant',
        title: 'ED, the AI Assistant',
        icon: 'sparkle',
        summary: 'A floating AI assistant on every page for every role — grounded in your agency\'s real, live numbers, never a guess.',
        sections: [
          {
            heading: 'WHAT IT IS',
            label: 'Concept', icon: 'sparkle', tone: 'accent',
            body: { type: 'prose', items: [
              'ED is EvenFlow\'s built-in AI assistant — a floating button available on every page for every role. It can answer free-form questions, give a one-tap daily briefing, surface small contextual suggestions on certain pages, and escalate a conversation into a real support ticket when it genuinely can\'t help.',
            ] },
          },
          {
            heading: 'HOW TO USE IT',
            label: 'Steps', icon: 'checklist', tone: 'neutral',
            body: { type: 'steps', items: [
              'Click ED\'s floating button on any page to open a chat.',
              'Pick your own humor level — Low, Normal, or Spicy — from ED\'s gear icon; this only changes tone, never substance.',
              'ED\'s button can now be dragged anywhere on screen — drag it to wherever\'s out of your way, and it\'ll stay there.',
              'Ask it a real question about your own data — for example, "how\'s my team pacing to goal this month" or "which vendor is underperforming."',
            ] },
          },
          {
            heading: 'REAL EXAMPLE',
            label: 'Walkthrough', icon: 'chat', tone: 'neutral',
            body: { type: 'prose', items: [
              'Ask ED "how do I set up a Lead Priority Rule" and it\'ll walk you through the real steps — or, if the answer genuinely depends on something only your Platform Owner controls, it\'ll tell you that directly instead of pretending it can do it for you.',
            ] },
          },
          {
            heading: 'WATCH OUT FOR',
            label: 'Watch Out', icon: 'alert', tone: 'warning',
            body: { type: 'warnings', items: [
              'ED is hard-constrained to never fabricate a number — if it doesn\'t have real data for something, it says so rather than inventing a plausible-sounding answer.',
              'ED can\'t take actions in the app on your behalf — it can\'t create a sale or flip a setting for you. It can only explain the real steps, or tell you who has to do it if your role can\'t.',
            ] },
          },
        ],
      },
    ],
  },
];
