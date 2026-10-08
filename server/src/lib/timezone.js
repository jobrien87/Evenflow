// Minimal, dependency-free Eastern-time (or any IANA zone) calendar math,
// built on Node's built-in Intl/ICU rather than a date library — no
// timezone library exists anywhere in this codebase today, and the real
// need here is narrow (resolve a handful of calendar-boundary instants
// for one agency-configured zone), squarely inside what
// Intl.DateTimeFormat#formatToParts already does correctly. Every
// function here is pure and takes the zone as an explicit argument —
// nothing is hardcoded to Eastern time specifically, even though that's
// the one this app's agencies use today.

const PARTS_FORMAT_CACHE = new Map();

function partsFormatter(timeZone) {
  let fmt = PARTS_FORMAT_CACHE.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    PARTS_FORMAT_CACHE.set(timeZone, fmt);
  }
  return fmt;
}

// What calendar day/time a UTC instant falls on in `timeZone`, plus the
// weekday (0=Sun..6=Sat) of that calendar date — computed from the
// resolved Y-M-D via a UTC scratch date, since the day-of-week of a given
// calendar date is timezone-independent once you have the right Y-M-D.
function zonedPartsAt(utcDate, timeZone) {
  const parts = Object.fromEntries(
    partsFormatter(timeZone).formatToParts(utcDate).map((p) => [p.type, p.value])
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  // formatToParts renders midnight as "24:00" under hour12:false for some
  // ICU versions — normalize to 0 so hour stays in [0,23].
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, second, weekday };
}

// The UTC instant for local wall-clock midnight (00:00:00.000) on
// {year, month, day} in `timeZone`. Uses a "guess, read back what wall
// time that guess actually produced, correct by the delta" pass — the
// offset is derived fresh from Intl each call, never a hardcoded
// constant, so this is correct across a DST transition with no
// special-casing. Converges in one pass for any zone whose UTC offset
// never changes by more than 24h within a single correction step (true
// of every real-world zone); a second pass is run defensively anyway,
// since it's cheap and makes this robust for zones with unusual rules.
function zonedMidnightUtc(year, month, day, timeZone) {
  let guessMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  for (let i = 0; i < 2; i++) {
    const got = zonedPartsAt(new Date(guessMs), timeZone);
    const wantedMs = Date.UTC(year, month - 1, day, 0, 0, 0);
    const gotMs = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second);
    const deltaMs = wantedMs - gotMs;
    if (deltaMs === 0) break;
    guessMs += deltaMs;
  }
  return new Date(guessMs);
}

// Pure calendar-date arithmetic (no timezone math at all) — adds `n`
// whole calendar days to {year, month, day} via a UTC-noon scratch date
// (noon, not midnight, so the +/- day shift can never cross a UTC
// calendar-day boundary on its own). Used to walk whole days (e.g.
// Monday -> Friday) without ever doing timezone-aware "+24h" arithmetic,
// which is exactly the bug class that breaks across a DST transition.
function addZonedCalendarDays(year, month, day, n) {
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + n);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// What Eastern (or any zone's) calendar day/month/year/weekday `now`
// falls on — the read side of zonedMidnightUtc's write side.
function zonedYearMonthDay(utcDate, timeZone) {
  const { year, month, day, weekday } = zonedPartsAt(utcDate, timeZone);
  return { year, month, day, weekday };
}

module.exports = { zonedPartsAt, zonedMidnightUtc, addZonedCalendarDays, zonedYearMonthDay };
