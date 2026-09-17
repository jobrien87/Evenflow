const { prisma } = require('./db');

// Per spec: recommendations must be "based on evidence" — this looks at a
// producer's actual recent CallAnalysis dimension scores, finds their
// weakest scoring dimension, and matches it against an active course's
// category. If nothing matches, it returns null with a reason rather than
// inventing a recommendation. No LLM call here — this is exactly the kind
// of thing plain SQL/arithmetic should compute, not an AI guess.

async function recommendTrainingForProducer(userId) {
  const recentCalls = await prisma.call.findMany({
    where: { uploadedById: userId, status: 'COMPLETE' },
    include: { analysis: { select: { dimensionScores: true } } },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  const analyzedCalls = recentCalls.filter((c) => c.analysis);
  if (analyzedCalls.length === 0) {
    return { recommended: null, reason: 'No analyzed calls yet, upload a call to get a personalized recommendation.' };
  }

  const totals = {};
  const counts = {};
  for (const call of analyzedCalls) {
    const scores = call.analysis.dimensionScores || {};
    for (const [dim, score] of Object.entries(scores)) {
      totals[dim] = (totals[dim] || 0) + score;
      counts[dim] = (counts[dim] || 0) + 1;
    }
  }
  const averages = Object.keys(totals).map((dim) => ({ dimension: dim, average: totals[dim] / counts[dim] }));
  if (averages.length === 0) {
    return { recommended: null, reason: 'No dimension scores found on recent calls.' };
  }

  averages.sort((a, b) => a.average - b.average);
  const weakest = averages[0];

  const courses = await prisma.trainingCourse.findMany({ where: { isActive: true } });
  const match = courses.find(
    (c) => c.category && weakest.dimension.toLowerCase().includes(c.category.toLowerCase())
  );

  if (!match) {
    return {
      recommended: null,
      reason: `Weakest scoring area is "${weakest.dimension}" (avg ${Math.round(weakest.average)}/100), but no active course is tagged for it yet.`,
      weakestDimension: weakest.dimension,
      weakestAverage: Math.round(weakest.average),
    };
  }

  return {
    recommended: match,
    weakestDimension: weakest.dimension,
    weakestAverage: Math.round(weakest.average),
    reason: `Based on ${analyzedCalls.length} recent call${analyzedCalls.length === 1 ? '' : 's'}, "${weakest.dimension}" is averaging ${Math.round(weakest.average)}/100.`,
  };
}

module.exports = { recommendTrainingForProducer };
