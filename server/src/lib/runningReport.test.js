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
let importBatchId;
let historicalRecordIds = [];
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

  // A Lead reaching SOLD (via disposition or otherwise) is a queue/pipeline
  // event only now — it must never count toward a sales goal. Keep one
  // SOLD disposition as a negative-control regression guard, alongside the
  // real QUOTED one (still pipeline-based, unaffected) and one lead with no
  // event at all.
  const dispositions = ['SOLD', 'QUOTED', null];
  for (const toStatus of dispositions) {
    const lead = await prisma.lead.create({ data: { agencyId, assignedToId: userId } });
    leadIds.push(lead.id);
    if (toStatus) {
      await prisma.leadEvent.create({ data: { leadId: lead.id, type: 'lead.disposition', toStatus } });
    }
  }

  // The real production source for the 'sales'/'premium_cents' goal
  // metrics now: 2 HistoricalRecord rows attributed to this producer.
  const batch = await prisma.leadImportBatch.create({
    data: { agencyId, uploadedById: userId, isHistorical: true, totalRows: 2, created: 2, skipped: 0 },
  });
  importBatchId = batch.id;
  for (let i = 0; i < 2; i++) {
    const record = await prisma.historicalRecord.create({
      data: { agencyId, importBatchId, assignedToId: userId, premiumCents: 10000, recordDate: new Date(), isSold: true, sourceSystem: 'OTHER' },
    });
    historicalRecordIds.push(record.id);
  }
});

after(async () => {
  await prisma.historicalRecord.deleteMany({ where: { id: { in: historicalRecordIds } } });
  await prisma.leadImportBatch.delete({ where: { id: importBatchId } });
  await prisma.leadEvent.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.goal.deleteMany({ where: { agencyId } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await prisma.$disconnect();
});

test('computeGoalActual counts real production (Historical Data/Add Closed Sale) for the sales metric, never a live Lead-SOLD disposition', async () => {
  const actual = await computeGoalActual({ metric: 'sales', userId, agencyId, periodStart, periodEnd });
  assert.equal(actual, 2, 'the 2 HistoricalRecord rows count; the live SOLD disposition does not');
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
