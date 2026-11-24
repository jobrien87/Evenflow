// Realistic demo-agency data generator — replaces the old, tiny
// seedDemoAgencyData (28 leads / 10 sales / 2 vendors) stub. Builds 6
// months of believable, high-volume activity for a demo agency: vendor-
// sourced leads, telemarketer live transfers, lead notes/tasks, a
// Cross-Sell/Winback opportunity pipeline, per-producer monthly goals,
// and the full HR picture (clock entries, PTO, Break Room, Backstage HR
// employee profiles/departments/shifts/leave) — so a demo account looks
// like a real, mature, busy agency rather than an empty shell, without
// ever touching the agency's real roster/billing.
//
// Deliberately does NOT reuse createSaleRecord/updateCustomerProductsAnd-
// DetectCrossSells for its bulk-pool sales — that live cross-sell auto-
// detector would silently create extra Opportunity rows past the exact
// Cross-Sell/Winback counts this seeder is asked to produce (a fresh
// single-product demo customer almost always trips a detected gap). It
// posts the one piece every dashboard actually reads (a matching
// RevenueEvent row, built directly) instead, and builds the Opportunity
// pool itself, explicitly, at exact counts.
//
// Also deliberately breaks from this codebase's own "never createMany a
// Lead/Sale" precedent for every high-volume row this seeder writes.
// Existing bulk paths (bulk-import, Back Catalog) loop one create() at a
// time because they need live distribution/notification/priority-
// scoring/edit-history logic; this seeder is purely backdated synthetic
// data with no such history to reconcile, so a plain chunked createMany
// is correct and far faster.
//
// Row construction is flushed to the database every LEAD_FLUSH_DAYS days
// (not accumulated for the full 6 months before a single write) — on a
// single-worker deploy (Render sets WEB_CONCURRENCY=1 by default), tens
// of thousands of JS object allocations done in one unbroken synchronous
// stretch block the event loop for every other concurrent request on the
// whole server, logins included, for as long as it takes. Each `await`
// on a real database round trip yields control back to the event loop,
// so regular flushing keeps both peak memory and max single-stretch CPU
// time bounded regardless of how large `months`/`leadsPerDay` are.
const crypto = require('crypto');
const { prisma } = require('./db');
const { recordAudit } = require('./audit');
const { PRODUCTS, PRODUCT_LABELS } = require('./products');
const { deriveLeadType } = require('./leadType');
const { computeAgencyScore, computeProducerScore, computeTelemarketerScore } = require('./flowScore');

const DEFAULTS = {
  months: 6,
  leadsPerDay: 300,
  transfersPerDay: 27, // a subset of leadsPerDay, not additional
  transferCloseRate: 0.25,
  // Josh gave no close rate for the plain vendor-sourced pool — this is my
  // own reasonable assumption for a colder, lower-intent lead mix.
  generalCloseRate: 0.09,
  crossSellCount: 4000,
  winbackCount: 4000,
  opportunityCloseRate: 0.25,
  itemsAverage: 1.5,
  goalTargetItems: 100,
  vendorAvgCostCents: 525,
};

// How many calendar days of lead/customer/cost-event/note/task rows to
// build in memory before flushing to the database and moving on to the
// next chunk — see the file header comment for why this matters.
const LEAD_FLUSH_DAYS = 10;

const CARRIERS = ['Allstate', 'Progressive', 'State Farm', 'Nationwide', 'Travelers', 'Liberty Mutual', 'GEICO'];
const DEMO_LAST_NAMES = ['Alvarez', 'Baxter', 'Chen', 'Delgado', 'Esposito', 'Franklin', 'Gutierrez', 'Harmon', 'Ibrahim', 'Jorgensen', 'Kowalski', 'Lindqvist', 'Monroe', 'Nguyen', 'Osei', 'Pruitt', 'Quintero', 'Reyes', 'Sato', 'Thibodeaux'];
const DEMO_FIRST_NAMES = ['Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Avery', 'Reese', 'Quinn', 'Rowan', 'Sawyer', 'Dakota', 'Emerson', 'Hayden', 'Jamie', 'Kendall', 'Logan', 'Parker', 'Skyler', 'Tatum', 'Blair'];

// Real Georgia zips, weighted into three visible tiers for the Zip
// Breakdown report (computeZipBreakdown sorts by lead volume descending,
// so weight directly controls which tier a zip lands in).
const GA_ZIP_TIERS = [
  // dominant — Atlanta metro core
  { zip: '30308', weight: 40 }, { zip: '30318', weight: 36 }, { zip: '30144', weight: 32 },
  // moderate — surrounding suburbs
  { zip: '30075', weight: 12 }, { zip: '30060', weight: 11 }, { zip: '30350', weight: 10 }, { zip: '30101', weight: 9 }, { zip: '30342', weight: 8 },
  // rare — long tail across the rest of the state
  { zip: '31201', weight: 2 }, { zip: '31401', weight: 2 }, { zip: '30909', weight: 1 }, { zip: '31601', weight: 1 },
  { zip: '31901', weight: 1 }, { zip: '30438', weight: 1 }, { zip: '31705', weight: 1 }, { zip: '30545', weight: 1 },
  { zip: '31520', weight: 1 }, { zip: '30830', weight: 1 }, { zip: '31794', weight: 1 }, { zip: '30577', weight: 1 },
];

const CROSS_SELL_PRODUCTS = ['Auto', 'Home', 'Life'];
const WINBACK_LOST_REASONS = ['Price', 'Non-renewal', 'Moved out of state', 'Switched carriers', 'Coverage no longer needed'];

const SOLD_NOTES = [
  'Policy bound and premium confirmed. Welcome packet sent.',
  'Closed — signed application received, first payment processed.',
  'Sale finalized. Customer asked about adding coverage at next renewal.',
  'Bound today. Declarations page emailed, confirmed customer received it.',
];
const LOST_NOTES = [
  'Went with a competitor on price. No further action.',
  'Not interested at this time — asked not to be contacted further.',
  'Could not reach after multiple attempts. Closing out.',
  'Already has coverage through a family member\'s agency.',
  'Budget doesn\'t work right now. Left door open for next renewal.',
];
const WORKING_NOTES = [
  'Spoke with customer, gathering info for a full quote.',
  'Quote delivered — following up early next week.',
  'Scheduled a callback to review options.',
  'Customer comparing a couple of options, staying in touch.',
  'Left a message, will try again tomorrow.',
  'Sent the quote over email, waiting to hear back.',
];
const TERMINAL_UNSOLD_STATUSES = new Set(['LOST', 'NOT_INTERESTED', 'DO_NOT_CONTACT', 'BAD_CONTACT']);
// Statuses that can only be reached after an actual live conversation —
// used to decide which leads get a firstContactAt, not just a
// firstAttemptAt (see buildLeadBundle: a terminal-unsold lead may or may
// not have ever actually been reached, so it only gets a probabilistic
// chance at contact; these always do).
const CONTACTED_LIKE_STATUSES = new Set(['CONTACTED', 'QUOTED', 'FOLLOW_UP', 'APPOINTMENT', 'SOLD']);

function uuid() {
  return crypto.randomUUID();
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function createManyChunked(model, rows, size = 2000) {
  for (const batch of chunk(rows, size)) {
    if (batch.length === 0) continue;
    await model.createMany({ data: batch });
  }
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randomChoice(arr) {
  return arr[randomInt(0, arr.length - 1)];
}

// items = [{ value, weight }] -> one value, weighted.
function weightedPick(items) {
  const total = items.reduce((sum, i) => sum + i.weight, 0);
  let roll = Math.random() * total;
  for (const item of items) {
    if (roll < item.weight) return item.value;
    roll -= item.weight;
  }
  return items[items.length - 1].value;
}

// Mix of 1/2/3 averaging almost exactly 1.5 items per sale.
function randomItems() {
  return weightedPick([{ value: 1, weight: 0.55 }, { value: 2, weight: 0.40 }, { value: 3, weight: 0.05 }]);
}

function randomPremiumCents(productFamily) {
  const ranges = {
    AUTO: [9000, 22000], HOME: [12000, 28000], LIFE: [15000, 60000], RENTERS: [4000, 9000],
    HOME_LANDLORD: [14000, 30000], HEALTH: [20000, 70000], COMMERCIAL: [25000, 90000],
    BOAT: [8000, 20000], MOTORCYCLE: [5000, 12000], MOTORHOME: [15000, 35000],
    JEWELRY: [3000, 9000], PET_HEALTH: [2500, 6000], ROADSIDE: [1500, 4000], UMBRELLA: [4000, 10000],
  };
  const [min, max] = ranges[productFamily] || [8000, 20000];
  return randomInt(min, max);
}

function policyTypeFor(productFamily) {
  return `${PRODUCT_LABELS[productFamily] || productFamily}-Standard`;
}

function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

// Converts a wall-clock "year, month(0-idx), day, hour, minute" meant as
// America/New_York local time into the correct UTC Date instant, DST
// included. Needed because this process runs in UTC (confirmed: a bare
// `new Date(day); date.setHours(8, 30)` stores 8:30 UTC, not 8:30
// Eastern) — every TimeClockEntry/HrShiftAssignment timestamp this
// seeder writes is rendered in the agency's own America/New_York
// timezone (Agency.timezone's default), so a naive setHours call made a
// "Standard 9-5" shift visibly render as ~3-4 AM. Standard guess-and-
// correct technique: treat the desired fields as a UTC guess, see what
// that instant actually displays as in America/New_York, and shift by
// the difference — accurate for any instant outside the one skipped/
// repeated hour at a DST transition, which this data never needs to hit
// precisely.
function easternWallClockToUtc(year, month, day, hour, minute) {
  const guess = Date.UTC(year, month, day, hour, minute, 0, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(guess)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const shown = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess + (guess - shown));
}

// The read-side counterpart to easternWallClockToUtc above — what calendar
// date (and hour, unused today but kept for any future time-of-day logic)
// "right now" falls on in America/New_York. Used only to build today's
// live TimeClockEntry below, never to compute a stored historical
// timestamp (those all go through easternWallClockToUtc). `month` is
// 0-indexed (Jan=0), matching every other caller of
// easternWallClockToUtc in this file (all of which pass a `.getMonth()`
// value) — Intl's '2-digit' month is 1-indexed, so it's corrected here.
function easternNowParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date()).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return { year: +parts.year, month: +parts.month - 1, day: +parts.day, hour: +parts.hour };
}

