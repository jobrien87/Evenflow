// "Call Scoring" — a drill-based score computed from a call's EXISTING
// AI analysis (callAnalysis.js's 12 SCORING_DIMENSIONS), never a second
// re-analysis of the transcript. Maps the 6 real training-drill
// categories (the 75-drill library imported into Training — see
// prisma/data/trainingDrills.json) onto the dimension(s) each one is
// really about, then combines them into one 0-100 "Drill Score" plus a
// per-category breakdown a manager can act on.
//
// Category weights are the real drill counts per category (15/20/12/10/
// 10/8 — 75 total), so a category the library spends more real time on
// also carries more weight in the overall score — not an arbitrary split.
//
// `title` matches TrainingCourse.title exactly (see
// trainingDrillImport.js), so a weak category can point straight at a
// real, assignable course rather than a made-up recommendation.
//
// "Call Control" has no dimension of its own in callAnalysis.js's list —
// same honest gap trainingRecommendation.js already leaves open for this
// category (TrainingCourse.category: null there) — scored here via
// Professionalism, the closest real proxy, not a fabricated dimension.
const CATEGORIES = [
  { title: 'Opening & Rapport', dimensions: ['Opening', 'Rapport'], weight: 10 },
  { title: 'Discovery & Needs Analysis', dimensions: ['Discovery', 'Needs Analysis', 'Question Quality'], weight: 12 },
  { title: 'Objection Handling', dimensions: ['Objection Handling'], weight: 20 },
  { title: 'Closing Techniques', dimensions: ['Closing', 'Next-Step Clarity'], weight: 15 },
  { title: 'Follow-Up & Pipeline', dimensions: ['Next-Step Clarity', 'Cross-Sell Awareness'], weight: 10 },
  { title: 'Call Control', dimensions: ['Professionalism'], weight: 8 },
];

// One call's dimensionScores -> { drillScore, categoryScores } — null if
// there's nothing scoreable yet (e.g. analysis not complete).
function computeDrillScore(dimensionScores) {
  if (!dimensionScores || typeof dimensionScores !== 'object') return null;

  const categoryScores = [];
  let weightedSum = 0;
  let totalWeight = 0;

  for (const { title, dimensions, weight } of CATEGORIES) {
    const values = dimensions.map((d) => dimensionScores[d]).filter((v) => typeof v === 'number');
    if (values.length === 0) continue;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    categoryScores.push({ category: title, score: Math.round(avg) });
    weightedSum += avg * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return null;

  return {
    drillScore: Math.round(weightedSum / totalWeight),
    categoryScores: categoryScores.sort((a, b) => a.score - b.score),
  };
}

const COACHING_THRESHOLD = 75; // below this, a category is a real coaching opportunity, not just "room to grow"

// Combines one producer's calls (already-analyzed, in a date range) into
// a real, non-fabricated coaching breakdown: average scores per real
// drill category across every call, plus the weakest categories linked
// to their real, assignable TrainingCourse.
async function computeCoachingBreakdown({ prisma, agencyId, userId, from, to }) {
  const calls = await prisma.call.findMany({
    where: {
      uploadedById: userId,
      ...(agencyId ? { agencyId } : {}),
      status: 'COMPLETE',
      createdAt: { gte: from, lte: to },
    },
    include: { analysis: { select: { overallScore: true, dimensionScores: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const scored = calls
    .filter((c) => c.analysis)
    .map((c) => ({ call: c, drill: computeDrillScore(c.analysis.dimensionScores) }))
    .filter((r) => r.drill);

  if (scored.length === 0) {
    return { callCount: 0, analyzedCallCount: 0, averageOverallScore: null, averageDrillScore: null, categoryBreakdown: [], coachingOpportunities: [] };
  }

  const averageOverallScore = Math.round(
    scored.reduce((sum, r) => sum + r.call.analysis.overallScore, 0) / scored.length
  );
  const averageDrillScore = Math.round(
    scored.reduce((sum, r) => sum + r.drill.drillScore, 0) / scored.length
  );

  // Per-category average across every call that had data for it —
  // categories aren't scored on every call equally, so each is averaged
  // over only the calls that actually had a real value.
  const categoryBreakdown = CATEGORIES.map(({ title }) => {
    const values = scored
      .map((r) => r.drill.categoryScores.find((c) => c.category === title)?.score)
      .filter((v) => typeof v === 'number');
    if (values.length === 0) return null;
    return {
      category: title,
      averageScore: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
      sampleSize: values.length,
    };
  }).filter(Boolean).sort((a, b) => a.averageScore - b.averageScore);

  const weakCategories = categoryBreakdown.filter((c) => c.averageScore < COACHING_THRESHOLD).slice(0, 3);
  const coachingOpportunities = await Promise.all(
    weakCategories.map(async (c) => {
      const course = await prisma.trainingCourse.findFirst({ where: { title: c.category }, select: { id: true, title: true } });
      return {
        category: c.category,
        averageScore: c.averageScore,
        sampleSize: c.sampleSize,
        courseId: course?.id || null,
        courseTitle: course?.title || null,
      };
    })
  );

  return {
    callCount: calls.length,
    analyzedCallCount: scored.length,
    averageOverallScore,
    averageDrillScore,
    categoryBreakdown,
    coachingOpportunities,
  };
}

module.exports = { computeDrillScore, computeCoachingBreakdown, CATEGORIES };
