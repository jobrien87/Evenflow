// Lightweight keyword-overlap search over the 75-drill training library, so
// ED and the drill roleplay can ground their answers/feedback in real drill
// content instead of only numeric context. No embeddings/vector DB — at 75
// rows a simple token-overlap score is plenty, matches this app's
// established "no unnecessary infra" pattern (see aiProvider.js's own
// comment on the same principle). Never a second AI call just to search.

const { prisma } = require('./db');

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'how', 'do', 'does', 'did', 'i', 'my', 'me',
  'what', 'when', 'why', 'who', 'can', 'you', 'your', 'it', 'that', 'this',
  'so', 'if', 'not', 'at', 'as', 'by', 'from', 'about', 'them', 'they', 'its',
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// Real drill content changes rarely (an admin-only import script, not a
// live-editing UI), so a short in-process cache avoids re-querying+
// re-tokenizing all 75 lessons on every ED/roleplay turn.
let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getIndexedLessons() {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;

  const lessons = await prisma.trainingLesson.findMany({
    where: { course: { isActive: true } },
    include: { course: { select: { title: true } } },
  });

  cache = lessons.map((l) => ({
    id: l.id,
    title: l.title,
    courseTitle: l.course.title,
    content: l.content,
    titleTokens: tokenize(l.title),
    contentTokens: tokenize(l.content),
  }));
  cacheAt = Date.now();
  return cache;
}

// Scores every lesson by query-token overlap (title matches count 3x a body
// match) and returns the top `limit` with score > 0. Returns [] when the
// query has no usable tokens or nothing matches — callers must treat that as
// "no relevant drill," never as an error.
async function findRelevantLessons(queryText, { limit = 3, excludeIds = [] } = {}) {
  const queryTokens = tokenize(queryText);
  if (queryTokens.length === 0) return [];

  const lessons = await getIndexedLessons();
  const scored = lessons
    .filter((l) => !excludeIds.includes(l.id))
    .map((l) => {
      let score = 0;
      for (const qt of queryTokens) {
        if (l.titleTokens.includes(qt)) score += 3;
        for (const ct of l.contentTokens) {
          if (ct === qt) score += 1;
        }
      }
      return { id: l.id, title: l.title, courseTitle: l.courseTitle, content: l.content, score };
    })
    .filter((l) => l.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ score, ...rest }) => rest);
}

module.exports = { findRelevantLessons, tokenize };
