// Imports the sales-training drill library (75 drills across 6 categories)
// into TrainingCourse/TrainingLesson as real, browsable/assignable Training
// content. Source data: prisma/data/trainingDrills.json (pre-extracted,
// static — this module does no scraping/parsing of its own).
//
// Idempotent: safe to re-run. A course/lesson that already exists (matched
// by title within its course) is left untouched, not duplicated.
//
// Shared by scripts/import-training-drills.js (direct CLI run) and
// routes/adminImport.js (one-off HTTPS-triggered run against an
// environment this sandbox can't reach a raw Postgres connection to) —
// one canonical implementation, not two.

const path = require('path');
const { prisma } = require('./db');

const DATA_PATH = path.join(__dirname, '..', '..', 'prisma', 'data', 'trainingDrills.json');

async function runTrainingDrillImport() {
  const { courses } = require(DATA_PATH);

  // Course/lesson creation is Platform-Owner-only by design (training.js) —
  // attribute these to a real Platform Owner rather than leaving
  // createdById unset.
  const owner = await prisma.user.findFirst({
    where: { role: 'PLATFORM_OWNER' },
    orderBy: { createdAt: 'asc' },
  });
  if (!owner) {
    throw new Error('No PLATFORM_OWNER user found — run prisma/seed.js first.');
  }

  let coursesCreated = 0;
  let lessonsCreated = 0;
  let lessonsSkipped = 0;
  const courseSummaries = [];

  for (const courseData of courses) {
    let course = await prisma.trainingCourse.findFirst({ where: { title: courseData.title } });
    if (!course) {
      course = await prisma.trainingCourse.create({
        data: {
          title: courseData.title,
          description: courseData.description,
          category: courseData.category,
          createdById: owner.id,
          isActive: true,
        },
      });
      coursesCreated += 1;
    }

    let courseLessonsCreated = 0;
    for (const lessonData of courseData.lessons) {
      const existing = await prisma.trainingLesson.findFirst({
        where: { courseId: course.id, title: lessonData.title },
      });
      if (existing) {
        lessonsSkipped += 1;
        continue;
      }
      await prisma.trainingLesson.create({
        data: {
          courseId: course.id,
          title: lessonData.title,
          content: lessonData.content,
          orderIndex: lessonData.orderIndex,
          videoUrl: null,
          quiz: null,
        },
      });
      lessonsCreated += 1;
      courseLessonsCreated += 1;
    }

    courseSummaries.push({ title: course.title, lessonsCreated: courseLessonsCreated, totalLessons: courseData.lessons.length });
  }

  return {
    totalCourses: courses.length,
    coursesCreated,
    lessonsCreated,
    lessonsSkipped,
    courseSummaries,
  };
}

module.exports = { runTrainingDrillImport };
