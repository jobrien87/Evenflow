// Pure "on pace for" projection math for Goals. Counts only Monday-Friday
// working days, resolved in a given IANA timezone via timezone.js's zoned
// calendar-day math — a goal's real work happens on business days, and
// counting weekends as progress-days would understate how far behind or
// ahead the team actually is. That one assumption is the whole basis of
// every number this module returns, which is why the caller surfaces it
// in the UI rather than leaving it implicit.
const { zonedMidnightUtc, zonedYearMonthDay, addZonedCalendarDays } = require('./timezone');

function isWorkingDay(year, month, day, timeZone) {
  const instant = zonedMidnightUtc(year, month, day, timeZone);
  const { weekday } = zonedYearMonthDay(instant, timeZone);
  return weekday >= 1 && weekday <= 5;
}

// Inclusive Mon-Fri day count between two UTC instants, resolved to
// calendar dates in `timeZone`. Bounded by the real elapsed calendar days
// between the two instants (capped defensively at ~10 years) — never an
// unbounded loop for any real goal period.
function countWorkingDays(fromUtc, toUtc, timeZone) {
  if (toUtc < fromUtc) return 0;
  let { year, month, day } = zonedYearMonthDay(fromUtc, timeZone);
  const endParts = zonedYearMonthDay(toUtc, timeZone);
  const endInstant = zonedMidnightUtc(endParts.year, endParts.month, endParts.day, timeZone);

  let count = 0;
  for (let safety = 0; safety < 3660; safety++) {
    if (isWorkingDay(year, month, day, timeZone)) count++;
    const cursorInstant = zonedMidnightUtc(year, month, day, timeZone);
    if (cursorInstant.getTime() >= endInstant.getTime()) break;
    const next = addZonedCalendarDays(year, month, day, 1);
    year = next.year;
    month = next.month;
    day = next.day;
  }
  return count;
}

// Projects, at the per-working-day rate observed so far, what the final
// value would be if that rate held for the rest of the period, and which
// working day of the period the target would be reached on at that rate
// (which may land before, on, or after the period's own last working day).
// Returns null only when there isn't enough information to project
// anything (no target, or the metric itself returned null) — never a
// fabricated number.
function computeGoalPace({ periodStart, periodEnd, targetValue, actual, now, timeZone = 'America/New_York' }) {
  if (actual == null || !targetValue || targetValue <= 0) return null;

  const start = new Date(periodStart);
  const end = new Date(periodEnd);
  const asOf = now < end ? now : end; // never project using time past the period's own end

  const workingDaysElapsed = countWorkingDays(start, asOf, timeZone);
  const workingDaysTotal = countWorkingDays(start, end, timeZone);
  const projectedPercent = (value) => Math.round((value / targetValue) * 1000) / 10;

  if (workingDaysElapsed <= 0) {
    return {
      timeZone,
      workingDaysElapsed,
      workingDaysTotal,
      dailyRate: null,
      projectedValue: actual,
      projectedPercent: projectedPercent(actual),
      projectedFinishWorkingDay: null,
      onPace: null,
    };
  }

  const dailyRate = actual / workingDaysElapsed;
  const projectedValue = Math.round(dailyRate * workingDaysTotal);
  const projectedFinishWorkingDay = dailyRate > 0 ? Math.ceil(targetValue / dailyRate) : null;

  return {
    timeZone,
    workingDaysElapsed,
    workingDaysTotal,
    dailyRate,
    projectedValue,
    projectedPercent: projectedPercent(projectedValue),
    projectedFinishWorkingDay,
    // true = projected to reach target by the period's last working day; false = projected to fall short; null = at zero pace, will never reach it.
    onPace: projectedFinishWorkingDay == null ? false : projectedFinishWorkingDay <= workingDaysTotal,
  };
}

module.exports = { computeGoalPace, countWorkingDays, isWorkingDay };