// A demo customer's own fabricated full name — never resembling a real person.
function demoName() {
  return { firstName: randomChoice(DEMO_FIRST_NAMES), lastName: randomChoice(DEMO_LAST_NAMES) };
}

async function loadRoster(agencyId) {
  const [owner, managers, producers, tmAssignments] = await Promise.all([
    prisma.user.findFirst({ where: { agencyId, role: 'AGENCY_OWNER' } }),
    prisma.user.findMany({ where: { agencyId, role: 'AGENCY_MANAGER', status: 'ACTIVE' } }),
    prisma.user.findMany({ where: { agencyId, role: 'PRODUCER', status: 'ACTIVE' } }),
    prisma.telemarketerAssignment.findMany({ where: { agencyId, status: 'ACTIVE' }, include: { telemarketer: true } }),
  ]);
  const telemarketers = tmAssignments.map((a) => a.telemarketer).filter((u) => u && u.status === 'ACTIVE');
  const hrRoster = [owner, ...managers, ...producers, ...telemarketers].filter(Boolean);
  return { owner, managers, producers, telemarketers, hrRoster };
}

// Wipes everything this seeder itself is responsible for, in FK-safe
// order, so a reseed never duplicates old rows. Never touches User/
// TelemarketerAssignment/TelemarketerProfile/AgencySubscription — the
// roster and billing plan stay exactly as configured. Customer rows are
// deliberately left behind (no agencyId on that model to scope a safe
// delete) — harmless orphans, clearly fake "Demo ..." names.
async function wipeAgencyDemoData(agencyId) {
  const vendorIds = (await prisma.vendor.findMany({ where: { agencyId }, select: { id: true } })).map((v) => v.id);
  const saleIds = (await prisma.sale.findMany({ where: { agencyId }, select: { id: true } })).map((s) => s.id);

  // TrainingAssignment/LessonCompletion carry no agencyId of their own
  // (platform-wide course content, per-user assignment) — scoped via a
  // relation filter down to this agency's own users instead. This clears
  // any real progress a demo user clicked through too, same as every
  // other model this wipe clears — a demo agency's whole history is
  // disposable on reseed, not just what this seeder itself wrote.
  await prisma.lessonCompletion.deleteMany({ where: { assignment: { user: { agencyId } } } });
  await prisma.trainingAssignment.deleteMany({ where: { user: { agencyId } } });
  // No real Lead ever references these (this seeder never sets
  // Lead.recordStoreSubscriptionId), so a plain agencyId-scoped delete is
  // always FK-safe.
  await prisma.recordStoreSubscription.deleteMany({ where: { agencyId } });
  await prisma.breakRoomAchievement.deleteMany({ where: { agencyId } });
  await prisma.breakRoomHighScore.deleteMany({ where: { agencyId } });
  await prisma.breakRoomGameSession.deleteMany({ where: { agencyId } });
  await prisma.timeClockEntry.deleteMany({ where: { agencyId } });
  await prisma.ptoRequest.deleteMany({ where: { agencyId } });
  await prisma.goal.deleteMany({ where: { agencyId } });
  await prisma.opportunityEvent.deleteMany({ where: { opportunity: { agencyId } } });
  await prisma.opportunity.deleteMany({ where: { agencyId } });
  if (saleIds.length) await prisma.revenueEvent.deleteMany({ where: { saleId: { in: saleIds } } });
  if (vendorIds.length) {
    await prisma.costEvent.deleteMany({ where: { vendorId: { in: vendorIds } } });
    // A real (non-demo-seeded) agency can already have genuine vendor
    // history — a live API credential, inbound webhook log, or
    // historical-import/appointment rows — that FK-blocks a plain
    // Vendor delete (none of these relations cascade; Postgres defaults
    // to NO ACTION). All of it belongs to a vendor this wipe is about to
    // remove, so it goes too, not just the rows this seeder itself wrote.
    await prisma.vendorCredential.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await prisma.apiTransaction.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await prisma.highLevelWebhookEvent.deleteMany({ where: { vendorId: { in: vendorIds } } });
  }
  await prisma.historicalRecord.deleteMany({ where: { agencyId } });
  // A real demo agency that's actually been clicked around in (not just
  // seeded by this function) can have genuine Lead activity — notes,
  // calls, tasks, logged activities, per-product quotes, appointments —
  // every one of which FK-blocks a plain Lead delete the same way the
  // vendor rows above do. Appointment FKs Lead+Vendor+Task, so it must
  // clear before any of those three.
  await prisma.appointment.deleteMany({ where: { agencyId } });
  await prisma.call.deleteMany({ where: { agencyId } });
  await prisma.task.deleteMany({ where: { agencyId } });
  await prisma.leadActivity.deleteMany({ where: { lead: { agencyId } } });
  await prisma.leadNote.deleteMany({ where: { lead: { agencyId } } });
  await prisma.leadEvent.deleteMany({ where: { lead: { agencyId } } });
  await prisma.leadProductQuote.deleteMany({ where: { lead: { agencyId } } });
  await prisma.sale.deleteMany({ where: { agencyId } });
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.vendor.deleteMany({ where: { agencyId } });

  // Backstage HR — only ever written by this seeder (a brand-new, mostly-
  // unused Phase-1 feature elsewhere in the app), but cleared defensively
  // in full FK-safe order all the same. Scoped by agencyId directly (or a
  // relation down to it) everywhere it's available, rather than a
  // precomputed id array handed between queries — every one of these
  // models already carries agencyId (HrLeavePolicyAssignment and
  // HrShiftSwapRequest are the two exceptions, scoped via a relation
  // filter instead), so there's no separate snapshot that can ever go
  // stale relative to the delete it's meant to guard.
  await prisma.hrShiftSwapRequest.deleteMany({ where: { shiftAssignment: { agencyId } } });
  await prisma.hrShiftAssignment.deleteMany({ where: { agencyId } });
  await prisma.hrAttendanceException.deleteMany({ where: { agencyId } });
  await prisma.hrTimesheetSegment.deleteMany({ where: { timesheet: { agencyId } } });
  await prisma.hrTimesheet.deleteMany({ where: { agencyId } });
  await prisma.hrLeaveLedgerEntry.deleteMany({ where: { agencyId } });
  await prisma.hrLeaveRequest.deleteMany({ where: { agencyId } });
  await prisma.hrLeavePolicyAssignment.deleteMany({ where: { employeeProfile: { agencyId } } });
  await prisma.hrEmploymentHistoryEvent.deleteMany({ where: { agencyId } });
  await prisma.hrLeavePolicy.deleteMany({ where: { agencyId } });
  await prisma.hrLeaveType.deleteMany({ where: { agencyId } });
  await prisma.hrShiftTemplate.deleteMany({ where: { agencyId } });
  await prisma.hrEmployeeProfile.deleteMany({ where: { agencyId } });
  await prisma.hrPosition.deleteMany({ where: { agencyId } });
  await prisma.hrDepartment.deleteMany({ where: { agencyId } });
  await prisma.hrLegalEmployer.deleteMany({ where: { agencyId } });
}

