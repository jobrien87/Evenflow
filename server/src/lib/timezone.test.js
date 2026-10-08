// Pure unit tests for the Eastern-time calendar math underneath the
// Billboard period rework — no DB needed. The DST-boundary cases are the
// ones that actually exercise correctness: a naive fixed-offset
// implementation would get these wrong.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { zonedMidnightUtc, zonedYearMonthDay, addZonedCalendarDays } = require('./timezone');

const ET = 'America/New_York';

test('zonedMidnightUtc: a plain EDT date (October)', () => {
  assert.equal(zonedMidnightUtc(2026, 10, 1, ET).toISOString(), '2026-10-01T04:00:00.000Z');
});

test('zonedMidnightUtc: spring-forward boundary (March -> April 2026)', () => {
  // EST (UTC-5) on March 1, EDT (UTC-4) on April 1 — the offset must
  // differ by exactly one hour between the two calls, derived fresh from
  // Intl each time rather than a hardcoded constant.
  assert.equal(zonedMidnightUtc(2026, 3, 1, ET).toISOString(), '2026-03-01T05:00:00.000Z');
  assert.equal(zonedMidnightUtc(2026, 4, 1, ET).toISOString(), '2026-04-01T04:00:00.000Z');
});

test('zonedMidnightUtc: fall-back boundary (November -> December 2026)', () => {
  // Nov 1 is still EDT (fallback happens later that same day); Dec 1 is EST.
  assert.equal(zonedMidnightUtc(2026, 11, 1, ET).toISOString(), '2026-11-01T04:00:00.000Z');
  assert.equal(zonedMidnightUtc(2026, 12, 1, ET).toISOString(), '2026-12-01T05:00:00.000Z');
});

test('zonedYearMonthDay: resolves the correct Eastern calendar date and weekday from a UTC instant', () => {
  // 2026-10-08T15:00:00Z is 11:00 EDT on a Thursday.
  const r = zonedYearMonthDay(new Date('2026-10-08T15:00:00Z'), ET);
  assert.deepEqual(r, { year: 2026, month: 10, day: 8, weekday: 4 });
});

test('zonedYearMonthDay: a UTC instant that falls on the PREVIOUS Eastern calendar day', () => {
  // 2026-10-08T02:00:00Z is 2026-10-07T22:00:00 EDT — still Wednesday in Eastern time.
  const r = zonedYearMonthDay(new Date('2026-10-08T02:00:00Z'), ET);
  assert.deepEqual(r, { year: 2026, month: 10, day: 7, weekday: 3 });
});

test('addZonedCalendarDays: pure calendar arithmetic, including a month/year rollover', () => {
  assert.deepEqual(addZonedCalendarDays(2026, 3, 1, -1), { year: 2026, month: 2, day: 28 });
  assert.deepEqual(addZonedCalendarDays(2026, 12, 31, 1), { year: 2027, month: 1, day: 1 });
  assert.deepEqual(addZonedCalendarDays(2026, 10, 5, 4), { year: 2026, month: 10, day: 9 });
});
