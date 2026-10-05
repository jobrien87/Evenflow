const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notifyUser } = require('../lib/notifications');
const {
  GAME_TYPES,
  canAccessBreakRoom,
  reasonMessage,
  resolveSettings,
  ACHIEVEMENTS,
} = require('../lib/breakRoom');
const { validateScore } = require('../lib/breakRoomAntiCheat');

const router = express.Router();
router.use(requireAuth);

// Every real route here is for the two roles that ever clock in/out at
// all — Agency Owner/Manager/Platform Owner have no break state to gate
// on, so they have no Break Room of their own to play in (Platform Owner
// still reaches the admin sub-routes below, which are mounted separately
// from this per-user gate).
router.use(
  ['/access', '/home', '/sessions', '/leaderboard', '/jokes', '/achievements', '/stats'],
  requireRole('PRODUCER', 'TELEMARKETER')
);

// GET /access — always answerable regardless of break state; this is
// what the client polls to decide lock-screen vs. arcade, and to detect
// "break just ended" while a game is in progress.
router.get('/access', async (req, res, next) => {
  try {
    const result = await canAccessBreakRoom(req.user);
    return res.json({
      success: true,
      allowed: result.allowed,
      reason: result.reason,
      message: result.reason ? reasonMessage(result.reason) : null,
      state: result.state,
      settings: result.settings,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Landing page data — visible whenever the module is enabled, whether or
// not the employee is currently on break (the lock screen is a CLIENT
// overlay on top of this same data, per the product spec: cabinets stay
// visible, just dimmed, when not unlocked).
// ---------------------------------------------------------------------
router.get('/home', async (req, res, next) => {
  try {
    const access = await canAccessBreakRoom(req.user);
    if (access.reason === 'NOT_ELIGIBLE_ROLE') {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    // A user with no agency/entry yet still gets the landing page (locked),
    // just with no real settings/leaderboard data to show.
    const agencyId = access.agencyId;
    const settings = access.settings;

    if (!agencyId) {
      return res.json({
        success: true,
        allowed: false,
        reason: access.reason,
        message: reasonMessage(access.reason),
        settings: null,
        games: GAME_TYPES.map((g) => ({ gameType: g, personalBest: null, agencyBest: null, officeBest: null })),
        todaysChampion: null,
      });
    }

    const [personalBests, agencyBests, officeBests, todaysSession] = await Promise.all([
      prisma.breakRoomHighScore.findMany({ where: { userId: req.user.id, agencyId } }),
      prisma.breakRoomHighScore.groupBy({ by: ['gameType'], where: { agencyId }, _max: { bestScore: true } }),
      req.user.officeId
        ? prisma.breakRoomHighScore.groupBy({ by: ['gameType'], where: { agencyId, officeId: req.user.officeId }, _max: { bestScore: true } })
        : Promise.resolve([]),
      prisma.breakRoomGameSession.findFirst({
        where: { agencyId, status: 'COMPLETED', excludedFromLeaderboard: false, createdAt: { gte: new Date(new Date().setUTCHours(0, 0, 0, 0)) } },
        orderBy: { score: 'desc' },
        include: { user: { select: { id: true, firstName: true, lastName: true } } },
      }),
    ]);

    const personalByGame = new Map(personalBests.map((r) => [r.gameType, r.bestScore]));
    const agencyByGame = new Map(agencyBests.map((r) => [r.gameType, r._max.bestScore]));
    const officeByGame = new Map(officeBests.map((r) => [r.gameType, r._max.bestScore]));

    const games = GAME_TYPES.map((g) => ({
      gameType: g,
      enabled: !!(settings && settings.games[g]),
      personalBest: personalByGame.get(g) ?? null,
      agencyBest: agencyByGame.get(g) ?? null,
      officeBest: req.user.officeId ? (officeByGame.get(g) ?? null) : null,
    }));

    return res.json({
      success: true,
      allowed: access.allowed,
      reason: access.reason,
      message: access.reason ? reasonMessage(access.reason) : null,
      settings,
      games,
      todaysChampion: todaysSession
        ? { userId: todaysSession.user.id, firstName: todaysSession.user.firstName, lastName: todaysSession.user.lastName, gameType: todaysSession.gameType, score: todaysSession.score }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Game sessions
// ---------------------------------------------------------------------
const startSessionSchema = z.object({ gameType: z.enum(GAME_TYPES) });

router.post('/sessions', async (req, res, next) => {
  try {
    const parsed = startSessionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const access = await canAccessBreakRoom(req.user);
    if (!access.allowed) {
      return res.status(403).json({ success: false, error: access.reason, message: reasonMessage(access.reason) });
    }
    if (!access.settings.games[parsed.data.gameType]) {
      return res.status(403).json({ success: false, error: 'GAME_DISABLED', message: 'This game is turned off for your agency right now.' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { officeId: true } });
    const session = await prisma.breakRoomGameSession.create({
      data: {
        userId: req.user.id,
        agencyId: access.agencyId,
        officeId: user ? user.officeId : null,
        timeClockEntryId: access.entry.id,
        gameType: parsed.data.gameType,
        clientToken: crypto.randomUUID(),
      },
    });
    return res.status(201).json({ success: true, sessionId: session.id, startedAt: session.startedAt });
  } catch (err) {
    next(err);
  }
});

const endSessionSchema = z.object({
  score: z.number().int().min(0),
  metrics: z.record(z.any()).optional(),
});

router.post('/sessions/:id/end', async (req, res, next) => {
  try {
    const parsed = endSessionSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const session = await prisma.breakRoomGameSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.userId !== req.user.id) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    }
    if (session.status !== 'ACTIVE') {
      return res.status(409).json({ success: false, error: 'SESSION_ALREADY_ENDED' });
    }

    const endedAt = new Date();
    const durationMs = endedAt.getTime() - session.startedAt.getTime();
    const check = validateScore(session.gameType, { score: parsed.data.score, metrics: parsed.data.metrics, durationMs });

    if (!check.valid) {
      await prisma.breakRoomGameSession.update({
        where: { id: session.id },
        data: { status: 'ABANDONED', endedAt, durationMs, score: 0, metrics: parsed.data.metrics, flagReason: check.reason, excludedFromLeaderboard: true },
      });
      return res.status(422).json({ success: false, error: 'SCORE_REJECTED', reason: check.reason });
    }

    const updated = await prisma.breakRoomGameSession.update({
      where: { id: session.id },
      data: {
        status: 'COMPLETED',
        endedAt,
        durationMs,
        score: parsed.data.score,
        metrics: parsed.data.metrics,
        excludedFromLeaderboard: check.flagged,
        flagReason: check.reason,
      },
    });

    let newPersonalBest = false;
    let agencyRankOneChanged = null;
    const achievementsUnlocked = [];

    if (!check.flagged) {
      const agencyForSettings = await prisma.agency.findUnique({ where: { id: session.agencyId }, select: { breakRoomSettings: true } });
      const settings = resolveSettings(agencyForSettings ? agencyForSettings.breakRoomSettings : null);
      const existingBest = await prisma.breakRoomHighScore.findUnique({
        where: { userId_gameType: { userId: req.user.id, gameType: session.gameType } },
      });
      if (!existingBest || updated.score > existingBest.bestScore) {
        newPersonalBest = true;
        // Who held the agency #1 spot for this game before this write —
        // used to send a single, real "you just got passed" notification,
        // never a spammy one per leaderboard movement.
        const previousAgencyBest = await prisma.breakRoomHighScore.findFirst({
          where: { agencyId: session.agencyId, gameType: session.gameType },
          orderBy: { bestScore: 'desc' },
        });

        await prisma.breakRoomHighScore.upsert({
          where: { userId_gameType: { userId: req.user.id, gameType: session.gameType } },
          create: {
            userId: req.user.id, agencyId: session.agencyId, officeId: session.officeId,
            gameType: session.gameType, bestScore: updated.score, bestMetrics: updated.metrics, sessionId: updated.id,
          },
          update: { bestScore: updated.score, bestMetrics: updated.metrics, sessionId: updated.id, agencyId: session.agencyId, officeId: session.officeId },
        });

        if (previousAgencyBest && previousAgencyBest.userId !== req.user.id && updated.score > previousAgencyBest.bestScore) {
          agencyRankOneChanged = previousAgencyBest.userId;
          const me = await prisma.user.findUnique({ where: { id: req.user.id }, select: { firstName: true, lastName: true } });
          notifyUser({
            userId: previousAgencyBest.userId,
            agencyId: session.agencyId,
            type: 'breakroom.score_beaten',
            severity: 'INFO',
            title: `${me.firstName} just took your #1 spot`,
            body: `${me.firstName} ${me.lastName} scored ${updated.score} in ${GAME_LABELS[session.gameType]}, passing your old best of ${previousAgencyBest.bestScore}.`,
            relatedEntityType: 'BreakRoomHighScore',
            relatedEntityId: session.gameType,
          }).catch((err) => console.error('[breakRoom] notify failed', err.message));
        }
      }

      achievementsUnlocked.push(...await checkAndUnlockAchievements(req.user.id, session.agencyId, session.gameType, updated, settings));
    }

    return res.json({
      success: true,
      session: { id: updated.id, score: updated.score, gameType: updated.gameType },
      newPersonalBest,
      flagged: check.flagged,
      achievementsUnlocked,
    });
  } catch (err) {
    next(err);
  }
});

const GAME_LABELS = { CONGO_LINE: 'Congo Line', BUCKETS: 'Buckets', FULL_SEND: 'Full Send', PILL_POP: 'Pill Pop' };

// Checks every achievement definition for this game against the
// session's own metrics/score and the user's lifetime totals, unlocking
// (idempotently, via the @@unique constraint) any newly-earned ones.
async function checkAndUnlockAchievements(userId, agencyId, gameType, session, settings) {
  if (!settings.achievementsEnabled) return [];
  const defs = ACHIEVEMENTS[gameType] || [];
  if (defs.length === 0) return [];

  const metrics = session.metrics || {};
  const earnedKeys = [];

  if (gameType === 'CONGO_LINE') {
    const dancers = Number(metrics.dancersCollected) || 0;
    if (dancers >= 10) earnedKeys.push('OFFICE_PARTY');
    if (dancers >= 25) earnedKeys.push('FIRE_MARSHAL_CALLED');
    if (dancers >= 50) earnedKeys.push('BIGGER_OFFICE');
  } else if (gameType === 'BUCKETS') {
    const streak = Number(metrics.bestStreak) || 0;
    if (streak >= 5) earnedKeys.push('HEATING_UP');
    if (streak >= 10) earnedKeys.push('CALL_THE_LEAGUE');
    if (streak >= 20) earnedKeys.push('CANT_MISS');
  } else if (gameType === 'FULL_SEND') {
    const tricks = Number(metrics.tricksLanded) || 0;
    const bestCombo = Number(metrics.bestComboCount) || 0;
    if (tricks >= 1) earnedKeys.push('SEND_IT');
    if (bestCombo >= 5) earnedKeys.push('HR_WOULD_HATE_THIS');
    if (metrics.crashed) earnedKeys.push('INSURANCE_CLAIM');
  } else if (gameType === 'PILL_POP') {
    const level = Number(metrics.level) || 0;
    if (level >= 1) earnedKeys.push('CLEAN_DESK');
    if (level >= 10) earnedKeys.push('MONDAY_KILLER');
    const priorSessions = await prisma.breakRoomGameSession.findMany({
      where: { userId, gameType: 'PILL_POP', status: 'COMPLETED' },
      select: { metrics: true },
    });
    const lifetimeBugs = priorSessions.reduce((sum, s) => sum + (Number(s.metrics && s.metrics.bugsCleared) || 0), 0) + (Number(metrics.bugsCleared) || 0);
    if (lifetimeBugs >= 100) earnedKeys.push('CRM_EXTERMINATOR');
  }

  if (earnedKeys.length === 0) return [];

  const existing = await prisma.breakRoomAchievement.findMany({
    where: { userId, gameType, key: { in: earnedKeys } },
    select: { key: true },
  });
  const existingKeys = new Set(existing.map((e) => e.key));
  const newKeys = earnedKeys.filter((k) => !existingKeys.has(k));
  if (newKeys.length === 0) return [];

  await prisma.$transaction(
    newKeys.map((key) => prisma.breakRoomAchievement.create({
      data: { userId, agencyId, gameType, key, sessionId: session.id },
    }))
  );

  return newKeys.map((key) => (defs.find((d) => d.key === key) || { key }));
}

// ---------------------------------------------------------------------
// Leaderboards — tenant-isolated by default. scope=global only ever
// returns cross-agency data when BreakRoomPlatformSettings.
// globalLeaderboardEnabled is true.
// ---------------------------------------------------------------------
const PERIOD_RANGES = {
  today: () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; },
  week: () => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 7); return d; },
  month: () => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 30); return d; },
  all: () => null,
};

router.get('/leaderboard', async (req, res, next) => {
  try {
    const gameType = req.query.gameType;
    if (!GAME_TYPES.includes(gameType)) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'A valid gameType is required.' });
    }
    const period = PERIOD_RANGES[req.query.period] ? req.query.period : 'all';
    const scope = ['office', 'agency', 'global'].includes(req.query.scope) ? req.query.scope : 'agency';

    const access = await canAccessBreakRoom(req.user);
    const agencyId = access.agencyId || req.user.agencyId;
    if (!agencyId && scope !== 'global') {
      return res.status(400).json({ success: false, error: 'NO_AGENCY' });
    }

    let where = { gameType, status: 'COMPLETED', excludedFromLeaderboard: false };
    if (scope === 'global') {
      const platformSettings = await prisma.breakRoomPlatformSettings.findUnique({ where: { id: 'singleton' } });
      if (!platformSettings || !platformSettings.globalLeaderboardEnabled) {
        return res.status(403).json({ success: false, error: 'GLOBAL_LEADERBOARD_DISABLED' });
      }
      // No further where-clause narrowing — intentionally cross-tenant,
      // and only reachable because the platform flag above is on.
    } else if (scope === 'office') {
      const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { officeId: true } });
      if (!user || !user.officeId) {
        return res.status(400).json({ success: false, error: 'NO_OFFICE' });
      }
      where = { ...where, officeId: user.officeId };
    } else {
      where = { ...where, agencyId };
    }

    const from = PERIOD_RANGES[period]();
    if (from) where = { ...where, createdAt: { gte: from } };

    // Best score per user within the window — Prisma can't do a windowed
    // "max per group then order" in one groupBy call with a join, so this
    // is a real, bounded raw aggregation over an indexed column set
    // (gameType, score) rather than pulling every session into Node.
    const topSessions = await prisma.breakRoomGameSession.groupBy({
      by: ['userId'],
      where,
      _max: { score: true },
      orderBy: { _max: { score: 'desc' } },
      take: 50,
    });

    const userIds = topSessions.map((r) => r.userId);
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } });
    const userById = new Map(users.map((u) => [u.id, u]));

    const rows = topSessions.map((r, i) => ({
      rank: i + 1,
      userId: r.userId,
      firstName: userById.get(r.userId)?.firstName || 'Former Employee',
      lastName: userById.get(r.userId)?.lastName || '',
      score: r._max.score,
    }));

    const myRow = rows.find((r) => r.userId === req.user.id);
    let myBest = myRow ? myRow.score : null;
    let myRank = myRow ? myRow.rank : null;
    if (!myRow) {
      const mine = await prisma.breakRoomGameSession.aggregate({ where: { ...where, userId: req.user.id }, _max: { score: true } });
      myBest = mine._max.score ?? null;
    }

    return res.json({ success: true, gameType, scope, period, rows, myBest, myRank });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Pick Me Up — jokes