async function createVendors(agencyId) {
  const specs = [
    { letter: 'A', category: 'INTERNET', costPerLeadCents: 325 },
    { letter: 'B', category: 'DIRECT_MAIL', costPerLeadCents: 450 },
    { letter: 'C', category: 'INTERNET', costPerLeadCents: 525 },
    { letter: 'D', category: 'OTHER', costPerLeadCents: 600 },
    { letter: 'E', category: 'INTERNET', costPerLeadCents: 725 },
  ];
  const vendors = [];
  for (const spec of specs) {
    const vendor = await prisma.vendor.create({
      data: {
        agencyId,
        name: `Lead Source ${spec.letter}`,
        email: `lead-source-${spec.letter.toLowerCase()}+${agencyId}@example.test`,
        product: 'AUTO',
        category: spec.category,
        costPerLeadCents: spec.costPerLeadCents,
        status: 'LIVE',
        distributionMode: 'ROUND_ROBIN',
      },
    });
    vendors.push(vendor);
  }
  return vendors; // equal volume share across all 5 -> blended cost averages exactly $5.25
}

function monthKey(date) {
  return date.getFullYear() * 12 + date.getMonth();
}

// Every real producer is shuffled into one of 3 skill tiers (developing/
// mid/high performer), evenly cycled across however many producers exist
// — so a 3-producer roster and a 30-producer roster alike always get a
// genuine spread, not just a coincidence of random draws. Each producer's
// own per-month weight then jitters (0.7x-1.3x) around their tier's base
// every single month, so even a strong performer has an occasional softer
// month and a developing producer occasionally has a strong one — this is
// what makes "some producers hit their 100-items goal, some are still
// working toward it" a real, varied outcome across the whole 6-month
// Goal list, not a single static label per producer forever.
function buildProducerTiers(producers) {
  const shuffled = [...producers].sort(() => Math.random() - 0.5);
  return shuffled.map((p, i) => {
    const tier = i % 3;
    // A wide spread on purpose: a busy, 300-lead/day agency realistically
    // has a big gap between a still-ramping producer and a star performer
    // — the bottom tier is deliberately thin-shared so it lands under the
    // 100-items/month goal regardless of how many producers are on the
    // roster (a small roster still needs a real "still working toward it"
    // case, not just a smaller version of everyone succeeding).
    const base = tier === 0 ? 0.05 + Math.random() * 0.15 // developing: 0.05x-0.20x
      : tier === 1 ? 0.60 + Math.random() * 0.70 // mid: 0.60x-1.30x
        : 1.50 + Math.random() * 1.10; // high performer: 1.50x-2.60x
    return { user: p, base };
  });
}

function buildMonthlyProducerWeights(producerTiers, start, now) {
  const map = new Map(); // monthKey -> [{ value: user, weight }]
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 1);
  while (cursor.getTime() <= last.getTime()) {
    // Wider month-to-month jitter (0.5x-1.6x) so even a tier's own
    // average has real texture from one month to the next, not a flat
    // repeating outcome.
    map.set(monthKey(cursor), producerTiers.map((pt) => ({ value: pt.user, weight: pt.base * (0.5 + Math.random() * 1.1) })));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return map;
}

function pickProducerForDate(monthlyWeights, date) {
  return weightedPick(monthlyWeights.get(monthKey(date)));
}

// Builds one lead's full row set (customer, lead, cost event, note,
// task) — called for both the general vendor pool and the telemarketer
// transfer pool, which only differ in how the lead is sourced/typed and
// what its close rate is. Pushes everything into the caller's shared
// per-flush-chunk arrays; returns nothing.
function buildLeadBundle({
  agencyId, day, now, isOld, closeRate, zipTiers, producer, product, vendor, tm, roster,
  buckets,
}) {
  const { firstName, lastName } = demoName();
  const customerId = uuid();
  const leadId = uuid();
  const zip = weightedPick(zipTiers.map((t) => ({ value: t.zip, weight: t.weight })));
  const receivedAt = new Date(day.getTime() + randomInt(8, 18) * 60 * 60 * 1000);
  const isTransfer = !!tm;

  let status;
  let isSold = false;
  if (isOld) {
    if (Math.random() < closeRate) {
      status = 'SOLD';
      isSold = true;
    } else if (isTransfer) {
      status = weightedPick([{ value: 'LOST', weight: 50 }, { value: 'NOT_INTERESTED', weight: 40 }, { value: 'BAD_CONTACT', weight: 10 }]);
    } else {
      status = weightedPick([
        { value: 'LOST', weight: 40 }, { value: 'NOT_INTERESTED', weight: 35 },
        { value: 'DO_NOT_CONTACT', weight: 5 }, { value: 'BAD_CONTACT', weight: 20 },
      ]);
    }
  } else {
    status = weightedPick([
      { value: 'NEW', weight: 20 }, { value: 'CONTACTED', weight: 25 }, { value: 'QUOTED', weight: 25 },
      { value: 'FOLLOW_UP', weight: 15 }, { value: 'APPOINTMENT', weight: 15 },
    ]);
  }

  // Speed-to-first-attempt and contact rate (funnelMetrics.js's
  // computeFunnel) read these two fields directly — unlike quote/close
  // rate, which come straight from `status` alone, nothing else in this
  // file ever populates them. A NEW lead is genuinely untouched (no
  // attempt yet, same reasoning as it getting no note/task below).
  // Everything else was at least attempted; a terminal-unsold lead may or
  // may not have actually been reached (BAD_CONTACT/DO_NOT_CONTACT-style
  // outcomes can happen without ever truly speaking to the customer), so
  // only CONTACTED_LIKE_STATUSES — which can't be reached any other way —
  // always get a firstContactAt.
  let firstAttemptAt = null;
  let firstContactAt = null;
  if (status !== 'NEW') {
    firstAttemptAt = new Date(receivedAt.getTime() + randomInt(10, 240) * 60 * 1000);
    const reallyContacted = CONTACTED_LIKE_STATUSES.has(status)
      || (TERMINAL_UNSOLD_STATUSES.has(status) && Math.random() < 0.55);
    if (reallyContacted) {
      firstContactAt = new Date(firstAttemptAt.getTime() + randomInt(0, 45) * 60 * 1000);
    }
  }

  buckets.customers.push({ id: customerId, firstName, lastName, zip, state: 'GA' });
  buckets.leads.push({
    id: leadId, agencyId, customerId,
    source: isTransfer ? 'telemarketer' : 'vendor',
    vendorId: isTransfer ? null : vendor.id,
    product, status,
    leadType: isTransfer ? 'TRANSFER' : deriveLeadType({ vendorCategory: vendor.category }),
    isLiveTransfer: isTransfer, moshpitEligible: isTransfer,
    assignedToId: producer.id,
    createdById: isTransfer ? tm.id : (roster.owner ? roster.owner.id : producer.id),
    receivedAt, assignedAt: receivedAt, firstAttemptAt, firstContactAt, zip, state: 'GA',
  });
  if (!isTransfer) {
    buckets.costEvents.push({ id: uuid(), agencyId, vendorId: vendor.id, category: 'VENDOR_LEAD_COST', amountCents: vendor.costPerLeadCents, occurredAt: receivedAt, notes: `Vendor lead cost for lead ${leadId}` });
  }
  if (isSold) buckets.soldLeadSaleInputs.push({ leadId, customerId, assignedToId: producer.id, productFamily: product, receivedAt, zip });

  // Notes + tasks — the real texture of a lead that's actually been
  // worked. NEW leads are untouched (nobody's called them yet, which is
  // itself realistic); everything else gets a real chance at a note, and
  // an in-progress lead in the live/recent window also gets an open
  // follow-up task so the Tasks page and work queue look genuinely active
  // right now, not just historically.
  if (status === 'SOLD') {
    buckets.leadNotes.push({ id: uuid(), leadId, authorId: producer.id, content: randomChoice(SOLD_NOTES), createdAt: new Date(receivedAt.getTime() + randomInt(1, 5) * 24 * 60 * 60 * 1000) });
    if (Math.random() < 0.3) {
      const dueAt = new Date(receivedAt.getTime() + randomInt(5, 10) * 24 * 60 * 60 * 1000);
      buckets.tasks.push({
        id: uuid(), agencyId, leadId, type: 'FOLLOW_UP', title: `Send renewal reminder — ${firstName} ${lastName}`,
        status: 'COMPLETED', priority: 0, assignedToId: producer.id, createdById: producer.id,
        dueAt, completedAt: dueAt,
      });
    }
  } else if (TERMINAL_UNSOLD_STATUSES.has(status) && Math.random() < 0.5) {
    buckets.leadNotes.push({ id: uuid(), leadId, authorId: producer.id, content: randomChoice(LOST_NOTES), createdAt: new Date(receivedAt.getTime() + randomInt(1, 4) * 24 * 60 * 60 * 1000) });
  } else if (!isOld && status !== 'NEW') {
    // In-progress and recent — the live pipeline. NEW is deliberately
    // excluded: nobody has worked this lead yet, so it has no note and no
    // follow-up task — same reasoning as the isOld branch above never
    // touching NEW (it never produces NEW at all).
    if (Math.random() < 0.7) {
      buckets.leadNotes.push({ id: uuid(), leadId, authorId: producer.id, content: randomChoice(WORKING_NOTES), createdAt: new Date(receivedAt.getTime() + randomInt(0, 2) * 24 * 60 * 60 * 1000) });
    }
    if (Math.random() < 0.6) {
      // Mostly due hours-to-days out (not yet due), with a small realistic
      // slice already overdue — not a near-even split. Every one of these
      // tasks is built at the same `now`, so an even day-level spread
      // (e.g. -1..+3 days) put a day-0 AND a day-(-1) bucket in the past
      // the moment any real time passes after seeding, making ~40% of
      // the live work queue look overdue on first look — exactly the
      // opposite of "well-oiled machine."
      const dueAt = Math.random() < 0.15
        ? new Date(now.getTime() - randomInt(2, 48) * 60 * 60 * 1000)
        : new Date(now.getTime() + randomInt(4, 96) * 60 * 60 * 1000);
      buckets.tasks.push({
        id: uuid(), agencyId, leadId, type: 'FOLLOW_UP', title: `Follow up with ${firstName} ${lastName}`,
        status: 'OPEN', priority: randomInt(0, 2), assignedToId: producer.id, createdById: producer.id,
        dueAt,
      });
    }
  }
}

