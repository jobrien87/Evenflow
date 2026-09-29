// Pure-function test for tokenize, plus a real-database integration test for
// findRelevantLessons against real TrainingCourse/TrainingLesson rows (never
// mocked Prisma for logic that IS a database query — same philosophy as
// leadDistribution.test.js). Run with a real DATABASE_URL:
//   DATABASE_URL=postgresql://... node --test src/lib/drillRetrieval.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { tokenize, findRelevantLessons } = require('./drillRetrieval');

test('tokenize lowercases, splits on non-alphanumerics, and drops stopwords/short tokens', () => {
  assert.deepEqual(tokenize('How do I handle a price objection?'), ['handle', 'price', 'objection']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});

const suffix = Date.now();
let courseId;
let priceObjectionLessonId;
let unrelatedLessonId;

before(async () => {
  const course = await prisma.trainingCourse.create({
    data: { title: `Objection Handling Test ${suffix}`, isActive: true },
  });
  courseId = course.id;

  const priceLesson = await prisma.trainingLesson.create({
    data: {
      courseId,
      title: 'Handling the Price Objection',
      content: 'When a prospect says your price is too high, isolate the objection before responding. Ask what they are comparing it to.',
    },
  });
  priceObjectionLessonId = priceLesson.id;

  const unrelatedLesson = await prisma.trainingLesson.create({
    data: {
      courseId,
      title: 'Opening Rapport Warmup',
      content: 'Greet the prospect warmly and establish trust before moving into discovery questions.',
    },
  });
  unrelatedLessonId = unrelatedLesson.id;
});

after(async () => {
  await prisma.trainingLesson.deleteMany({ where: { courseId } });
  await prisma.trainingCourse.delete({ where: { id: courseId } });
  await prisma.$disconnect();
});

// The real 75-drill library may already contain rows that also score well
// against this query, so this doesn't assert global rank #1 — only that the
// on-topic test lesson matches at all, and outranks the unrelated one
// relative to each other (real isolation-safe assertions, not dependent on
// what else happens to be imported).
test('findRelevantLessons matches the on-topic lesson and ranks it above the unrelated one', async () => {
  const results = await findRelevantLessons('price objection handling technique', { limit: 200 });
  const ids = results.map((r) => r.id);
  const priceIndex = ids.indexOf(priceObjectionLessonId);
  const unrelatedIndex = ids.indexOf(unrelatedLessonId);
  assert.notEqual(priceIndex, -1, 'expected the price-objection lesson to match');
  if (unrelatedIndex !== -1) {
    assert.ok(priceIndex < unrelatedIndex, 'expected the on-topic lesson to outrank the unrelated one');
  }
});

test('findRelevantLessons respects excludeIds', async () => {
  const results = await findRelevantLessons('price objection', { limit: 5, excludeIds: [priceObjectionLessonId] });
  assert.ok(!results.some((r) => r.id === priceObjectionLessonId));
});

test('findRelevantLessons returns [] for a query with no usable tokens', async () => {
  const results = await findRelevantLessons('a to of', { limit: 5 });
  assert.deepEqual(results, []);
});