// ---------------------------------------------------------------------
router.get('/jokes/random', async (req, res, next) => {
  try {
    const access = await canAccessBreakRoom(req.user);
    if (!access.allowed) {
      return res.status(403).json({ success: false, error: access.reason, message: reasonMessage(access.reason) });
    }
    if (!access.settings.pickMeUpEnabled) {
      return res.status(403).json({ success: false, error: 'FEATURE_DISABLED' });
    }

    const recentlyShown = await prisma.breakRoomJokeHistory.findMany({
      where: { userId: req.user.id },
      orderBy: { shownAt: 'desc' },
      take: 20,
      select: { jokeId: true },
    });
    const excludeIds = recentlyShown.map((r) => r.jokeId);

    let candidates = await prisma.breakRoomJoke.findMany({
      where: { active: true, id: { notIn: excludeIds } },
      select: { id: true, text: true, tags: true },
    });
    if (candidates.length === 0) {
      // Everything active has been seen recently — fall back to the
      // full active set rather than returning nothing.
      candidates = await prisma.breakRoomJoke.findMany({ where: { active: true }, select: { id: true, text: true, tags: true } });
    }
    if (candidates.length === 0) {
      return res.status(404).json({ success: false, error: 'NO_JOKES_AVAILABLE' });
    }

    const joke = candidates[Math.floor(Math.random() * candidates.length)];
    await prisma.breakRoomJokeHistory.create({ data: { userId: req.user.id, jokeId: joke.id } });

    return res.json({ success: true, joke: { id: joke.id, text: joke.text } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Achievements + stats profile
// ---------------------------------------------------------------------
router.get('/achievements', async (req, res, next) => {
  try {
    const unlocked = await prisma.breakRoomAchievement.findMany({
      where: { userId: req.user.id },
      select: { gameType: true, key: true, unlockedAt: true },
    });
    const unlockedSet = new Set(unlocked.map((u) => `${u.gameType}:${u.key}`));
    const catalog = Object.entries(ACHIEVEMENTS).flatMap(([gameType, defs]) => defs.map((d) => ({
      gameType,
      key: d.key,
      label: d.label,
      description: d.description,
      unlocked: unlockedSet.has(`${gameType}:${d.key}`),
      unlockedAt: unlocked.find((u) => u.gameType === gameType && u.key === d.key)?.unlockedAt || null,
    })));
    return res.json({ success: true, achievements: catalog });
  } catch (err) {
    next(err);
  }
});

router.get('/stats', async (req, res, next) => {
  try {
    const [sessions, achievementsCount, highScores] = await Promise.all([
      prisma.breakRoomGameSession.findMany({
        where: { userId: req.user.id, status: 'COMPLETED' },
        select: { gameType: true, durationMs: true },
      }),
      prisma.breakRoomAchievement.count({ where: { userId: req.user.id } }),
      prisma.breakRoomHighScore.findMany({ where: { userId: req.user.id } }),
    ]);

    const totalGames = sessions.length;
    const totalTimeMs = sessions.reduce((sum, s) => sum + (s.durationMs || 0), 0);
    const byGameCount = sessions.reduce((acc, s) => { acc[s.gameType] = (acc[s.gameType] || 0) + 1; return acc; }, {});
    const favoriteGame = Object.entries(byGameCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    let highestOfficeRank = null;
    let highestAgencyRank = null;
    for (const hs of highScores) {
      const agencyRank = await prisma.breakRoomHighScore.count({ where: { agencyId: hs.agencyId, gameType: hs.gameType, bestScore: { gt: hs.bestScore } } }) + 1;
      if (highestAgencyRank === null || agencyRank < highestAgencyRank) highestAgencyRank = agencyRank;
    }

    return res.json({
      success: true,
      stats: {
        totalGames,
        totalTimeMs,
        favoriteGame,
        achievements: achievementsCount,
        highestAgencyRank,
        highestOfficeRank,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Admin — Platform Owner only. Agency-level toggles live on the existing
// agencies.js entitlements/settings routes (breakRoomEnabled +
// breakRoomSettings), not here.
// ---------------------------------------------------------------------
router.get('/admin/sessions', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const where = {};
    if (req.query.flagged === 'true') where.excludedFromLeaderboard = true;
    if (req.query.gameType && GAME_TYPES.includes(req.query.gameType)) where.gameType = req.query.gameType;
    if (req.query.agencyId) where.agencyId = req.query.agencyId;

    const sessions = await prisma.breakRoomGameSession.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { firstName: true, lastName: true } }, agency: { select: { name: true } } },
    });
    return res.json({ success: true, sessions });
  } catch (err) {
    next(err);
  }
});

// Soft-invalidates a specific session (fraud/mistake) and recomputes that
// user's personal best for the game from their remaining valid sessions.
router.delete('/admin/sessions/:id', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const session = await prisma.breakRoomGameSession.findUnique({ where: { id: req.params.id } });
    if (!session) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    await prisma.breakRoomGameSession.update({
      where: { id: session.id },
      data: { excludedFromLeaderboard: true, flagReason: req.body?.reason || 'ADMIN_REMOVED' },
    });

    const remainingBest = await prisma.breakRoomGameSession.findFirst({
      where: { userId: session.userId, gameType: session.gameType, status: 'COMPLETED', excludedFromLeaderboard: false },
      orderBy: { score: 'desc' },
    });

    if (remainingBest) {
      await prisma.breakRoomHighScore.update({
        where: { userId_gameType: { userId: session.userId, gameType: session.gameType } },
        data: { bestScore: remainingBest.score, bestMetrics: remainingBest.metrics, sessionId: remainingBest.id },
      }).catch(() => {});
    } else {
      await prisma.breakRoomHighScore.deleteMany({ where: { userId: session.userId, gameType: session.gameType } });
    }

    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

const resetSchema = z.object({
  gameType: z.enum(GAME_TYPES),
  agencyId: z.string().uuid().optional(),
  officeId: z.string().uuid().optional(),
});

router.post('/admin/reset-leaderboard', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = resetSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const where = { gameType: parsed.data.gameType };
    if (parsed.data.agencyId) where.agencyId = parsed.data.agencyId;
    if (parsed.data.officeId) where.officeId = parsed.data.officeId;

    const [sessionsUpdated, highScoresRemoved] = await Promise.all([
      prisma.breakRoomGameSession.updateMany({ where, data: { excludedFromLeaderboard: true, flagReason: 'ADMIN_LEADERBOARD_RESET' } }),
      prisma.breakRoomHighScore.deleteMany({ where }),
    ]);

    return res.json({ success: true, sessionsExcluded: sessionsUpdated.count, highScoresRemoved: highScoresRemoved.count });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/platform-settings', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const settings = await prisma.breakRoomPlatformSettings.findUnique({ where: { id: 'singleton' } });
    return res.json({ success: true, settings: settings || { id: 'singleton', globalLeaderboardEnabled: false } });
  } catch (err) {
    next(err);
  }
});

router.patch('/admin/platform-settings', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = z.object({ globalLeaderboardEnabled: z.boolean() }).safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const settings = await prisma.breakRoomPlatformSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', globalLeaderboardEnabled: parsed.data.globalLeaderboardEnabled },
      update: { globalLeaderboardEnabled: parsed.data.globalLeaderboardEnabled },
    });
    return res.json({ success: true, settings });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
