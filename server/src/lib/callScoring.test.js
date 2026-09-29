const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { computeDrillScore, computeCoachingBreakdown, CATEGORIES } = require('./callScoring');
const { prisma } = require('./db');

test('CATEGORIES weights sum to the real 75-drill library total', () => {
  const total = CATEGORIES.reduce((sum, c) => sum + c.weight, 0);
  assert.equal(total, 75);
});

test('computeDrillScore returns null when there is nothing scoreable', () => {
  assert.equal(computeDrillScore(null), null);
  assert.equal(computeDrillScore({}), null);
});

test('computeDrillScore averages a category\'s dimensions and weights categories by real drill count', () => {
  // Objection Handling (weight 20) scores low; everything else scores high —
  // the overall drillScore should be pulled down noticeably, not diluted
  // away by an equal-weight average across 6 categories.
  const dimensionScores = {
    Opening: 90, Rapport: 90,
    Discovery: 90, 'Needs Analysis': 90, 'Question Quality': 90,
    'Objection Handling': 20,
    Closing: 90, 'Next-Step Clarity': 90,
    'Cross-Sell Awareness': 90,
    Professionalism: 90,
  };
  const result = computeDrillScore(dimensionScores);
  assert.ok(result);
  const objectionCategory = result.categoryScores.find((c) => c.category === 'Objection Handling');
  assert.equal(objectionCategory.score, 20);
  // Weakest-first ordering — the coaching-relevant category should sort first.
  assert.equal(result.categoryScores[0].category, 'Objection Handling');
  // An equal-weight average of the 6 category scores (90,90,20,90,90,90)
  // would be ~78; the real 20/75-weighted average pulls it lower.
  assert.ok(result.drillScore < 75, `expected a materially lower score than an equal-weight average, got ${result.drillScore}`);
});

test('computeDrillScore skips a category with no matching dimension data present (never fabricates a score for it)', () => {
  // Only Opening/Rapport present — every other category is omitted, not
  // scored as 0.
  const result = computeDrillScore({ Opening: 80, Rapport: 60 });
  assert.equal(result.categoryScores.length, 1);
  assert.equal(result.categoryScores[0].category, 'Opening & Rapport');
  assert.equal(result.drillScore, 70);
});

// Real-database integration test for computeCoachingBreakdown — matching
// this app's "never mock the database for real logic" convention (see
// flowScore.test.js, agencyChat.test.js).
const suffix = Date.now();
let agencyId;
let producerId;
let callIds = [];

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Test Agency CS ${suffix}` } });
  agencyId = agency.id;

  const producer = await prisma.user.create({
    data: { email: `producer-cs-${suffix}@test.local`, firstName: 'Test', lastName: 'Producer', role: 'PRODUCER', status: 'ACTIVE', agencyId },
  });
  producerId = producer.id;

  // Two analyzed calls, both weak on Objection Handling, strong elsewhere —
  // the coaching breakdown should surface Objection Handling as the real
  // opportunity, linked to the real TrainingCourse of that exact title.
  const dimensionSets = [
    { Opening: 85, Rapport: 85, Discovery: 85, 'Needs Analysis': 85, 'Question Quality': 85, 'Objection Handling': 30, Closing: 85, 'Next-Step Clarity': 85, 'Cross-Sell Awareness': 85, Professionalism: 85 },
    { Opening: 80, Rapport: 80, Discovery: 80, 'Needs Analysis': 80, 'Question Quality': 80, 'Objection Handling': 40, Closing: 80, 'Next-Step Clarity': 80, 'Cross-Sell Awareness': 80, Professionalism: 80 },
  ];
  for (const dimensionScores of dimensionSets) {
    const call = await prisma.call.create({
      data: {
        agencyId, uploadedById: producerId, filename: 'test.wav', storageKey: `test/${suffix}`,
        status: 'COMPLETE', transcript: 'test transcript',
        analysis: {
          create: {
            summary: 'test', productsDiscussed: [], objections: [], buyingSignals: [],
            missedOpportunities: [], crossSellOpportunities: [], followUpCommitments: [],
            nextSteps: [], strengths: [], coachingOpportunities: [],
            overallScore: 75, dimensionScores, reviewRecommended: false, aiModel: 'test',
          },
        },
      },
    });
    callIds.push(call.id);
  }
});

after(async () => {
  await prisma.callAnalysis.deleteMany({ where: { callId: { in: callIds } } });
  await prisma.call.deleteMany({ where: { id: { in: callIds } } });
  await prisma.user.delete({ where: { id: producerId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await prisma.$disconnect();
});

test('computeCoachingBreakdown averages real call scores and surfaces the real weakest category, linked to its real course', async () => {
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const result = await computeCoachingBreakdown({ prisma, agencyId, userId: producerId, from, to });

  assert.equal(result.analyzedCallCount, 2);
  assert.equal(result.averageOverallScore, 75);

  const objection = result.categoryBreakdown.find((c) => c.category === 'Objection Handling');
  assert.ok(objection, 'expected Objection Handling in the breakdown');
  assert.equal(objection.averageScore, 35); // (30+40)/2
  assert.equal(objection.sampleSize, 2);

  const opportunity = result.coachingOpportunities.find((c) => c.category === 'Objection Handling');
  assert.ok(opportunity, 'expected Objection Handling flagged as a real coaching opportunity (35 < 75 threshold)');
  assert.equal(opportunity.courseTitle, 'Objection Handling');
  assert.ok(opportunity.courseId, 'expected a real linked TrainingCourse id');
});

test('computeCoachingBreakdown returns an honest empty shape (never fabricated numbers) when there are no analyzed calls in range', async () => {
  const from = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const to = new Date(Date.now() - 300 * 24 * 60 * 60 * 1000);
  const result = await computeCoachingBreakdown({ prisma, agencyId, userId: producerId, from, to });
  assert.equal(result.analyzedCallCount, 0);
  assert.equal(result.averageOverallScore, null);
  assert.deepEqual(result.categoryBreakdown, []);
  assert.deepEqual(result.coachingOpportunities, []);
});
