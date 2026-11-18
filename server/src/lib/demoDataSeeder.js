// Realistic demo-agency data generator — replaces the old, tiny
// seedDemoAgencyData (28 leads / 10 sales / 2 vendors) stub. Builds 6
// months of believable, high-volume activity for a demo agency: vendor-
// sourced leads, telemarketer live transfers, a Cross-Sell/Winback
// opportunity pipeline, per-producer monthly goals, and HR activity
// (clock entries, PTO, Break Room) — so a demo account looks like a real,
// busy agency rather than an empty shell, without ever touching the
// agency's real roster/billing.
//
// Deliberately does NOT reuse createSaleRecord/updateCustomerProductsAnd-
// DetectCrossSells for its bulk-pool sales — that live cross-sell auto-
// detector would silently create extra Opportunity rows past the exact
// Cross-Sell/Winback counts this seeder is asked to produce (a fresh
// single-product demo customer almost always trips a detected gap). It
// posts the one piece every dashboard actually reads (RevenueEvent, via
// the real syncSaleRevenueEvent) directly instead, and builds the
// Opportunity pool itself, explicitly, at exact counts.
//
// Also deliberately breaks from this codebase's own "never createMany a
// Lead/Sale" precedent for the high-volume, side-effect-free rows (Lead,
// Customer, CostEvent, Opportunity, OpportunityEvent, TimeClockEntry) —
// those existing bulk paths (bulk-import, Back Catalog) loop one create()
// at a time because they need live distribution/notification/priority-
// scoring logic; this seeder is purely backdated synthetic data, so a
// plain chunked createMany is correct and ~100x faster. Sale rows are the
// one exception (they need a real RevenueEvent upsert), so they go in via
// individual creates, batched with Promise.all.
const crypto = require('crypto');
const { prisma } = require('./db');
const { recordAudit } = require('./audit');
const { syncSaleRevenueEvent } = require('./financialEvents');
const { PRODUCTS, PRODUCT_LABELS } = require('./products');
const { deriveLeadType } = require('./leadType');

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

  await prisma.breakRoomAchievement.deleteMany({ where: { agencyId } });
  await prisma.breakRoomHighScore.deleteMany({ where: { agencyId } });
  await prisma.breakRoomGameSession.deleteMany({ where: { agencyId } });
  await prisma.timeClockEntry.deleteMany({ where: { agencyId } });
  await prisma.ptoRequest.deleteMany({ where: { agencyId } });
  await prisma.goal.deleteMany({ where: { agencyId } });
  await prisma.opportunityEvent.deleteMany({ where: { opportunity: { agencyId } } });
  await prisma.opportunity.deleteMany({ where: { agencyId } });
  if (saleIds.length) await prisma.revenueEvent.deleteMany({ where: { saleId: { in: saleIds } } });
  if (vendorIds.length) await prisma.costEvent.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.sale.deleteMany({ where: { agencyId } });
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.vendor.deleteMany({ where: { agencyId } });
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

