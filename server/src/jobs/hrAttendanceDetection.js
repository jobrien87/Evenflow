// Periodic job: scans for real TimeClockEntry-derived anomalies and
// creates HrAttendanceException candidate rows for human review. Never
// auto-classifies — every row it creates starts at status: 'OPEN'; only
// a human, via the review endpoint, can move it to a RESOLVED_* state.
// Registered via the same in-process setInterval convention this
// codebase already uses (leadPriorityRecompute.js, staleLeadReminders.js)
// — no new queue/cron infrastructure.
//
// Part B scope note: HrShiftAssignment (Part C) doesn't exist yet, so
// this job cannot compare against an expected schedule — it only
// detects what the raw clock data itself already reveals: a shift left
// open implausibly long, almost certainly a forgotten clock-out.
// LATE_ARRIVAL / EARLY_DEPARTURE / NO_CALL_NO_SHOW_CANDIDATE detection
// (which need a real expected-shift baseline to compare against) is
// deferred to once Part C's scheduling data exists — never guessed at
// here.
const { prisma } = require('../lib/db');
const { segmentsForEntry } = require('../lib/hrTimesheetBuilder');

async function detectMissedPunches({ now = new Date() } = {}) {
  const agencies = await prisma.agency.findMany({ where: { hrEnabled: true }, select: { id: true } });
  if (!agencies.length) return { created: 0 };

  let created = 0;
  for (const agency of agencies) {
    // eslint-disable-next-line no-await-in-loop
    const openEntries = await prisma.timeClockEntry.findMany({
      where: { agencyId: agency.id, clockOutAt: null },
      include: { user: { select: { id: true, hrEmployeeProfile: { select: { id: true } } } } },
    });

    for (const entry of openEntries) {
      const profile = entry.user?.hrEmployeeProfile;
      if (!profile) continue; // no HR profile for this user yet — nothing to attach the exception to

      const segs = segmentsForEntry(entry, now);
      const lastSeg = segs[segs.length - 1];
      if (!lastSeg.isException || lastSeg.exceptionReason !== 'STILL_OPEN_PAST_EXPECTED_SHIFT_LENGTH') continue;

      // eslint-disable-next-line no-await-in-loop
      const already = await prisma.hrAttendanceException.findFirst({
        where: { employeeProfileId: profile.id, exceptionType: 'MISSED_PUNCH', status: { in: ['OPEN', 'UNDER_REVIEW'] } },
        select: { id: true },
      });
      if (already) continue; // one live candidate per employee is enough until a human resolves it

      // eslint-disable-next-line no-await-in-loop
      await prisma.hrAttendanceException.create({
        data: { employeeProfileId: profile.id, agencyId: agency.id, exceptionType: 'MISSED_PUNCH', detectedAt: now },
      });
      created += 1;
    }
  }
  return { created };
}

let intervalHandle = null;
function startHrAttendanceDetectionJob(intervalMs = 30 * 60 * 1000) {
  if (intervalHandle) return intervalHandle;
  intervalHandle = setInterval(() => {
    detectMissedPunches().catch((err) => console.error('[hrAttendanceDetection] job failed:', err));
  }, intervalMs);
  if (intervalHandle.unref) intervalHandle.unref();
  return intervalHandle;
}

module.exports = { detectMissedPunches, startHrAttendanceDetectionJob };
