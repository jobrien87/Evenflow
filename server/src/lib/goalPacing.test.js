const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeGoalPace, countWorkingDays } = require('./goalPacing');

const TZ = 'America/New_York';

test('countWorkingDays counts only Mon-Fri, inclusive of both ends', () => {
  // Mon Oct 5, 2026 - Fri Oct 9, 2026 (a plain 5-weekday work week, all noon UTC to dodge any DST edge).
  const mon = new Date('2026-10-05T12:00:00Z');
  const fri = new Date('2026-10-09T12:00:00Z');
  assert.equal(countWorkingDays(mon, fri, TZ), 5);

  // Sat Oct 10 - Sun Oct 11, 2026: zero working days in a pure weekend span.
  const sat = new Date('2026-10-10T12:00:00Z');
  const sun = new Date('2026-10-11T12:00:00Z');
  assert.equal(countWorkingDays(sat, sun, TZ), 0);

  // Fri Oct 9 - Mon Oct 12, 2026: spans the weekend, only the two weekdays count.
  assert.equal(countWorkingDays(fri, new Date('2026-10-12T12:00:00Z'), TZ), 2);
});

test('computeGoalPace returns null without a real target or actual', () => {
  const periodStart = new Date('2026-10-01T04:00:00Z');
  const periodEnd = new Date('2026-10-31T04:00:00Z');
  assert.equal(computeGoalPace({ periodStart, periodEnd, targetValue: 0, actual: 5, now: new Date(), timeZone: TZ }), null);
  assert.equal(computeGoalPace({ periodStart, periodEnd, targetValue: 10, actual: null, now: new Date(), timeZone: TZ }), null);
});

test('computeGoalPace projects ahead-of-pace correctly for a mid-month check', () => {
  // October 2026: Oct 1 is a Thursday. Check "now" on Thu Oct 8 (one full
  // workweek + the first day of the second elapsed) — 6 working days
  // elapsed (Thu/Fri wk1 + Mon-Thu wk2), 22 working days in the full month.
  const periodStart = new Date('2026-10-01T04:00:00Z'); // midnight Eastern Oct 1
  const periodEnd = new Date('2026-11-01T03:59:59Z'); // just before midnight Eastern Nov 1
  const now = new Date('2026-10-08T15:00:00Z'); // mid-day Thu Oct 8 Eastern
  const pace = computeGoalPace({ periodStart, periodEnd, targetValue: 44, actual: 12, now, timeZone: TZ });

  assert.ok(pace);
  assert.equal(pace.workingDaysElapsed, 6);
  assert.equal(pace.workingDaysTotal, 22);
  assert.equal(pace.dailyRate, 2); // 12 actual / 6 working days
  assert.equal(pace.projectedValue, 44); // 2/day * 22 working days
  assert.equal(pace.projectedPercent, 100);
  assert.equal(pace.onPace, true);
});

test('computeGoalPace flags a behind-pace goal and a zero-production goal honestly', () => {
  const periodStart = new Date('2026-10-01T04:00:00Z');
  const periodEnd = new Date('2026-11-01T03:59:59Z');
  const now = new Date('2026-10-08T15:00:00Z');

  const behind = computeGoalPace({ periodStart, periodEnd, targetValue: 100, actual: 3, now, timeZone: TZ });
  assert.equal(behind.onPace, false);
  assert.ok(behind.projectedPercent < 100);

  const zero = computeGoalPace({ periodStart, periodEnd, targetValue: 100, actual: 0, now, timeZone: TZ });
  assert.equal(zero.dailyRate, 0);
  assert.equal(zero.projectedFinishWorkingDay, null);
  assert.equal(zero.onPace, false);
});

test('computeGoalPace reports no projection before any working day has elapsed', () => {
  // "now" before the period even starts (defensive — periodStart/now should
  // never actually invert in real use, but this must never throw or loop).
  const periodStart = new Date('2026-10-05T04:00:00Z');
  const periodEnd = new Date('2026-10-09T04:00:00Z');
  const now = new Date('2026-10-01T04:00:00Z');
  const pace = computeGoalPace({ periodStart, periodEnd, targetValue: 10, actual: 2, now, timeZone: TZ });
  assert.equal(pace.workingDaysElapsed, 0);
  assert.equal(pace.dailyRate, null);
  assert.equal(pace.projectedValue, 2);
});