async function seedRealisticDemoData(agencyId, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const roster = await loadRoster(agencyId);
  if (roster.producers.length === 0) {
    return { seeded: false, reason: 'NO_PRODUCERS' };
  }

  await wipeAgencyDemoData(agencyId);

  // Agency located in GA, matching the lead zip tiers below.
  const agency = await prisma.agency.update({
    where: { id: agencyId },
    data: { state: 'GA', city: 'Atlanta', address: '1100 Peachtree St NE', zip: '30309' },
  });

  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - cfg.months * 30);
  const totalDays = daysBetween(start, now);

  const vendors = await createVendors(agencyId);
  const vendorWeights = vendors.map((v) => ({ value: v, weight: 1 })); // equal volume share
  const producerTiers = buildProducerTiers(roster.producers);
  const monthlyProducerWeights = buildMonthlyProducerWeights(producerTiers, start, now);
  const zipTiers = GA_ZIP_TIERS;

  const soldLeadSaleInputs = []; // { leadId, customerId, assignedToId, productFamily, receivedAt, zip } — kept across the whole run, tiny per-entry

  let transferCount = 0;
  let generalCount = 0;
  let leadNoteCount = 0;
  let taskCount = 0;

  // --- General + telemarketer-transfer leads, flushed every LEAD_FLUSH_DAYS days ---
  for (let chunkStart = 0; chunkStart <= totalDays; chunkStart += LEAD_FLUSH_DAYS) {
    const buckets = { customers: [], leads: [], costEvents: [], leadNotes: [], tasks: [], soldLeadSaleInputs: [] };
    const chunkEnd = Math.min(chunkStart + LEAD_FLUSH_DAYS - 1, totalDays);

    for (let dayOffset = chunkStart; dayOffset <= chunkEnd; dayOffset++) {
      const day = new Date(start);
      day.setDate(day.getDate() + dayOffset);
      const ageDays = daysBetween(day, now);
      const isOld = ageDays >= 10;

      const generalToday = cfg.leadsPerDay - cfg.transfersPerDay;
      for (let i = 0; i < generalToday; i++) {
        buildLeadBundle({
          agencyId, day, now, isOld, closeRate: cfg.generalCloseRate, zipTiers,
          producer: pickProducerForDate(monthlyProducerWeights, day),
          product: randomChoice(PRODUCTS), vendor: weightedPick(vendorWeights), tm: null, roster, buckets,
        });
        generalCount++;
      }

      if (roster.telemarketers.length > 0) {
        for (let i = 0; i < cfg.transfersPerDay; i++) {
          buildLeadBundle({
            agencyId, day, now, isOld, closeRate: cfg.transferCloseRate, zipTiers,
            producer: pickProducerForDate(monthlyProducerWeights, day),
            product: randomChoice(PRODUCTS), vendor: null, tm: roster.telemarketers[i % roster.telemarketers.length], roster, buckets,
          });
          transferCount++;
        }
      }
    }

    await createManyChunked(prisma.customer, buckets.customers);
    await createManyChunked(prisma.lead, buckets.leads);
    await createManyChunked(prisma.costEvent, buckets.costEvents);
    await createManyChunked(prisma.leadNote, buckets.leadNotes);
    await createManyChunked(prisma.task, buckets.tasks);
    leadNoteCount += buckets.leadNotes.length;
    taskCount += buckets.tasks.length;
    soldLeadSaleInputs.push(...buckets.soldLeadSaleInputs);
  }

  // --- A small, genuinely-unclaimed Moshpit pool ---
  // Every transfer lead above (including isLiveTransfer/moshpitEligible
  // ones) is immediately assigned to a producer, so none of them can ever
  // appear in GET /leads/moshpit, which requires assignedToId: null — a
  // demo agency's Moshpit queue would otherwise always be empty despite
  // the eligibility flags being set correctly. Kept as its own standalone
  // step (not threaded through buildLeadBundle/the day loop above) since
  // it's a different kind of lead entirely: just-arrived and genuinely
  // unclaimed, not historical.
  const MOSHPIT_UNCLAIMED_COUNT = 12;
  let moshpitUnclaimedCount = 0;
  if (roster.telemarketers.length > 0) {
    const moshpitCustomers = [];
    const moshpitLeads = [];
    for (let i = 0; i < MOSHPIT_UNCLAIMED_COUNT; i++) {
      const { firstName, lastName } = demoName();
      const customerId = uuid();
      const zip = weightedPick(zipTiers.map((t) => ({ value: t.zip, weight: t.weight })));
      const receivedAt = new Date(now.getTime() - randomInt(10, 6 * 60) * 60 * 1000); // last 10min-6h
      const tm = roster.telemarketers[i % roster.telemarketers.length];
      moshpitCustomers.push({ id: customerId, firstName, lastName, zip, state: 'GA' });
      moshpitLeads.push({
        id: uuid(), agencyId, customerId,
        source: 'telemarketer', vendorId: null,
        product: randomChoice(PRODUCTS), status: 'NEW', leadType: 'TRANSFER',
        isLiveTransfer: true, moshpitEligible: true,
        assignedToId: null, createdById: tm.id,
        receivedAt, assignedAt: null, zip, state: 'GA',
      });
    }
    await createManyChunked(prisma.customer, moshpitCustomers);
    await createManyChunked(prisma.lead, moshpitLeads);
    moshpitUnclaimedCount = moshpitLeads.length;
  }

  // --- Sales for every terminal-SOLD lead, posting the one real revenue entry every dashboard reads ---
  // Built as plain rows and createMany'd (never individual creates) —
  // every Sale here is brand new, so there's no edit/void history to
  // reconcile and no need for syncSaleRevenueEvent's upsert semantics;
  // a matching RevenueEvent row is just as cheap to build directly.
  let saleCount = 0;
  let totalItemsSold = 0;
  const itemsByProducerMonth = new Map(); // `${producerId}:${year}-${month}` -> items
  const saleRows = [];
  const revenueRows = [];

  function trackItems(producerId, saleDate, items) {
    const key = `${producerId}:${saleDate.getFullYear()}-${saleDate.getMonth()}`;
    itemsByProducerMonth.set(key, (itemsByProducerMonth.get(key) || 0) + items);
  }

  function buildSaleAndRevenue(input) {
    const items = randomItems();
    const premiumCents = randomPremiumCents(input.productFamily);
    const saleDate = new Date(input.receivedAt.getTime() + randomInt(1, 5) * 24 * 60 * 60 * 1000);
    const { firstName, lastName } = demoName();
    const saleId = uuid();
    saleRows.push({
      id: saleId, agencyId, customerId: input.customerId, leadId: input.leadId || null,
      firstName, lastName, saleDate, carrier: randomChoice(CARRIERS),
      policyType: policyTypeFor(input.productFamily), productFamily: input.productFamily,
      premiumCents, items, assignedToId: input.assignedToId, zip: input.zip || null, state: 'GA',
      createdById: input.assignedToId, clientRequestId: `demo-seed-${saleId}`,
    });
    revenueRows.push({
      id: uuid(), agencyId, saleId, category: 'LEAD_REVENUE', sourceType: 'SALE',
      amountCents: premiumCents, occurredAt: saleDate, notes: `Demo-seeded closed sale (sale ${saleId})`,
    });
    trackItems(input.assignedToId, saleDate, items);
    totalItemsSold += items;
    saleCount++;
  }

  for (const batch of chunk(soldLeadSaleInputs, 5000)) {
    for (const input of batch) buildSaleAndRevenue(input);
  }
  await createManyChunked(prisma.sale, saleRows);
  await createManyChunked(prisma.revenueEvent, revenueRows);
  saleRows.length = 0;
  revenueRows.length = 0;

  // --- Cross-Sell / Winback opportunity pipeline ---
  const opportunityCustomers = [];
  const opportunityRows = [];
  const opportunityEventRows = [];
  const wonOpportunities = [];
  const NON_WON_STATUS_WEIGHTS = [
    { value: 'OPEN', weight: 25 }, { value: 'ASSIGNED', weight: 15 }, { value: 'ATTEMPTED', weight: 15 },
    { value: 'CONTACTED', weight: 15 }, { value: 'QUOTED', weight: 10 }, { value: 'DECLINED', weight: 10 },
    { value: 'SNOOZED', weight: 7 }, { value: 'INELIGIBLE', weight: 3 },
  ];

  function buildOpportunityBatch(type, count) {
    for (let i = 0; i < count; i++) {
      // Leave room for a WON opportunity's own sale to land 1-5 days after
      // createdAt (buildSaleAndRevenue) without ever landing in the
      // future relative to "now".
      const latestCreatedAt = now.getTime() - 6 * 24 * 60 * 60 * 1000;
      const createdAt = new Date(start.getTime() + Math.random() * (latestCreatedAt - start.getTime()));
      const producer = pickProducerForDate(monthlyProducerWeights, createdAt);
      const { firstName, lastName } = demoName();
      const customerId = uuid();
      const id = uuid();
      const isWon = Math.random() < cfg.opportunityCloseRate;
      const status = isWon ? 'WON' : weightedPick(NON_WON_STATUS_WEIGHTS);

      let product;
      let previousProduct = null;
      let previousPremiumCents = null;
      let lostAt = null;
      let lostReason = null;
      let reason;

      if (type === 'CROSS_SELL') {
        const have = randomChoice(CROSS_SELL_PRODUCTS);
        product = randomChoice(CROSS_SELL_PRODUCTS.filter((p) => p !== have));
        reason = `Has ${have}, does not have ${product}`;
      } else {
        product = PRODUCT_LABELS[randomChoice(PRODUCTS)];
        previousProduct = product;
        previousPremiumCents = randomPremiumCents(randomChoice(PRODUCTS));
        lostAt = new Date(createdAt.getTime() - randomInt(10, 90) * 24 * 60 * 60 * 1000);
        lostReason = randomChoice(WINBACK_LOST_REASONS);
        reason = `Policy lapsed ${lostAt.toISOString().slice(0, 10)} — ${lostReason}`;
      }

      const zip = weightedPick(zipTiers.map((t) => ({ value: t.zip, weight: t.weight })));
      opportunityCustomers.push({ id: customerId, firstName, lastName, zip, state: 'GA' });
      opportunityRows.push({
        id, agencyId, customerId, type, status, product, previousProduct, previousPremiumCents,
        lostAt, lostReason, reason, priorityScore: randomInt(10, 60), assignedToId: producer.id,
        wonPremiumCents: isWon ? randomPremiumCents(randomChoice(PRODUCTS)) : null,
        createdById: producer.id, createdAt, updatedAt: createdAt,
      });
      opportunityEventRows.push({ id: uuid(), opportunityId: id, toStatus: 'OPEN', actorId: producer.id, reason: 'Created', createdAt });
      if (status !== 'OPEN') {
        opportunityEventRows.push({ id: uuid(), opportunityId: id, fromStatus: 'OPEN', toStatus: status, actorId: producer.id, reason: isWon ? 'Won' : 'Updated', createdAt: new Date(createdAt.getTime() + randomInt(1, 20) * 24 * 60 * 60 * 1000) });
      }
      if (isWon) {
        wonOpportunities.push({ leadId: null, customerId, assignedToId: producer.id, productFamily: randomChoice(PRODUCTS), receivedAt: createdAt, zip });
      }
    }
  }

  buildOpportunityBatch('CROSS_SELL', cfg.crossSellCount);
  buildOpportunityBatch('WINBACK', cfg.winbackCount);

  await createManyChunked(prisma.customer, opportunityCustomers);
  await createManyChunked(prisma.opportunity, opportunityRows);
  await createManyChunked(prisma.opportunityEvent, opportunityEventRows);

  for (const input of wonOpportunities) buildSaleAndRevenue(input);
  await createManyChunked(prisma.sale, saleRows);
  await createManyChunked(prisma.revenueEvent, revenueRows);

  // --- Per-producer monthly "items" goals ---
  const goalRows = [];
  for (const producer of roster.producers) {
    for (let m = 0; m < cfg.months; m++) {
      const periodStart = new Date(now.getFullYear(), now.getMonth() - m, 1);
      // Exclusive upper bound (first moment of the next month) — matches
      // dateRangeWhere's own `saleDate: { lt: to }` convention exactly, so
      // the completedAt flag set here always agrees with what
      // computeGoalActual will compute live from the same Sale rows.
      const periodEnd = new Date(now.getFullYear(), now.getMonth() - m + 1, 1);
      const key = `${producer.id}:${periodStart.getFullYear()}-${periodStart.getMonth()}`;
      const actualItems = itemsByProducerMonth.get(key) || 0;
      goalRows.push({
        id: uuid(), agencyId, userId: producer.id, metric: 'items', targetValue: cfg.goalTargetItems,
        periodType: 'monthly', periodStart, periodEnd,
        completedAt: actualItems >= cfg.goalTargetItems ? new Date(periodEnd.getTime() - 1) : null,
      });
    }
  }
  await createManyChunked(prisma.goal, goalRows);

  // --- HR suite: time clock, PTO, Break Room ---
  const timeClockRows = [];
  const ptoRows = [];
  // userId -> GRINDING/BREAK/LUNCH for today's always-on "live right now"
  // entry seeded below — applied to User.presenceStatus after the bulk
  // TimeClockEntry insert, since Team Status reads that field, not the
  // entries directly.
  const livePresenceByUserId = new Map();
  for (const user of roster.hrRoster) {
    // Upper bound excludes today (handled on its own, below, as an always-
    // open "live" entry) — looping through today here would otherwise seed
    // a clockOutAt later this same day, before it's actually happened yet.
    for (let dayOffset = 0; dayOffset < totalDays; dayOffset++) {
      const day = new Date(start);
      day.setDate(day.getDate() + dayOffset);
      const dow = day.getDay();
      if (dow === 0 || dow === 6) continue; // weekends off
      if (Math.random() < 0.06) continue; // occasional absence

      const clockInAt = easternWallClockToUtc(day.getFullYear(), day.getMonth(), day.getDate(), randomInt(8, 9), randomInt(0, 59));
      const lunchStartAt = new Date(clockInAt.getTime() + randomInt(3, 4) * 60 * 60 * 1000);
      const lunchEndAt = new Date(lunchStartAt.getTime() + randomInt(30, 60) * 60 * 1000);
      const breakStartAt = new Date(lunchEndAt.getTime() + randomInt(60, 120) * 60 * 1000);
      const breakEndAt = new Date(breakStartAt.getTime() + randomInt(10, 15) * 60 * 1000);
      const clockOutAt = easternWallClockToUtc(day.getFullYear(), day.getMonth(), day.getDate(), randomInt(17, 18), randomInt(0, 59));

      timeClockRows.push({
        id: uuid(), userId: user.id, agencyId, clockInAt, clockOutAt,
        lunchStartAt, lunchEndAt, breakStartAt, breakEndAt, createdAt: clockInAt,
      });
    }

    // Today, live: always on (no business-hours gating — a demo may be
    // viewed at any hour and should never look idle), so Team Status shows
    // a real active team instead of everyone defaulting to AWAY. An open
    // entry (no clockOutAt) is what "currently clocked in" means in this
    // schema — see lib/timeClockState.js's stateOf().
    if (Math.random() >= 0.2) { // a few genuinely out, same as any real day
      const { year, month, day } = easternNowParts();
      const clockInAt = easternWallClockToUtc(year, month, day, randomInt(8, 9), randomInt(0, 59));
      const presence = weightedPick([
        { value: 'GRINDING', weight: 75 },
        { value: 'BREAK', weight: 15 },
        { value: 'LUNCH', weight: 10 },
      ]);
      const liveRow = { id: uuid(), userId: user.id, agencyId, clockInAt, clockOutAt: null, createdAt: clockInAt };
      if (presence === 'LUNCH') liveRow.lunchStartAt = new Date(now.getTime() - randomInt(5, 30) * 60 * 1000);
      else if (presence === 'BREAK') liveRow.breakStartAt = new Date(now.getTime() - randomInt(2, 10) * 60 * 1000);
      timeClockRows.push(liveRow);
      livePresenceByUserId.set(user.id, presence);
    }

    const ptoCount = randomInt(2, 4);
    for (let i = 0; i < ptoCount; i++) {
      const startDate = new Date(start.getTime() + Math.random() * (now.getTime() - start.getTime()));
      const endDate = new Date(startDate.getTime() + randomInt(1, 3) * 24 * 60 * 60 * 1000);
      ptoRows.push({
        id: uuid(), userId: user.id, agencyId, startDate, endDate,
        reason: randomChoice(['Personal', 'Family', 'Vacation', 'Appointment']),
        status: weightedPick([{ value: 'APPROVED', weight: 70 }, { value: 'PENDING', weight: 20 }, { value: 'DENIED', weight: 10 }]),
        createdAt: new Date(startDate.getTime() - randomInt(3, 10) * 24 * 60 * 60 * 1000),
      });
    }
  }
  await createManyChunked(prisma.timeClockEntry, timeClockRows);
  await createManyChunked(prisma.ptoRequest, ptoRows);

  // Reset everyone to AWAY first — idempotent across repeated reseeds, so
  // a prior run's live subset never lingers as a stale GRINDING/BREAK/LUNCH
  // once this run recomputed who's actually live today — then apply the
  // real "today, live" presence just seeded above.
  await prisma.user.updateMany({ where: { id: { in: roster.hrRoster.map((u) => u.id) } }, data: { presenceStatus: 'AWAY' } });
  await Promise.all(
    [...livePresenceByUserId.entries()].map(([userId, presence]) =>
      prisma.user.update({ where: { id: userId }, data: { presenceStatus: presence } })
    )
  );

  const clockEntriesByUser = new Map();
  for (const row of timeClockRows) {
    if (!clockEntriesByUser.has(row.userId)) clockEntriesByUser.set(row.userId, []);
    clockEntriesByUser.get(row.userId).push(row);
  }

  const gameTypes = ['CONGO_LINE', 'BUCKETS', 'FULL_SEND', 'PILL_POP'];
  const sessionRows = [];
  const bestScores = new Map(); // `${userId}:${gameType}` -> { score, sessionId, achievedAt }
  for (const user of roster.hrRoster) {
    // A Break Room session happens during a break, so only entries that
    // actually recorded one are eligible — true of every historical row,
    // but the "today, live" entry above only sets breakStartAt when that
    // user's live presence happens to be BREAK.
    const entries = (clockEntriesByUser.get(user.id) || []).filter((entry) => entry.breakStartAt);
    if (entries.length === 0) continue;
    const sessionsForUser = Math.round(entries.length / 3); // roughly 1-3/week
    for (let i = 0; i < sessionsForUser; i++) {
      const entry = randomChoice(entries);
      const gameType = randomChoice(gameTypes);
      const score = randomInt(50, 5000);
      const startedAt = new Date(entry.breakStartAt.getTime());
      const endedAt = new Date(startedAt.getTime() + randomInt(60, 240) * 1000);
      const sessionId = uuid();
      sessionRows.push({
        id: sessionId, userId: user.id, agencyId, timeClockEntryId: entry.id, gameType,
        status: 'COMPLETED', startedAt, endedAt, durationMs: endedAt.getTime() - startedAt.getTime(),
        score, clientToken: uuid(), createdAt: startedAt,
      });
      const key = `${user.id}:${gameType}`;
      const existing = bestScores.get(key);
      if (!existing || score > existing.score) bestScores.set(key, { score, sessionId, achievedAt: endedAt });
    }
  }
  await createManyChunked(prisma.breakRoomGameSession, sessionRows);
  const highScoreRows = [...bestScores.entries()].map(([key, v]) => {
    const [userId, gameType] = key.split(':');
    return { id: uuid(), userId, agencyId, gameType, bestScore: v.score, sessionId: v.sessionId, achievedAt: v.achievedAt };
  });
  await createManyChunked(prisma.breakRoomHighScore, highScoreRows);

  // --- Backstage HR: departments, positions, employee profiles, shifts, leave ---
  const hr = await seedBackstageHr({ agencyId, agency, roster, start, now, totalDays, clockEntriesByUser, ptoRows });

  // --- Training/Drills progress for producers ---
  // TrainingCourse/TrainingLesson are platform-wide content (no agencyId
  // — only a Platform Owner authors them), so there may be none at all in
  // a given environment; this only assigns against whatever real courses
  // already exist and never fabricates course content itself.
  const courses = await prisma.trainingCourse.findMany({ where: { isActive: true }, include: { lessons: { orderBy: { orderIndex: 'asc' } } } });
  const trainingAssignmentRows = [];
  const lessonCompletionRows = [];
  for (const course of courses) {
    for (const producer of roster.producers) {
      if (Math.random() >= randomInt(60, 100) / 100) continue; // 60-100% of producers get each course
      const assignedAt = new Date(now.getTime() - randomInt(5, 60) * 24 * 60 * 60 * 1000);
      const progress = weightedPick([{ value: 'ASSIGNED', weight: 25 }, { value: 'IN_PROGRESS', weight: 35 }, { value: 'COMPLETED', weight: 40 }]);
      const assignmentId = uuid();
      trainingAssignmentRows.push({
        id: assignmentId, courseId: course.id, userId: producer.id, status: progress,
        assignedAt, completedAt: progress === 'COMPLETED' ? new Date(assignedAt.getTime() + randomInt(1, 20) * 24 * 60 * 60 * 1000) : null,
      });
      if (progress === 'ASSIGNED' || course.lessons.length === 0) continue;
      const lessonCount = progress === 'COMPLETED' ? course.lessons.length : randomInt(1, Math.max(1, course.lessons.length - 1));
      let completedAt = assignedAt;
      for (const lesson of course.lessons.slice(0, lessonCount)) {
        completedAt = new Date(completedAt.getTime() + randomInt(1, 5) * 24 * 60 * 60 * 1000);
        lessonCompletionRows.push({
          id: uuid(), assignmentId, lessonId: lesson.id, completedAt,
          quizScorePercent: lesson.quiz ? randomInt(70, 100) : null,
        });
      }
    }
  }
  await createManyChunked(prisma.trainingAssignment, trainingAssignmentRows);
  await createManyChunked(prisma.lessonCompletion, lessonCompletionRows);

  // --- Fake-but-safe Record Store subscriptions ---
  // boberdooPartnerId/boberdooFilterSetId stay null on purpose — confirmed
  // safe: recordStoreSourceOptimization.js's sweep (the only background
  // job reading this model) hard-requires boberdooFilterSetId: not null,
  // and the inbound Boberdoo delivery webhook matches on
  // Agency.boberdooPartnerId (also left unset here), not anything
  // subscription-level — so these rows can never be mistaken for, or
  // picked up by, a real external integration.
  const recordStoreTemplates = await prisma.recordStoreTemplate.findMany({
    where: { slug: { in: ['HOME_BASIC', 'AUTO_BASIC', 'HOME_PREFERRED', 'AUTO_PREFERRED'] } },
  });
  // Seeded by prisma/seed.js — should always exist, but never fabricate a
  // template row if it somehow doesn't.
  const chosenTemplates = recordStoreTemplates.length === 0
    ? []
    : [...recordStoreTemplates].sort(() => Math.random() - 0.5).slice(0, randomInt(2, Math.min(4, recordStoreTemplates.length)));
  const recordStoreSubscriptionRows = chosenTemplates.map((template) => ({
    id: uuid(), agencyId, recordStoreTemplateId: template.id,
    boberdooPartnerId: null, boberdooFilterSetId: null,
    productNameSnapshot: template.displayName, leadType: template.leadType,
    filterSetType: template.filterSetType, isIpr: template.isIpr,
    // A real price snapshot if a Super Admin ever configured one;
    // otherwise a plausible per-lead placeholder for this demo agency
    // only — same fabrication latitude this seeder already uses for
    // vendor cost (vendorAvgCostCents) and sale premiums elsewhere.
    priceSnapshotCents: template.wholesalePriceCents ?? randomInt(400, 900),
    dailyVolume: template.defaultDailyVolume,
    desiredStatus: 'ACTIVE', status: 'ACTIVE', provisioningStatus: 'ACTIVE', fundingStatus: 'CONFIRMED',
    autoOptimizeSources: false,
    startedAt: new Date(now.getTime() - randomInt(30, 60) * 24 * 60 * 60 * 1000),
    createdById: roster.owner ? roster.owner.id : null,
  }));
  await createManyChunked(prisma.recordStoreSubscription, recordStoreSubscriptionRows);

  const blendedCostPerLeadCents = Math.round(
    vendors.reduce((sum, v) => sum + v.costPerLeadCents, 0) / vendors.length,
  );

  await recordAudit({
    actorId: roster.owner ? roster.owner.id : null,
    actorRole: 'PLATFORM_OWNER',
    agencyId,
    action: 'agency.demoReseeded',
    entityType: 'Agency',
    entityId: agencyId,
    after: {
      generalLeads: generalCount, transferLeads: transferCount, sales: saleCount,
      opportunities: opportunityRows.length, totalItemsSold, vendors: vendors.length,
    },
  });

  // Flow Score is entirely event-triggered in production (a lead
  // disposition change, a task update, a processed call — see
  // routes/leads.js, lib/leadStatusAuto.js, routes/tasks.js,
  // jobs/callProcessing.js) and persists a FlowScoreSnapshot as a side
  // effect of those routes. This seeder writes historical rows directly
  // via createMany/create for performance and never goes through them, so
  // without this step no snapshot would ever exist for this agency or any
  // producer no matter how much history was just seeded. Computed against
  // the fully-seeded dataset (leads, sales, opportunities, goals, HR);
  // call-quality components correctly stay excluded via
  // combineComponents' existing zero-sample-size rule since this seeder
  // creates no Call/CallAnalysis rows — honest, not a gap.
  // Sequential, not Promise.all — every producer shares one
  // FlowScoreWeightConfig row per (role, agencyId) (same for telemarketers,
  // scoped platform-wide), and getActiveWeightConfig's first-run
  // find-or-create isn't race-safe against itself: fine for real
  // one-at-a-time event-triggered calls in production, but concurrent
  // calls here hit its unique constraint on the first reseed.
  await computeAgencyScore(agencyId);
  for (const p of roster.producers) await computeProducerScore(p.id);
  for (const tm of roster.telemarketers) await computeTelemarketerScore(tm.id);

  return {
    seeded: true,
    counts: {
      vendors: vendors.length,
      generalLeads: generalCount,
      transferLeads: transferCount,
      moshpitUnclaimedLeads: moshpitUnclaimedCount,
      leadNotes: leadNoteCount,
      tasks: taskCount,
      sales: saleCount,
      crossSellOpportunities: cfg.crossSellCount,
      winbackOpportunities: cfg.winbackCount,
      opportunitiesWon: wonOpportunities.length,
      goals: goalRows.length,
      timeClockEntries: timeClockRows.length,
      ptoRequests: ptoRows.length,
      breakRoomSessions: sessionRows.length,
      totalItemsSold,
      blendedCostPerLeadCents,
      telemarketerCount: roster.telemarketers.length,
      trainingAssignments: trainingAssignmentRows.length,
      trainingLessonCompletions: lessonCompletionRows.length,
      recordStoreSubscriptions: recordStoreSubscriptionRows.length,
      ...hr,
    },
  };
}

