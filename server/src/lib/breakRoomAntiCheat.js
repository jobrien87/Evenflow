// Lightweight plausibility checks on a submitted Break Room score — not
// esports-grade anti-cheat, just enough to stop an obviously-impossible
// number from landing on a leaderboard. A session that fails a HARD
// check is rejected outright (400, nothing stored as a valid score); one
// that only trips a SOFT check is still stored but excluded from
// leaderboards/high-scores for a human to review later.

// Generous-but-bounded per-game ceilings. These are real theoretical
// maximums for each game's own scoring rules (see each game's scoring
// doc in client/src/breakRoom/games/<game>/scoring.js), padded for a
// genuinely excellent run — not a tight competitive bound.
const LIMITS = {
  CONGO_LINE: { maxScorePerSecond: 400, maxScore: 400000, minDurationMs: 2000 },
  BUCKETS: { maxScorePerSecond: 150, maxScore: 60000, minDurationMs: 2000 },
  FULL_SEND: { maxScorePerSecond: 600, maxScore: 150000, minDurationMs: 2000 },
  PILL_POP: { maxScorePerSecond: 250, maxScore: 200000, minDurationMs: 2000 },
};

const MAX_DURATION_MS = 20 * 60 * 1000; // no single session outlasts a realistic break

function validateScore(gameType, { score, metrics, durationMs }) {
  const limits = LIMITS[gameType];
  if (!limits) return { valid: false, flagged: false, reason: 'UNKNOWN_GAME_TYPE' };

  if (!Number.isInteger(score) || score < 0) {
    return { valid: false, flagged: false, reason: 'INVALID_SCORE' };
  }
  if (!Number.isInteger(durationMs) || durationMs < limits.minDurationMs) {
    return { valid: false, flagged: false, reason: 'DURATION_TOO_SHORT' };
  }
  if (durationMs > MAX_DURATION_MS) {
    return { valid: false, flagged: false, reason: 'DURATION_TOO_LONG' };
  }
  if (score > limits.maxScore) {
    return { valid: false, flagged: true, reason: 'SCORE_EXCEEDS_MAX' };
  }

  const scorePerSecond = score / (durationMs / 1000);
  if (scorePerSecond > limits.maxScorePerSecond * 3) {
    return { valid: false, flagged: true, reason: 'IMPLAUSIBLE_RATE' };
  }
  if (scorePerSecond > limits.maxScorePerSecond) {
    return { valid: true, flagged: true, reason: 'HIGH_RATE_REVIEW' };
  }

  const gameCheck = GAME_SPECIFIC_CHECKS[gameType];
  if (gameCheck) {
    const result = gameCheck(score, metrics || {}, durationMs);
    if (result) return result;
  }

  return { valid: true, flagged: false, reason: null };
}

const GAME_SPECIFIC_CHECKS = {
  CONGO_LINE(score, metrics) {
    const dancers = Number(metrics.dancersCollected) || 0;
    if (dancers < 0 || dancers > 500) return { valid: false, flagged: true, reason: 'IMPLAUSIBLE_METRIC' };
    // Minimum real points per dancer is 100 — a score far below that
    // floor for the claimed dancer count is internally inconsistent.
    if (dancers > 0 && score < dancers * 50) return { valid: true, flagged: true, reason: 'METRIC_SCORE_MISMATCH' };
    return null;
  },
  BUCKETS(score, metrics) {
    const made = Number(metrics.shotsMade) || 0;
    const attempted = Number(metrics.shotsAttempted) || 0;
    if (made > attempted) return { valid: false, flagged: true, reason: 'IMPLAUSIBLE_METRIC' };
    if (attempted > 200) return { valid: false, flagged: true, reason: 'IMPLAUSIBLE_METRIC' };
    return null;
  },
  FULL_SEND(score, metrics) {
    const tricks = Number(metrics.tricksLanded) || 0;
    if (tricks < 0 || tricks > 300) return { valid: false, flagged: true, reason: 'IMPLAUSIBLE_METRIC' };
    return null;
  },
  PILL_POP(score, metrics) {
    const level = Number(metrics.level) || 0;
    if (level < 0 || level > 60) return { valid: false, flagged: true, reason: 'IMPLAUSIBLE_METRIC' };
    return null;
  },
};

module.exports = { validateScore, LIMITS };
