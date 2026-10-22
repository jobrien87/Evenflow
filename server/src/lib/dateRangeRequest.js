// Resolves a route's `?from=`/`?to=` query params (or the "this calendar
// month" default every one of these report routes already falls back to)
// into exact, timezone-correct UTC-midnight-of-calendar-date boundaries —
// in ONE shared place, so this doesn't keep getting independently
// reimplemented (and rebugged) per route. saleDate/recordDate are always
// stored as exact UTC midnight of their calendar date (see
// manualSaleAggregates.js's own comment), but a client-sent instant (e.g.
// a browser-local-midnight preset boundary) can land a few hours into the
// *next* UTC day in any US timezone — a raw instant compare then silently
// drops a sale logged on the very first day of the selected range. This
// is the same toCalendarUtcMidnight conversion manualSaleAggregates.js/
// historicalAggregates.js already apply internally when passed a
// timeZone, applied once here at the route boundary instead.
const { prisma } = require('./db');
const { zonedYearMonthDay } = require('./timezone');

function calendarUtcMidnight({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day));
}

// Returns { from, to, timeZone } — from/to are final, exact instants.
// Pass them straight into salesByAgent/salesByVendor/countSales/etc.
// WITHOUT also passing timeZone: these are already resolved, and
// re-deriving an already-exact UTC-midnight instant through a timezone a
// second time can shift it back a calendar day (that double-conversion
// is itself a bug, not a safety net) — timeZone is returned only for a
// caller that wants the agency's zone for something else.
async function resolveAgencyDateRange(req, agencyId) {
  let timeZone = 'America/New_York';
  if (agencyId) {
    const agency = await prisma.agency.findUnique({ where: { id: agencyId }, select: { timezone: true } });
    timeZone = agency?.timezone || timeZone;
  }

  const toInstant = req.query.to ? new Date(req.query.to) : new Date();
  const toYmd = zonedYearMonthDay(toInstant, timeZone);
  // Exclusive upper bound — the instant the day AFTER `to`'s own calendar
  // day starts, so `to` itself (meant as "through the end of that day")
  // never excludes a sale logged on it.
  const to = new Date(calendarUtcMidnight(toYmd).getTime() + 24 * 60 * 60 * 1000);

  let from;
  if (req.query.from) {
    from = calendarUtcMidnight(zonedYearMonthDay(new Date(req.query.from), timeZone));
  } else {
    // The 1st of the agency's own current Eastern calendar month —
    // computed directly from the agency's timezone, never from a UTC/
    // server-local Date's own getters and re-interpreted afterward (that
    // re-interpretation is itself the same backward-shift bug).
    from = calendarUtcMidnight({ year: toYmd.year, month: toYmd.month, day: 1 });
  }

  return { from, to, timeZone };
}

module.exports = { resolveAgencyDateRange };
