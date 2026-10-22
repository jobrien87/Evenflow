// ED's "what's new" feed — real, Platform-Owner-published ProductUpdate
// rows, surfaced through ED's daily briefing and available for ED to
// mention in normal chat ("the Record Store just opened up!"). This is
// deliberately separate from lib/edKnowledgeBase.js: the knowledge base is
// static, hand-maintained reference material about how features work;
// this is a timestamped, admin-authored news feed, never both.
const { prisma } = require('./db');

// { limit, sinceDate } -> ProductUpdate[], newest first, scoped to what
// this role is allowed to hear about (empty audienceRoles = every role).
// sinceDate narrows to "actually new" for a briefing; omitted entirely for
// a general "what's new lately" question in normal chat.
async function getRecentForRole(role, { limit = 5, sinceDate } = {}) {
  return prisma.productUpdate.findMany({
    where: {
      OR: [{ audienceRoles: { isEmpty: true } }, { audienceRoles: { has: role } }],
      ...(sinceDate ? { publishedAt: { gte: sinceDate } } : {}),
    },
    orderBy: { publishedAt: 'desc' },
    take: limit,
    select: { id: true, title: true, body: true, publishedAt: true },
  });
}

module.exports = { getRecentForRole };
