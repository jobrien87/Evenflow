// Real-database test for the realistic demo-data seeder —
//   DATABASE_URL=postgresql... node --test src/lib/demoDataSeeder.test.js
//
// Runs at a small scale (months:1, leadsPerDay:20, etc.) so the suite
// stays fast — the seeder's own numeric defaults (6 months, 300/day) are
// exercised manually, not in this automated suite (see the session's
// manual full-scale smoke test). Covers every invariant the plan called
// out: exactly 5 "Lead Source" vendors with a ~$5.25 blended cost; a real
// CostEvent per vendor-sourced lead; every SOLD lead has exactly one
// non-voided linked Sale; Opportunity counts match the requested totals
// with a real matching Sale for every WON one; every producer gets one
// Goal per month with metric 'items'/target 100, and completedAt agrees
// with the real summed Sale.items for that exact month; HR rows exist for
// every roster member; and re-running the seeder on the same agency wipes
// old rows first instead of duplicating them.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { prisma } = require('./db');
const { seedRealisticDemoData } = require('./demoDataSeeder');
const { computeGoalActual } = require('./runningReport');

const suffix = Date.now();
const SMALL = { months: 1, leadsPerDay: 20, transfersPerDay: 3, crossSellCount: 30, winbackCount: 30 };

let agency;
let owner;
let producers;
let telemarketers;