async function seedRealisticDemoData(agencyId, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const roster = await loadRoster(agencyId);
  if (roster.producers.length === 0) {
    return { seeded: false, reason: 'NO_PRODUCERS' };
  }

  await wipeAgencyDemoData(agencyId);

  // Agency located in GA, matching the lead zip tiers below.
  await prisma.agency.update({
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

  const customers = [];
  const leads = [];
  const costEvents = [];
  const soldLeadSaleInputs = []; // { leadId, customerId, assignedToId, productFamily, receivedAt }

  let transferCount = 0;
  let generalCount = 0;

  for (let dayOffset = 0; dayOffset <= totalDays; dayOffset++) {
    const day = new Date(start);
    day.setDate(day.getDate() + dayOffset);
    const ageDays = daysBetween(day, now);
    const isOld = ageDays >= 10;

    // --- General vendor-sourced leads ---
    const generalToday = cfg.leadsPerDay - cfg.transfersPerDay;
    for (let i = 0; i < generalToday; i++) {
      const vendor = weightedPick(vendorWeights);
      const producer = pickProducerForDate(monthlyProducerWeights, day);
      const zip = weightedPick(zipTiers.map((t) => ({ value: t.zip, weight: t.weight })));
      const product = randomChoice(PRODUCTS);
      const { firstName, lastName } = demoName();
      const customerId = uuid();
      const leadId = uuid();
      const receivedAt = new Date(day.getTime() + randomInt(8, 18) * 60 * 60 * 1000);

      let status;
      let isSold = false;
      if (isOld) {
        if (Math.random() < cfg.generalCloseRate) {
          status = 'SOLD';
          isSold = true;
        } else {
          status = weightedPick([
            { value: 'LOST', weight: 40 }, { value: 'NOT_INTERESTED', weight: 35 },
            { value: 'DO_NOT_CONTACT', weight: 5 }, { value: 'BAD_CONTACT', weight: 20 },
          ]);
        }
      } else {
        status = weightedPick([
          { value: 'NEW', weight: 25 }, { value: 'CONTACTED', weight: 25 }, { value: 'QUOTED', weight: 20 },
          { value: 'FOLLOW_UP', weight: 15 }, { value: 'APPOINTMENT', weight: 15 },
        ]);
      }

      customers.push({ id: customerId, firstName, lastName, zip, state: 'GA' });
      leads.push({
        id: leadId, agencyId, customerId, source: 'vendor', vendorId: vendor.id,
        product, status, leadType: deriveLeadType({ vendorCategory: vendor.category }),
        assignedToId: producer.id, createdById: roster.owner ? roster.owner.id : producer.id,
        receivedAt, assignedAt: receivedAt, zip, state: 'GA',
      });
      costEvents.push({ id: uuid(), agencyId, vendorId: vendor.id, category: 'VENDOR_LEAD_COST', amountCents: vendor.costPerLeadCents, occurredAt: receivedAt, notes: `Vendor lead cost for lead ${leadId}` });
      if (isSold) soldLeadSaleInputs.push({ leadId, customerId, assignedToId: producer.id, productFamily: product, receivedAt, zip });
      generalCount++;
    }

    // --- Telemarketer live transfers ---
    if (roster.telemarketers.length > 0) {
      for (let i = 0; i < cfg.transfersPerDay; i++) {
        const tm = roster.telemarketers[i % roster.telemarketers.length];
        const producer = pickProducerForDate(monthlyProducerWeights, day);
        const zip = weightedPick(zipTiers.map((t) => ({ value: t.zip, weight: t.weight })));
        const product = randomChoice(PRODUCTS);
        const { firstName, lastName } = demoName();
        const customerId = uuid();
        const leadId = uuid();
        const receivedAt = new Date(day.getTime() + randomInt(8, 18) * 60 * 60 * 1000);

        let status;
        let isSold = false;
        if (isOld) {
          if (Math.random() < cfg.transferCloseRate) {
            status = 'SOLD';
            isSold = true;
          } else {
            status = weightedPick([{ value: 'LOST', weight: 50 }, { value: 'NOT_INTERESTED', weight: 40 }, { value: 'BAD_CONTACT', weight: 10 }]);
          }
        } else {
          status = weightedPick([
            { value: 'NEW', weight: 20 }, { value: 'CONTACTED', weight: 25 }, { value: 'QUOTED', weight: 25 },
            { value: 'FOLLOW_UP', weight: 15 }, { value: 'APPOINTMENT', weight: 15 },
          ]);
        }

        customers.push({ id: customerId, firstName, lastName, zip, state: 'GA' });
        leads.push({
          id: leadId, agencyId, customerId, source: 'telemarketer', vendorId: null,
          product, status, leadType: 'TRANSFER', isLiveTransfer: true, moshpitEligible: true,
          assignedToId: producer.id, createdById: tm.id, receivedAt, assignedAt: receivedAt, zip, state: 'GA',
        });
        if (isSold) soldLeadSaleInputs.push({ leadId, customerId, assignedToId: producer.id, productFamily: product, receivedAt, zip });
        transferCount++;
      }
    }
  }

  await createManyChunked(prisma.customer, customers);
  await createManyChunked(prisma.lead, leads);
  await createManyChunked(prisma.costEvent, costEvents);
  const customersInsertedSoFar = customers.length;

  // --- Sales for every terminal-SOLD lead, posting the one real revenue entry every dashboard reads ---
  let saleCount = 0;
  let totalItemsSold = 0;
  const itemsByProducerMonth = new Map(); // `${producerId}:${year}-${month}` -> items

  function trackItems(producerId, saleDate, items) {
    const key = `${producerId}:${saleDate.getFullYear()}-${saleDate.getMonth()}`;
    itemsByProducerMonth.set(key, (itemsByProducerMonth.get(key) || 0) + items);
  }

  async function bulkCreateSaleWithRevenue(input) {
    const items = randomItems();
    const premiumCents = randomPremiumCents(input.productFamily);
    const saleDate = new Date(input.receivedAt.getTime() + randomInt(1, 5) * 24 * 60 * 60 * 1000);
    const { firstName, lastName } = demoName();
    const sale = await prisma.sale.create({
      data: {
        agencyId, customerId: input.customerId, leadId: input.leadId || null,
        firstName, lastName, saleDate, carrier: randomChoice(CARRIERS),
        policyType: policyTypeFor(input.productFamily), productFamily: input.productFamily,
        premiumCents, items, assignedToId: input.assignedToId, zip: input.zip || null, state: 'GA',
        createdById: input.assignedToId, clientRequestId: `demo-seed-${uuid()}`,
      },
    });
    await syncSaleRevenueEvent(prisma, sale);
    trackItems(input.assignedToId, saleDate, items);
    totalItemsSold += items;
    saleCount++;
    return sale;
  }

  for (const batch of chunk(soldLeadSaleInputs, 50)) {
    await Promise.all(batch.map((input) => bulkCreateSaleWithRevenue(input)));
  }

  // --- Cross-Sell / Winback opportunity pipeline ---
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
      // createdAt (bulkCreateSaleWithRevenue) without ever landing in the
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
      customers.push({ id: customerId, firstName, lastName, zip, state: 'GA' });
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

  // customers[] already has the general/transfer-pool rows createMany'd
  // above (customersInsertedSoFar) — only the new opportunity-pool
  // customers pushed since then need their own createMany.
  await createManyChunked(prisma.customer, customers.slice(customersInsertedSoFar));
  await createManyChunked(prisma.opportunity, opportunityRows);
  await createManyChunked(prisma.opportunityEvent, opportunityEventRows);

  for (const batch of chunk(wonOpportunities, 50)) {
    await Promise.all(batch.map((input) => bulkCreateSaleWithRevenue(input)));
  }

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
  for (const user of roster.hrRoster) {
    for (let dayOffset = 0; dayOffset <= totalDays; dayOffset++) {
      const day = new Date(start);
      day.setDate(day.getDate() + dayOffset);
      const dow = day.getDay();
      if (dow === 0 || dow === 6) continue; // weekends off
      if (Math.random() < 0.06) continue; // occasional absence

      const clockInAt = new Date(day); clockInAt.setHours(randomInt(8, 9), randomInt(0, 59), 0, 0);
      const lunchStartAt = new Date(clockInAt.getTime() + randomInt(3, 4) * 60 * 60 * 1000);
      const lunchEndAt = new Date(lunchStartAt.getTime() + randomInt(30, 60) * 60 * 1000);
      const breakStartAt = new Date(lunchEndAt.getTime() + randomInt(60, 120) * 60 * 1000);
      const breakEndAt = new Date(breakStartAt.getTime() + randomInt(10, 15) * 60 * 1000);
      const clockOutAt = new Date(day); clockOutAt.setHours(randomInt(17, 18), randomInt(0, 59), 0, 0);

      timeClockRows.push({
        id: uuid(), userId: user.id, agencyId, clockInAt, clockOutAt,
        lunchStartAt, lunchEndAt, breakStartAt, breakEndAt, createdAt: clockInAt,
      });
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

  const gameTypes = ['CONGO_LINE', 'BUCKETS', 'FULL_SEND', 'PILL_POP'];
  const sessionRows = [];
  const bestScores = new Map(); // `${userId}:${gameType}` -> { score, sessionId, achievedAt }
  const clockEntriesByUser = new Map();
  for (const row of timeClockRows) {
    if (!clockEntriesByUser.has(row.userId)) clockEntriesByUser.set(row.userId, []);
    clockEntriesByUser.get(row.userId).push(row);
  }
  for (const user of roster.hrRoster) {
    const entries = clockEntriesByUser.get(user.id) || [];
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

  return {
    seeded: true,
    counts: {
      vendors: vendors.length,
      generalLeads: generalCount,
      transferLeads: transferCount,
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
    },
  };
}

module.exports = { seedRealisticDemoData, DEFAULTS, wipeAgencyDemoData };
