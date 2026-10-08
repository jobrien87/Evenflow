// Backstage HR — Phase 1 Part C pure scheduling helpers: resolving a
// shift template's "HH:MM" wall-clock time (in an employee's own work
// time zone) to a real UTC instant, and the plain overlap checks the
// scheduling routes use for the leave-conflict and weekly-overtime
// warnings. Nothing here touches the database — same split as Part B's
// lib/hrTimesheetBuilder.js (pure derivation) vs. routes/hr/
// timeAttendance.js (the database-touching route layer).
const { zonedPartsAt } = require('./timezone');

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseHHMM(value) {
  const match = HHMM_RE.exec(String(value || ''));
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

// The UTC instant for wall-clock {year, month, day, hour, minute} in
// `timeZone` — the same "guess, read back what wall time that guess
// actually produced, correct by the delta" convergence lib/timezone.js's
// own zonedMidnightUtc uses, generalized to an arbitrary time of day so
// it stays correct across a DST transition instead of doing naive
// "midnight + N minutes" arithmetic.
function zonedWallClockUtc(year, month, day, hour, minute, timeZone) {
  let guessMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 2; i += 1) {
    const got = zonedPartsAt(new Date(guessMs), timeZone);
    const wantedMs = Date.UTC(year, month - 1, day, hour, minute, 0);
    const gotMs = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second);
    const deltaMs = wantedMs - gotMs;
    if (deltaMs === 0) break;
    guessMs += deltaMs;
  }
  return new Date(guessMs);
}

// Resolves a shift's {startAt, endAt} UTC instants from a date-only
// workDate plus "HH:MM" start/end strings, in the given work time zone.
// An end time at or before the start time is treated as crossing
// midnight (an overnight shift) — endAt lands on the next calendar day,
// never before startAt.
function resolveShiftInstants({ workDate, startTime, endTime, timeZone = 'America/New_York' }) {
  const start = parseHHMM(startTime);
  const end = parseHHMM(endTime);
  if (!start || !end) return null;

  const year = workDate.getUTCFullYear();
  const month = workDate.getUTCMonth() + 1;
  const day = workDate.getUTCDate();

  const startAt = zonedWallClockUtc(year, month, day, start.hour, start.minute, timeZone);
  let endAt = zonedWallClockUtc(year, month, day, end.hour, end.minute, timeZone);
  if (endAt <= startAt) {
    // Overnight: re-resolve against the next calendar day.
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    endAt = zonedWallClockUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), end.hour, end.minute, timeZone);
  }
  return { startAt, endAt };
}

// Date-only (calendar day) overlap between a shift's workDate and a
// leave request's [startDate, endDate] range — inclusive on both ends,
// since HrLeaveRequest.startDate/endDate are whole calendar days.
function workDateOverlapsLeave(workDate, leaveRequest) {
  const day = Date.UTC(workDate.getUTCFullYear(), workDate.getUTCMonth(), workDate.getUTCDate());
  const start = Date.UTC(leaveRequest.startDate.getUTCFullYear(), leaveRequest.startDate.getUTCMonth(), leaveRequest.startDate.getUTCDate());
  const end = Date.UTC(leaveRequest.endDate.getUTCFullYear(), leaveRequest.endDate.getUTCMonth(), leaveRequest.endDate.getUTCDate());
  return day >= start && day <= end;
}

// Monday-anchored ISO week [start, end) containing `date`, in plain UTC
// calendar terms (the same "whole calendar days" scope workDate already
// uses) — used only for the weekly-overtime scheduling heads-up, never a
// jurisdiction-aware payroll calculation.
function isoWeekRange(date) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay(); // 0=Sun..6=Sat
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  const start = new Date(day);
  start.setUTCDate(start.getUTCDate() + mondayOffset);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { start, end };
}

// The inverse of resolveShiftInstants' time component: what "HH:MM" wall
// clock a UTC instant reads as in `timeZone` — used when only one side
// of an existing shift (e.g. just workDate) is being changed, so the
// other side's real local time is preserved instead of being
// misread as a UTC hour/minute.
function wallClockHHMM(utcDate, timeZone) {
  const parts = zonedPartsAt(utcDate, timeZone);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

module.exports = { parseHHMM, zonedWallClockUtc, resolveShiftInstants, workDateOverlapsLeave, isoWeekRange, wallClockHHMM };
