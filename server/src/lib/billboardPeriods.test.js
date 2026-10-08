// Pure unit tests for the Billboard's fixed-calendar-period boundary
// resolution — no DB needed (agencyDataYearSpan is covered separately by
// a real-DB test alongside billboard.js's own suite, since it queries
// three real tables).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mostRecentCompletedWorkWeek, monthBoundsEastern, yearBoundsEastern, yearMonthBuckets } = require('./billboardPeriods');

const ET = 'America/New_York';

test('mostRecentCompletedWorkWeek: a Thursday input resolves to the prior completed Mon-Fri (the user\'s own worked example)', () => {
  const r = mostRecentCompletedWorkWeek(new Date('2026-10-08T15:00:00Z'), ET); // Thursday Oct 8
  assert.equal(r.label, 'Sep 28 – Oct 2, 2026');
  assert.equal(r.from.toISOString(), '2026-09-28T04:00:00.000Z');
  assert.equal(r.to.toISOString(), '2026-10-03T04:00:00.000Z');
  assert.equal(r.buckets.length, 5);
  assert.equal(r.buckets[0].label, 'Mon Sep 28');
  assert.equal(r.buckets[4].label, 'Fri Oct 2');
});

test('mostRecentCompletedWorkWeek: a Friday input still resolves to the PRIOR week (today\'s own Friday is not done yet)', () => {
  const r = mostRecentCompletedWorkWeek(new Date('2026-10-09T15:00:00Z'), ET); // Friday Oct 9
  assert.equal(r.label, 'Sep 28 – Oct 2, 2026');
});

test('mostRecentCompletedWorkWeek: a Monday input resolves to the week that just ended', () => {
  const r = mostRecentCompletedWorkWeek(new Date('2026-10-12T15:00:00Z'), ET); // Monday Oct 12
  assert.equal(r.label, 'Oct 5 – Oct 9, 2026');
  assert.equal(r.from.toISOString(), '2026-10-05T04:00:00.000Z');
  assert.equal(r.to.toISOString(), '2026-10-10T04:00:00.000Z');
});

test('mostRecentCompletedWorkWeek: a Saturday input flips to the week that just ended, the moment the weekend begins', () => {
  const r = mostRecentCompletedWorkWeek(new Date('2026-10-10T15:00:00Z'), ET); // Saturday Oct 10
  assert.equal(r.label, 'Oct 5 – Oct 9, 2026');
});

test('monthBoundsEastern: first-of-month to first-of-next-month, both DST-correct', () => {
  const march = monthBoundsEastern(2026, 3, ET);
  assert.equal(march.from.toISOString(), '2026-03-01T05:00:00.000Z');
  assert.equal(march.to.toISOString(), '2026-04-01T04:00:00.000Z');
  assert.equal(march.label, 'March 2026');
});

test('monthBoundsEastern: December rolls over into next January correctly', () => {
  const dec = monthBoundsEastern(2026, 12, ET);
  assert.equal(dec.to.toISOString(), '2027-01-01T05:00:00.000Z');
});

test('yearBoundsEastern + yearMonthBuckets: 12 independently correct month buckets', () => {
  const year = yearBoundsEastern(2026, ET);
  assert.equal(year.from.toISOString(), '2026-01-01T05:00:00.000Z');
  assert.equal(year.to.toISOString(), '2027-01-01T05:00:00.000Z');

  const buckets = yearMonthBuckets(2026, ET);
  assert.equal(buckets.length, 12);
  assert.equal(buckets[0].label, 'Jan');
  assert.equal(buckets[9].label, 'Oct');
  // March/April bucket boundary must show the real DST offset flip.
  assert.equal(buckets[2].to.toISOString(), buckets[3].from.toISOString());
  assert.equal(buckets[2].to.toISOString(), '2026-04-01T04:00:00.000Z');
});