after(async () => {
  if (!agency) return;
  const agencyId = agency.id;
  await prisma.breakRoomAchievement.deleteMany({ where: { agencyId } });
  await prisma.breakRoomHighScore.deleteMany({ where: { agencyId } });
  await prisma.breakRoomGameSession.deleteMany({ where: { agencyId } });
  await prisma.timeClockEntry.deleteMany({ where: { agencyId } });
  await prisma.ptoRequest.deleteMany({ where: { agencyId } });
  await prisma.goal.deleteMany({ where: { agencyId } });
  await prisma.opportunityEvent.deleteMany({ where: { opportunity: { agencyId } } });
  await prisma.opportunity.deleteMany({ where: { agencyId } });
  await prisma.revenueEvent.deleteMany({ where: { agencyId } });
  await prisma.costEvent.deleteMany({ where: { agencyId } });
  await prisma.sale.deleteMany({ where: { agencyId } });
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.vendor.deleteMany({ where: { agencyId } });
  await prisma.auditEvent.deleteMany({ where: { agencyId } });
  const userIds = [owner.id, ...producers.map((p) => p.id), ...telemarketers.map((t) => t.id)];
  await prisma.telemarketerAssignment.deleteMany({ where: { agencyId } });
  await prisma.telemarketerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.agencySubscription.deleteMany({ where: { agencyId } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await prisma.$disconnect();
});

test('setup: build a throwaway demo-shaped agency + roster', async () => {
  agency = await prisma.agency.create({ data: { name: `Seeder Test Agency ${suffix}`, status: 'ACTIVE', isDemo: true } });
  const passwordHash = await bcrypt.hash('password123', 12);
  owner = await prisma.user.create({ data: { email: `seeder-owner-${suffix}@test.local`, firstName: 'Seeder', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId: agency.id, status: 'ACTIVE', passwordHash } });
  producers = await Promise.all([1, 2, 3].map((i) => prisma.user.create({ data: { email: `seeder-p${i}-${suffix}@test.local`, firstName: 'Seeder', lastName: `Producer${i}`, role: 'PRODUCER', agencyId: agency.id, status: 'ACTIVE', passwordHash } })));
  telemarketers = await Promise.all([1, 2].map(async (i) => {
    const u = await prisma.user.create({ data: { email: `seeder-tm${i}-${suffix}@test.local`, firstName: 'Seeder', lastName: `TM${i}`, role: 'TELEMARKETER', status: 'ACTIVE', passwordHash } });
    await prisma.telemarketerProfile.create({ data: { userId: u.id, status: 'ACTIVE' } });
    await prisma.telemarketerAssignment.create({ data: { telemarketerId: u.id, agencyId: agency.id, status: 'ACTIVE' } });
    return u;
  }));
  assert.ok(agency.id);
});

test('seedRealisticDemoData: exactly 5 "Lead Source" vendors averaging ~$5.25/lead, each with real CostEvent coverage', async () => {
  await seedRealisticDemoData(agency.id, SMALL);

  const vendors = await prisma.vendor.findMany({ where: { agencyId: agency.id }, orderBy: { name: 'asc' } });
  assert.equal(vendors.length, 5);
  assert.deepEqual(vendors.map((v) => v.name), ['Lead Source A', 'Lead Source B', 'Lead Source C', 'Lead Source D', 'Lead Source E']);

  const blended = Math.round(vendors.reduce((sum, v) => sum + v.costPerLeadCents, 0) / vendors.length);
  assert.equal(blended, 525, 'plain-average vendor cost must be exactly $5.25');

  for (const vendor of vendors) {
    const leadCount = await prisma.lead.count({ where: { agencyId: agency.id, vendorId: vendor.id } });
    const costEventCount = await prisma.costEvent.count({ where: { agencyId: agency.id, vendorId: vendor.id } });
    assert.equal(costEventCount, leadCount, `every lead from ${vendor.name} must have exactly one matching CostEvent`);
  }
});

test('seedRealisticDemoData: every SOLD lead has exactly one real, non-voided linked Sale, carrying a real GA zip', async () => {
  const soldLeads = await prisma.lead.findMany({ where: { agencyId: agency.id, status: 'SOLD' }, select: { id: true } });
  assert.ok(soldLeads.length > 0, 'the small-scale seed should still produce at least one closed deal');
  for (const lead of soldLeads) {
    const sales = await prisma.sale.findMany({ where: { leadId: lead.id, voidedAt: null } });
    assert.equal(sales.length, 1, `lead ${lead.id} marked SOLD must have exactly one real Sale`);
    // Billboard's own "BY ZIP CODE" breakdown reads Sale.zip directly, not
    // the linked Lead's zip — every seeded Sale must carry its own real
    // GA zip or it silently buckets into Billboard's "Unknown" row.
    assert.ok(sales[0].zip, 'the Sale row itself must carry a real zip, not just its linked Lead');
    assert.equal(sales[0].state, 'GA');
  }
});

test('seedRealisticDemoData: every won-opportunity Sale also carries a real GA zip', async () => {
  const wonOpps = await prisma.opportunity.findMany({ where: { agencyId: agency.id, status: 'WON' }, select: { customerId: true } });
  for (const opp of wonOpps) {
    const sale = await prisma.sale.findFirst({ where: { agencyId: agency.id, customerId: opp.customerId, voidedAt: null } });
    assert.ok(sale, 'a WON opportunity must have a matching Sale');
    assert.ok(sale.zip, 'an opportunity-driven Sale must carry a real zip too');
  }
});

test('seedRealisticDemoData: Cross-Sell/Winback Opportunity counts match the request, and every WON one has a real matching Sale', async () => {
  const crossSell = await prisma.opportunity.findMany({ where: { agencyId: agency.id, type: 'CROSS_SELL' } });
  const winback = await prisma.opportunity.findMany({ where: { agencyId: agency.id, type: 'WINBACK' } });
  assert.equal(crossSell.length, SMALL.crossSellCount);
  assert.equal(winback.length, SMALL.winbackCount);

  for (const opp of [...crossSell, ...winback]) {
    if (opp.type === 'WINBACK') {
      assert.ok(opp.previousProduct, 'a Winback opportunity must carry a fabricated previousProduct');
      assert.ok(opp.lostAt, 'a Winback opportunity must carry a fabricated lostAt');
      assert.ok(opp.lostReason, 'a Winback opportunity must carry a fabricated lostReason');
    } else {
      assert.equal(opp.previousProduct, null, 'a Cross-Sell opportunity must never carry Winback-only fields');
    }
  }

  const won = [...crossSell, ...winback].filter((o) => o.status === 'WON');
  assert.ok(won.length > 0, 'at least one opportunity should have converted at this scale');
  for (const opp of won) {
    assert.ok(opp.wonPremiumCents > 0);
    const events = await prisma.opportunityEvent.findMany({ where: { opportunityId: opp.id } });
    assert.ok(events.length >= 1, 'every opportunity must have at least a creation event');
  }
  // Total real sales = closed-lead sales + won-opportunity sales; this
  // just confirms the won-opportunity share exists as real Sale rows by
  // checking total sales comfortably exceeds the lead-only SOLD count.
  const soldLeadCount = await prisma.lead.count({ where: { agencyId: agency.id, status: 'SOLD' } });
  const totalSales = await prisma.sale.count({ where: { agencyId: agency.id } });
  assert.ok(totalSales >= soldLeadCount + won.length, 'total sales must cover both closed leads and won opportunities');
});

test('seedRealisticDemoData: every producer has one monthly "items" Goal per month, agreeing with the real computed total', async () => {
  for (const producer of producers) {
    const goals = await prisma.goal.findMany({ where: { agencyId: agency.id, userId: producer.id } });
    assert.equal(goals.length, SMALL.months);
    for (const goal of goals) {
      assert.equal(goal.metric, 'items');
      assert.equal(goal.targetValue, 100);
      const actual = await computeGoalActual({ metric: 'items', userId: producer.id, agencyId: agency.id, periodStart: goal.periodStart, periodEnd: goal.periodEnd });
      assert.equal(!!goal.completedAt, actual >= 100, `completedAt must agree with the real live computation for producer ${producer.lastName}`);
    }
  }
});

test('seedRealisticDemoData: HR rows (TimeClockEntry, PtoRequest) exist for every roster member', async () => {
  for (const user of [owner, ...producers, ...telemarketers]) {
    const clockCount = await prisma.timeClockEntry.count({ where: { agencyId: agency.id, userId: user.id } });
    const ptoCount = await prisma.ptoRequest.count({ where: { agencyId: agency.id, userId: user.id } });
    assert.ok(clockCount > 0, `${user.lastName} must have at least one TimeClockEntry`);
    assert.ok(ptoCount > 0, `${user.lastName} must have at least one PtoRequest`);
  }
});

test('seedRealisticDemoData: re-running on the same agency wipes old rows first, never duplicating', async () => {
  const before = {
    leads: await prisma.lead.count({ where: { agencyId: agency.id } }),
    opportunities: await prisma.opportunity.count({ where: { agencyId: agency.id } }),
    vendors: await prisma.vendor.count({ where: { agencyId: agency.id } }),
  };

  await seedRealisticDemoData(agency.id, SMALL);

  const after = {
    leads: await prisma.lead.count({ where: { agencyId: agency.id } }),
    opportunities: await prisma.opportunity.count({ where: { agencyId: agency.id } }),
    vendors: await prisma.vendor.count({ where: { agencyId: agency.id } }),
  };

  // Same seed config -> same row counts (randomized content, stable
  // shape), never additive across a reseed.
  assert.equal(after.vendors, 5);
  assert.equal(after.opportunities, before.opportunities, 'a reseed must not duplicate opportunities');
  assert.ok(Math.abs(after.leads - before.leads) <= 1, 'lead count should match the same config, not accumulate across a reseed');
});

test('seedRealisticDemoData: zero producers is a safe no-op', async () => {
  const soloAgency = await prisma.agency.create({ data: { name: `Seeder Solo Agency ${suffix}`, status: 'ACTIVE', isDemo: true } });
  const result = await seedRealisticDemoData(soloAgency.id, SMALL);
  assert.deepEqual(result, { seeded: false, reason: 'NO_PRODUCERS' });
  await prisma.agency.delete({ where: { id: soloAgency.id } });
});
