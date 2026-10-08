// Fixed-calendar-period boundary resolution for the Billboard's Week/
// Month/Year/All Years views — distinct from billboard.js's own
// GRANULARITIES (day/week/month/year rolling-lookback buckets), which
// stay completely unchanged. Every boundary here is computed in the
// agency's own Eastern (or whatever IANA zone it's configured with)
// calendar, via server/src/lib/timezone.js — never raw UTC.
const { prisma } = require('./db');
const { zonedMidnightUtc, addZonedCalendarDays, zonedYearMonthDay } = require('./timezone');

const PERIODS = ['week', 'month', 'year', 'all_years'];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LABELS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function formatShortDate(year, month, day) {
  return `${MONTH_LABELS[month - 1]} ${day}`;
}

// The most recently COMPLETED Monday-Friday business week, as of `nowUtc`
// in `timeZone` — not a rolling trailing-7-days window, not a calendar
// Sun-Sat week. If today (in-zone) is Mon-Fri, that week isn't finished
// yet, so the PRIOR Mon-Fri is returned; if today is Sat/Sun, the week
// that just ended is the one returned. `to` is the exclusive start of the
// following Saturday (zero millisecond-boundary ambiguity). Also returns
// 5 explicit daily buckets (Mon-Fri) for the trend chart's hoverable dots.
function mostRecentCompletedWorkWeek(nowUtc, timeZone) {
  const { year, month, day, weekday } = zonedYearMonthDay(nowUtc, timeZone);
  // Monday-start offset: Mon=0 ... Sun=6 (weekday itself is Sun=0..Sat=6).
  const mondayOffset = (weekday + 6) % 7;
  const isWeekendToday = mondayOffset >= 5; // today is Sat(5) or Sun(6) in Mon-start numbering
  const backShift = isWeekendToday ? 0 : 7;

  const monday = addZonedCalendarDays(year, month, day, -mondayOffset - backShift);
  const friday = addZonedCalendarDays(monday.year, monday.month, monday.day, 4);
  const saturdayAfter = addZonedCalendarDays(friday.year, friday.month, friday.day, 1);

  const from = zonedMidnightUtc(monday.year, monday.month, monday.day, timeZone);
  const to = zonedMidnightUtc(saturdayAfter.year, saturdayAfter.month, saturdayAfter.day, timeZone);

  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const buckets = [];
  let cursor = monday;
  for (let i = 0; i < 5; i++) {
    const next = addZonedCalendarDays(cursor.year, cursor.month, cursor.day, 1);
    buckets.push({
      key: `${cursor.year}-${String(cursor.month).padStart(2, '0')}-${String(cursor.day).padStart(2, '0')}`,
      label: `${dayLabels[i]} ${formatShortDate(cursor.year, cursor.month, cursor.day)}`,
      from: zonedMidnightUtc(cursor.year, cursor.month, cursor.day, timeZone),
      to: zonedMidnightUtc(next.year, next.month, next.day, timeZone),
    });
    cursor = next;
  }

  const sameYear = monday.year === friday.year;
  const label = sameYear
    ? `${formatShortDate(monday.year, monday.month, monday.day)} – ${formatShortDate(friday.year, friday.month, friday.day)}, ${friday.year}`
    : `${formatShortDate(monday.year, monday.month, monday.day)}, ${monday.year} – ${formatShortDate(friday.year, friday.month, friday.day)}, ${friday.year}`;

  return { from, to, label, buckets };
}

// First-of-month to first-of-next-month (exclusive), both resolved
// Eastern-correct. No sub-bucketed series — Month view shows only that
// month's own total, per the explicit "show only that month's premium
// total" requirement.
function monthBoundsEastern(year, month, timeZone) {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const from = zonedMidnightUtc(year, month, 1, timeZone);
  const to = zonedMidnightUtc(nextYear, nextMonth, 1, timeZone);
  const label = `${MONTH_LABELS_LONG[month - 1]} ${year}`;
  return { from, to, label };
}

// A full calendar year's Eastern bounds, Jan 1 - Dec 31 (next Jan 1 exclusive).
function yearBoundsEastern(year, timeZone) {
  const from = zonedMidnightUtc(year, 1, 1, timeZone);
  const to = zonedMidnightUtc(year + 1, 1, 1, timeZone);
  return { from, to, label: String(year) };
}

// 12 independently DST-correct month buckets for a calendar year — each
// just delegates to monthBoundsEastern, so there's no "+1 month" rolling
// arithmetic anywhere in this file.
function yearMonthBuckets(year, timeZone) {
  const buckets = [];
  for (let m = 1; m <= 12; m++) {
    const { from, to } = monthBoundsEastern(year, m, timeZone);
    buckets.push({ key: `${year}-${String(m).padStart(2, '0')}`, label: MONTH_LABELS[m - 1], from, to });
  }
  return buckets;
}

// The inclusive range of Eastern calendar years actually present in the
// agency's real sold data (real Lead + HistoricalRecord + Sale), via
// three cheap parallel min/max aggregates — never a raw DISTINCT-year
// scan. Returns null when the agency has no sold data anywhere yet.
async function agencyDataYearSpan({ agencyId, timeZone }) {
  const [leadSpan, historicalSpan, saleSpan] = await Promise.all([
    prisma.lead.aggregate({
      where: { agencyId, status: 'SOLD', salePremiumCents: { gt: 0 } },
      _min: { updatedAt: true },
      _max: { updatedAt: true },
    }),
    prisma.historicalRecord.aggregate({
      where: { agencyId, isSold: true, premiumCents: { gt: 0 } },
      _min: { recordDate: true },
      _max: { recordDate: true },
    }),
    prisma.sale.aggregate({
      where: { agencyId, voidedAt: null },
      _min: { saleDate: true },
      _max: { saleDate: true },
    }),
  ]);

  const dates = [
    leadSpan._min.updatedAt, leadSpan._max.updatedAt,
    historicalSpan._min.recordDate, historicalSpan._max.recordDate,
    saleSpan._min.saleDate, saleSpan._max.saleDate,
  ].filter(Boolean);
  if (dates.length === 0) return null;

  let minYear = Infinity;
  let maxYear = -Infinity;
  for (const d of dates) {
    const { year } = zonedYearMonthDay(d, timeZone);
    if (year < minYear) minYear = year;
    if (year > maxYear) maxYear = year;
  }
  return { minYear, maxYear };
}

module.exports = {
  PERIODS,
  mostRecentCompletedWorkWeek,
  monthBoundsEastern,
  yearBoundsEastern,
  yearMonthBuckets,
  agencyDataYearSpan,
};
