// Single source of truth for "what is this person's clock/break/lunch
// state right now" — shared by routes/timeClock.js (the real clock
// actions) and lib/breakRoom.js (the Break Room gate), so there is
// exactly one place this logic lives, never two copies that could drift.

function openEntryWhere(userId) {
  return { userId, clockOutAt: null };
}

function stateOf(entry) {
  if (!entry || entry.clockOutAt) return 'CLOCKED_OUT';
  if (entry.lunchStartAt && !entry.lunchEndAt) return 'ON_LUNCH';
  if (entry.breakStartAt && !entry.breakEndAt) return 'ON_BREAK';
  return 'CLOCKED_IN';
}

module.exports = { openEntryWhere, stateOf };
