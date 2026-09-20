// Real-database integration test (matches this app's own testing
// philosophy: no mocked Prisma for logic that IS a database query).
// Run with a real DATABASE_URL, same as scripts/smoke-test.js:
//   DATABASE_URL=postgresql://... node --test src/lib/runningReport.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { computeGoalActual, goalsWithProgress } = require('./runningReport');

const suffix = Date.now();
let agencyId;
let userId;
let leadIds = [];
const periodStart = new Date(Date.now() - 60 * 60 * 1000);
const periodEnd = new Date(Date.now() + 60 * 60 * 1000);

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Test Agency ${suffix}` } });
  agencyId = agency.id;

  const user = await prisma.user.create({
    data: {
      email: `producer-${suffix}@test.local`,
      firstName: 'Test',
      lastName: 'Producer',
      role: 'PRODUCER',
      status: 'ACTIVE',
      agencyId,
    },
  });
  userId = user.id;

  // 2 SOLD, 1 QUOTED, 1 with no disposition event at all.
  const dispositions = ['SOLD', 'SOLD', 'QUOTED', null];
  for (const toStatus of dispositions) {
    const lead = await prisma.lead.create({ data: { agencyId, assignedToId: userId } });
    leadIds.push(lead.id);
    if (toStatus) {
      await prisma.leadEvent.create({ data: { leadId: lead.id, type: 'lead.disposition', toStatus } });
    }
  }
});

after(async () => {
  await prisma.leadEvent.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.goal.deleteMany({ where: { agencyId } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await prisma.$disconnect();
});

test('computeGoalActual counts real SOLD dispositions for the sales metric', async () => {
  const actual = await computeGoalActual({ metric: 'sales', userId, agencyId, periodStart, periodEnd });
  assert.equal(actual, 2);
});

test('computeGoalActual counts real QUOTED dispositions for the quotes metric', async () => {
  const actual = await computeGoalActual({ metric: 'quotes', userId, agencyId, periodStart, periodEnd });
  assert.equal(actual, 1);
});

test('computeGoalActual returns null (never a fabricated number) for an unrecognized metric', async () => {
  const actual = await computeGoalActual({ metric: 'not_a_real_metric', userId, agencyId, periodStart, periodEnd });
  assert.equal(actual, null);
});

test('goalsWithProgress computes the correct real percentage for a live goal', async () => {
  await prisma.goal.create({
    data: { agencyId, userId, metric: 'sales', targetValue: 2, periodType: 'custom', periodStart, periodEnd },
  });

  const goals = await goalsWithProgress({ agencyId, userId });
  const salesGoal = goals.find((g) => g.metric === 'sales');
  assert.ok(salesGoal, 'expected the sales goal to be returned as currently active');
  assert.equal(salesGoal.actual, 2);
  assert.equal(salesGoal.progressPercent, 100);
});

test('goalsWithProgress with userId=null (agency-wide) does not pick up an individual producer goal', async () => {
  const goals = await goalsWithProgress({ agencyId, userId: null });
  assert.equal(goals.length, 0);
});
