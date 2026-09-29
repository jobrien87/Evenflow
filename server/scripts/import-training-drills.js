// CLI entry point for the training-drill import — see
// src/lib/trainingDrillImport.js for the actual logic.
//
// Usage: node scripts/import-training-drills.js
// (run from server/, same as prisma/seed.js — needs a real DATABASE_URL)

const { prisma } = require('../src/lib/db');
const { runTrainingDrillImport } = require('../src/lib/trainingDrillImport');

async function main() {
  const result = await runTrainingDrillImport();

  for (const c of result.courseSummaries) {
    console.log(
      c.lessonsCreated > 0
        ? `${c.title}: created ${c.lessonsCreated} of ${c.totalLessons} lessons`
        : `${c.title}: already up to date (${c.totalLessons} lessons)`
    );
  }
  console.log('');
  console.log(`Courses created: ${result.coursesCreated} (of ${result.totalCourses} total)`);
  console.log(`Lessons created: ${result.lessonsCreated}`);
  console.log(`Lessons skipped (already existed): ${result.lessonsSkipped}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