// Backstage HR — the Phase-1 admin suite at /agency/hr. A real agency
// that's been operating for years has departments, positions, employee
// profiles, a work schedule, and a leave program; a demo agency should
// look exactly as lived-in. Runs once per reseed (not per lead-day), so
// row counts here are small (roughly roster size, not lead volume) and
// it's safe to build this in a single pass.
async function seedBackstageHr({ agencyId, agency, roster, start, now, totalDays, clockEntriesByUser, ptoRows }) {
  const legalEmployer = await prisma.hrLegalEmployer.create({
    data: { agencyId, legalName: `${agency.name} LLC`, jurisdictionCountry: 'US', jurisdictionRegion: 'GA' },
  });

  const departments = {};
  for (const name of ['Sales', 'Telemarketing', 'Leadership']) {
    departments[name] = await prisma.hrDepartment.create({
      data: { agencyId, name, managerId: roster.owner ? roster.owner.id : null },
    });
  }
  const positions = {};
  const positionSpecs = [
    { role: 'PRODUCER', title: 'Producer', dept: 'Sales' },
    { role: 'TELEMARKETER', title: 'Telemarketer', dept: 'Telemarketing' },
    { role: 'AGENCY_OWNER', title: 'Agency Owner', dept: 'Leadership' },
    { role: 'AGENCY_MANAGER', title: 'Agency Manager', dept: 'Leadership' },
  ];
  for (const spec of positionSpecs) {
    positions[spec.role] = await prisma.hrPosition.create({
      data: { agencyId, title: spec.title, departmentId: departments[spec.dept].id },
    });
  }

  // Hire dates spread out so the roster looks like it's been built up over
  // real time, not all hired on the same day — the owner is always the
  // most tenured.
  const sixYearsMs = 6 * 365 * 24 * 60 * 60 * 1000;
  const employeeByUserId = new Map();
  const employeeRows = [];
  const historyRows = [];
  let employeeSeq = 1;
  for (const user of roster.hrRoster) {
    const isOwner = roster.owner && user.id === roster.owner.id;
    const tenureMs = isOwner ? randomInt(3, 6) * 365 * 24 * 60 * 60 * 1000 : randomInt(90, 3 * 365) * 24 * 60 * 60 * 1000;
    const hireDate = new Date(Math.max(now.getTime() - tenureMs, now.getTime() - sixYearsMs));
    const position = positions[user.role] || positions.PRODUCER;
    const id = uuid();
    employeeRows.push({
      id, userId: user.id, agencyId, legalEmployerId: legalEmployer.id,
      employeeNumber: `EMP-${String(employeeSeq).padStart(3, '0')}`,
      legalFirstName: user.firstName, legalLastName: user.lastName, personalEmail: user.email,
      employmentType: 'FULL_TIME', workerClassification: 'W2',
      hireDate, originalHireDate: hireDate,
      departmentId: position.departmentId, positionId: position.id,
      managerId: !isOwner && roster.owner ? roster.owner.id : null,
      workTimeZone: 'America/New_York', onboardingStatus: 'COMPLETE', offboardingStatus: 'NOT_STARTED',
    });
    historyRows.push({
      id: uuid(), employeeProfileId: id, agencyId, changeType: 'STATUS_CHANGE',
      effectiveFrom: hireDate, newValue: { onboardingStatus: 'COMPLETE' },
      recordedById: roster.owner ? roster.owner.id : user.id, createdAt: hireDate,
    });
    employeeByUserId.set(user.id, { id, hireDate });
    employeeSeq++;
  }
  await createManyChunked(prisma.hrEmployeeProfile, employeeRows);
  await createManyChunked(prisma.hrEmploymentHistoryEvent, historyRows);

  // Shift template + assignments, reusing the exact same workdays
  // TimeClockEntry already has — a schedule that lines up with real clock
  // history instead of a second, disconnected calendar.
  const shiftTemplate = await prisma.hrShiftTemplate.create({
    data: { agencyId, name: 'Standard 9-5', startTime: '09:00', endTime: '17:00' },
  });
  const shiftRows = [];
  const attendanceExceptionRows = [];
  const EXCEPTION_TYPES = ['LATE_ARRIVAL', 'EARLY_DEPARTURE', 'MISSED_PUNCH'];
  for (const user of roster.hrRoster) {
    const employee = employeeByUserId.get(user.id);
    if (!employee) continue;
    const entries = clockEntriesByUser.get(user.id) || [];
    for (const entry of entries) {
      const workDate = new Date(entry.clockInAt.getFullYear(), entry.clockInAt.getMonth(), entry.clockInAt.getDate());
      // A still-open "today, live" entry has no clockOutAt yet — a
      // SCHEDULED shift always has a defined end, even before the actual
      // punch-out happens, so the template's own scheduled end time
      // (17:00 Eastern, matching 'Standard 9-5' above) stands in for it.
      const endAt = entry.clockOutAt || easternWallClockToUtc(entry.clockInAt.getFullYear(), entry.clockInAt.getMonth(), entry.clockInAt.getDate(), 17, 0);
      shiftRows.push({
        id: uuid(), agencyId, employeeProfileId: employee.id, shiftTemplateId: shiftTemplate.id,
        workDate, startAt: entry.clockInAt, endAt, status: 'SCHEDULED',
        createdById: roster.owner ? roster.owner.id : user.id, createdAt: entry.clockInAt,
      });
      if (Math.random() < 0.03) {
        const exceptionType = randomChoice(EXCEPTION_TYPES);
        const resolved = Math.random() < 0.7;
        attendanceExceptionRows.push({
          id: uuid(), employeeProfileId: employee.id, agencyId, exceptionType,
          detectedAt: entry.clockInAt,
          status: resolved ? randomChoice(['RESOLVED_EXCUSED', 'RESOLVED_UNEXCUSED']) : 'OPEN',
          reviewedById: resolved ? (roster.owner ? roster.owner.id : null) : null,
          reviewedAt: resolved ? new Date(entry.clockInAt.getTime() + 2 * 24 * 60 * 60 * 1000) : null,
          reviewNote: resolved ? 'Reviewed — one-off, no pattern.' : null,
        });
      }
    }
  }
  await createManyChunked(prisma.hrShiftAssignment, shiftRows);
  await createManyChunked(prisma.hrAttendanceException, attendanceExceptionRows);

  // A couple of real shift-swap requests for texture — one still pending
  // so there's something live to act on, a couple already decided.
  const swapRows = [];
  if (shiftRows.length > 5 && roster.hrRoster.length > 1) {
    const sample = [shiftRows[Math.floor(shiftRows.length * 0.25)], shiftRows[Math.floor(shiftRows.length * 0.6)], shiftRows[shiftRows.length - 3]].filter(Boolean);
    sample.forEach((shift, i) => {
      const requester = randomChoice(roster.hrRoster);
      const covering = randomChoice(roster.hrRoster.filter((u) => u.id !== requester.id)) || requester;
      const isPending = i === sample.length - 1;
      swapRows.push({
        id: uuid(), shiftAssignmentId: shift.id, requestedById: requester.id, proposedCoveringUserId: covering.id,
        status: isPending ? 'PENDING' : 'APPROVED', reason: 'Personal scheduling conflict',
        decidedById: isPending ? null : (roster.owner ? roster.owner.id : null),
        decidedAt: isPending ? null : new Date(shift.workDate.getTime() - 24 * 60 * 60 * 1000),
      });
    });
  }
  await createManyChunked(prisma.hrShiftSwapRequest, swapRows);

  // Monthly timesheets per employee, computed from the same clock rows —
  // all but the most recent period already approved, the latest one
  // still sitting SUBMITTED so there's a real pending item to approve.
  const timesheetRows = [];
  const segmentRows = [];
  for (const user of roster.hrRoster) {
    const employee = employeeByUserId.get(user.id);
    if (!employee) continue;
    // A timesheet period only finalizes closed-out shifts — the still-open
    // "today, live" entry (if any) has no clockOutAt/lunchEndAt/breakEndAt
    // yet and is naturally excluded, same as a real in-progress shift
    // can't be finalized into a timesheet before it ends.
    const entries = (clockEntriesByUser.get(user.id) || []).filter((e) => e.clockOutAt);
    for (let m = 0; m < Math.ceil((totalDays + 1) / 30); m++) {
      const periodStart = new Date(start);
      periodStart.setDate(periodStart.getDate() + m * 30);
      const periodEnd = new Date(Math.min(periodStart.getTime() + 29 * 24 * 60 * 60 * 1000, now.getTime()));
      const periodEntries = entries.filter((e) => e.clockInAt >= periodStart && e.clockInAt <= periodEnd);
      if (periodEntries.length === 0) continue;
      const regularMinutes = periodEntries.reduce((sum, e) => {
        const gross = (e.clockOutAt.getTime() - e.clockInAt.getTime()) / 60000;
        const lunch = (e.lunchEndAt.getTime() - e.lunchStartAt.getTime()) / 60000;
        const brk = (e.breakEndAt.getTime() - e.breakStartAt.getTime()) / 60000;
        return sum + Math.max(0, gross - lunch - brk);
      }, 0);
      const isLatestPeriod = periodEnd.getTime() >= now.getTime() - 30 * 24 * 60 * 60 * 1000;
      const timesheetId = uuid();
      timesheetRows.push({
        id: timesheetId, employeeProfileId: employee.id, agencyId, periodStart, periodEnd,
        regularMinutes: Math.round(regularMinutes), overtimeMinutes: 0, paidLeaveMinutes: 0,
        status: isLatestPeriod ? 'SUBMITTED' : 'APPROVED',
        approvedById: isLatestPeriod ? null : (roster.owner ? roster.owner.id : null),
        approvedAt: isLatestPeriod ? null : periodEnd,
      });
      segmentRows.push({
        id: uuid(), timesheetId, sourceTimeClockEntryId: periodEntries[0].id, segmentType: 'WORK',
        startedAt: periodStart, endedAt: periodEnd, minutes: Math.round(regularMinutes),
      });
    }
  }
  await createManyChunked(prisma.hrTimesheet, timesheetRows);
  await createManyChunked(prisma.hrTimesheetSegment, segmentRows);

  // Leave program — PTO + Sick, accrued monthly, with real leave requests
  // mirroring the already-seeded PtoRequest rows so Leave Calendar/Leave
  // Policies aren't a second, disconnected system.
  const leaveTypes = {};
  for (const name of ['PTO', 'Sick Time']) {
    leaveTypes[name] = await prisma.hrLeaveType.create({ data: { agencyId, name, isPaid: true } });
  }
  const leavePolicies = {};
  for (const name of ['PTO', 'Sick Time']) {
    leavePolicies[name] = await prisma.hrLeavePolicy.create({
      data: {
        agencyId, leaveTypeId: leaveTypes[name].id, name: `${name} Accrual`,
        accrualMethod: 'PER_PAY_PERIOD', accrualAmountMinutes: name === 'PTO' ? 400 : 240,
        annualCapMinutes: name === 'PTO' ? 9600 : 4800, effectiveFrom: new Date(now.getTime() - 2 * 365 * 24 * 60 * 60 * 1000),
      },
    });
  }
  const policyAssignmentRows = [];
  const ledgerRows = [];
  const leaveRequestRows = [];
  for (const user of roster.hrRoster) {
    const employee = employeeByUserId.get(user.id);
    if (!employee) continue;
    for (const name of ['PTO', 'Sick Time']) {
      policyAssignmentRows.push({ id: uuid(), employeeProfileId: employee.id, leavePolicyId: leavePolicies[name].id, effectiveFrom: employee.hireDate });
      for (let m = 0; m < 6; m++) {
        const accruedAt = new Date(now.getFullYear(), now.getMonth() - m, 1);
        if (accruedAt < employee.hireDate) continue;
        ledgerRows.push({
          id: uuid(), employeeProfileId: employee.id, leaveTypeId: leaveTypes[name].id, agencyId,
          transactionType: 'ACCRUAL', minutes: name === 'PTO' ? 400 : 240, reason: 'Monthly accrual',
          idempotencyKey: `accrual-${employee.id}-${name}-${accruedAt.getFullYear()}-${accruedAt.getMonth()}`,
          recordedById: roster.owner ? roster.owner.id : user.id, createdAt: accruedAt,
        });
      }
    }
  }
  // Mirror the PtoRequest rows into HrLeaveRequest, so both leave systems
  // agree instead of looking like two disconnected features. APPROVED
  // ones (sampled, not every one) also get a matching USE ledger entry;
  // PENDING ones are carried over as-is (no decidedById/decidedAt yet) so
  // the Leave Policies tab's "PENDING LEAVE REQUESTS" panel always has
  // something real to review, the same way an open attendance exception
  // and a pending shift swap already do elsewhere in this suite; DENIED
  // ones carry over too, for the same "real history, not just success"
  // reason Opportunity/Task already follow.
  for (const pto of ptoRows) {
    const employee = employeeByUserId.get(pto.userId);
    if (!employee) continue;
    const minutes = Math.round((pto.endDate.getTime() - pto.startDate.getTime()) / 60000);
    if (pto.status === 'PENDING') {
      leaveRequestRows.push({
        id: uuid(), employeeProfileId: employee.id, agencyId, leaveTypeId: leaveTypes.PTO.id,
        startDate: pto.startDate, endDate: pto.endDate, requestedMinutes: minutes, note: pto.reason,
        status: 'PENDING',
      });
      continue;
    }
    if (pto.status === 'DENIED') {
      leaveRequestRows.push({
        id: uuid(), employeeProfileId: employee.id, agencyId, leaveTypeId: leaveTypes.PTO.id,
        startDate: pto.startDate, endDate: pto.endDate, requestedMinutes: minutes, note: pto.reason,
        status: 'DENIED', decidedById: roster.owner ? roster.owner.id : null, decidedAt: pto.createdAt,
        decisionNote: pto.reviewNote || 'Coverage not available for this period.',
      });
      continue;
    }
    if (Math.random() < 0.4) continue; // sample the (much larger) APPROVED pool
    leaveRequestRows.push({
      id: uuid(), employeeProfileId: employee.id, agencyId, leaveTypeId: leaveTypes.PTO.id,
      startDate: pto.startDate, endDate: pto.endDate, requestedMinutes: minutes, note: pto.reason,
      status: 'APPROVED', decidedById: roster.owner ? roster.owner.id : null, decidedAt: pto.createdAt,
    });
    ledgerRows.push({
      id: uuid(), employeeProfileId: employee.id, leaveTypeId: leaveTypes.PTO.id, agencyId,
      transactionType: 'USE', minutes: -minutes, reason: 'Approved time off',
      idempotencyKey: `use-${employee.id}-${pto.startDate.getTime()}`,
      recordedById: roster.owner ? roster.owner.id : null, createdAt: pto.startDate,
    });
  }
  await createManyChunked(prisma.hrLeavePolicyAssignment, policyAssignmentRows);
  await createManyChunked(prisma.hrLeaveLedgerEntry, ledgerRows);
  await createManyChunked(prisma.hrLeaveRequest, leaveRequestRows);

  return {
    hrEmployeeProfiles: employeeRows.length,
    hrDepartments: Object.keys(departments).length,
    hrShiftAssignments: shiftRows.length,
    hrTimesheets: timesheetRows.length,
    hrAttendanceExceptions: attendanceExceptionRows.length,
    hrLeaveRequests: leaveRequestRows.length,
  };
}

module.exports = { seedRealisticDemoData, DEFAULTS, wipeAgencyDemoData };
