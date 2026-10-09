// HR Time & Attendance routes — a read-only consumer of TimeClockEntry
// (via lib/hrTimesheetBuilder.js) plus the derived HrTimesheet/
// HrAttendanceException tables. Nothing here ever writes to
// TimeClockEntry.
const express = require('express');
const { z } = require('zod');
const { prisma } = require('../../lib/db');
const { recordAudit } = require('../../lib/audit');
const { requireHrRole } = require('../../middleware/hrAuth');
const { computeAndStoreTimesheet } = require('../../lib/hrTimesheetBuilder');
const { stateOf } = require('../../lib/timeClockState');

const router = express.Router();

// Live status — who's clocked in / on lunch / on break right now, for
// every employee who has an HR profile in this agency. A thin,
// read-only re-presentation of the same TimeClockEntry data
// GET /timeclock/status already reads, scoped to HR visibility and
// enriched with department/position.
router.get('/attendance/live', requireHrRole('HR_ADMIN', 'HR_AUDITOR'), async (req, res, next) => {
  try {
    const agencyId = req.hrAgencyId;
    const [employees, openEntries] = await Promise.all([
      prisma.hrEmployeeProfile.findMany({
        where: { agencyId, user: { status: 'ACTIVE' } },
        select: {
          id: true, userId: true,
          user: { select: { id: true, firstName: true, lastName: true } },
          department: { select: { id: true, name: true } },
          position: { select: { id: true, title: true } },
        },
      }),
      prisma.timeClockEntry.findMany({
        where: { agencyId, clockOutAt: null },
        select: { userId: true, clockInAt: true, lunchStartAt: true, lunchEndAt: true, breakStartAt: true, breakEndAt: true },
      }),
    ]);
    const openByUserId = new Map(openEntries.map((e) => [e.userId, e]));
    const live = employees.map((e) => {
      const entry = openByUserId.get(e.userId) || null;
      return {
        employeeProfileId: e.id,
        userId: e.userId,
        firstName: e.user.firstName,
        lastName: e.user.lastName,
        department: e.department,
        position: e.position,
        state: stateOf(entry),
        clockInAt: entry?.clockInAt || null,
      };
    });
    return res.json({ success: true, live });
  } catch (err) {
    next(err);
  }
});

const computeSchema = z.object({
  employeeProfileId: z.string().uuid(),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
});

async function loadScopedEmployee(employeeProfileId, agencyId) {
  const employee = await prisma.hrEmployeeProfile.findUnique({ where: { id: employeeProfileId } });
  if (!employee || employee.agencyId !== agencyId) return null;
  return employee;
}

// Computes (or recomputes, unless already APPROVED) a timesheet for one
// employee/period, then returns it with its segments. HR_ADMIN only —
// this is a write (derived data, but still a write).
router.post('/timesheets/compute', requireHrRole('HR_ADMIN'), async (req, res, next) => {
  try {
    const parsed = computeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const employee = await loadScopedEmployee(parsed.data.employeeProfileId, req.hrAgencyId);
    if (!employee) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const timesheet = await computeAndStoreTimesheet({
      employeeProfileId: employee.id, userId: employee.userId, agencyId: req.hrAgencyId,
      periodStart: parsed.data.periodStart, periodEnd: parsed.data.periodEnd,
    });
    const segments = await prisma.hrTimesheetSegment.findMany({ where: { timesheetId: timesheet.id }, orderBy: { startedAt: 'asc' } });
    return res.json({ success: true, timesheet: { ...timesheet, segments } });
  } catch (err) {
    next(err);
  }
});

// List already-computed timesheets for the agency (optionally filtered
// to one employee) — never triggers a compute itself.
router.get('/timesheets', requireHrRole('HR_ADMIN', 'HR_AUDITOR'), async (req, res, next) => {
  try {
    const where = { agencyId: req.hrAgencyId };
    if (req.query.employeeProfileId) where.employeeProfileId = req.query.employeeProfileId;
    const timesheets = await prisma.hrTimesheet.findMany({
      where,
      include: { employeeProfile: { include: { user: { select: { firstName: true, lastName: true } } } } },
      orderBy: { periodStart: 'desc' },
      take: 100,
    });
    return res.json({ success: true, timesheets });
  } catch (err) {
    next(err);
  }
});

// Self-service — the signed-in user's own timesheets, no HR role
// required. Registered before /timesheets/:id so "mine" is never
// captured as an :id param.
router.get('/timesheets/mine', async (req, res, next) => {
  try {
    const profile = await prisma.hrEmployeeProfile.findUnique({ where: { userId: req.user.id } });
    if (!profile) return res.json({ success: true, timesheets: [] });
    const timesheets = await prisma.hrTimesheet.findMany({
      where: { employeeProfileId: profile.id },
      orderBy: { periodStart: 'desc' },
      take: 26,
    });
    return res.json({ success: true, timesheets });
  } catch (err) {
    next(err);
  }
});

router.get('/timesheets/:id', requireHrRole('HR_ADMIN', 'HR_AUDITOR'), async (req, res, next) => {
  try {
    const timesheet = await prisma.hrTimesheet.findUnique({
      where: { id: req.params.id },
      include: { segments: { orderBy: { startedAt: 'asc' } }, employeeProfile: { include: { user: { select: { firstName: true, lastName: true } } } } },
    });
    if (!timesheet || timesheet.agencyId !== req.hrAgencyId) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    return res.json({ success: true, timesheet });
  } catch (err) {
    next(err);
  }
});

// The employee themself submits their own timesheet — not an HR-role
// action, but still agency-scoped and ownership-checked.
router.post('/timesheets/:id/submit', async (req, res, next) => {
  try {
    const timesheet = await prisma.hrTimesheet.findUnique({ where: { id: req.params.id }, include: { employeeProfile: true } });
    if (!timesheet) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (timesheet.employeeProfile.userId !== req.user.id) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    if (timesheet.status !== 'OPEN') {
      return res.status(409).json({ success: false, error: 'INVALID_STATUS', message: `Cannot submit a timesheet in ${timesheet.status} status.` });
    }
    const updated = await prisma.hrTimesheet.update({ where: { id: timesheet.id }, data: { status: 'SUBMITTED' } });
    return res.json({ success: true, timesheet: updated });
  } catch (err) {
    next(err);
  }
});

for (const [path, nextStatus] of [['approve', 'APPROVED'], ['reject', 'REJECTED']]) {
  router.post(`/timesheets/:id/${path}`, requireHrRole('HR_ADMIN'), async (req, res, next) => {
    try {
      const timesheet = await prisma.hrTimesheet.findUnique({ where: { id: req.params.id } });
      if (!timesheet || timesheet.agencyId !== req.hrAgencyId) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      if (timesheet.status !== 'SUBMITTED') {
        return res.status(409).json({ success: false, error: 'INVALID_STATUS', message: `Cannot ${path} a timesheet that isn't SUBMITTED.` });
      }
      const updated = await prisma.hrTimesheet.update({
        where: { id: timesheet.id },
        data: { status: nextStatus, approvedById: req.user.id, approvedAt: new Date() },
      });
      await recordAudit({
        actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
        action: `hr.timesheet_${path}d`, entityType: 'HrTimesheet', entityId: timesheet.id,
        before: { status: timesheet.status }, after: { status: updated.status }, correlationId: req.correlationId,
      });
      return res.json({ success: true, timesheet: updated });
    } catch (err) {
      next(err);
    }
  });
}

router.get('/attendance/exceptions', requireHrRole('HR_ADMIN', 'HR_AUDITOR'), async (req, res, next) => {
  try {
    const where = { agencyId: req.hrAgencyId };
    if (req.query.status) where.status = req.query.status;
    const exceptions = await prisma.hrAttendanceException.findMany({
      where,
      include: {
        employeeProfile: { include: { user: { select: { firstName: true, lastName: true } } } },
        reviewedBy: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { detectedAt: 'desc' },
      take: 200,
    });
    return res.json({ success: true, exceptions });
  } catch (err) {
    next(err);
  }
});

const reviewSchema = z.object({
  status: z.enum(['UNDER_REVIEW', 'RESOLVED_EXCUSED', 'RESOLVED_UNEXCUSED']),
  reviewNote: z.string().trim().max(1000).optional(),
});

// The one and only way an HrAttendanceException leaves OPEN — always an
// explicit human call, never automatic. See the directive's own
// "no automatic discipline" rule.
router.post('/attendance/exceptions/:id/review', requireHrRole('HR_ADMIN'), async (req, res, next) => {
  try {
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const exception = await prisma.hrAttendanceException.findUnique({ where: { id: req.params.id } });
    if (!exception || exception.agencyId !== req.hrAgencyId) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const updated = await prisma.hrAttendanceException.update({
      where: { id: exception.id },
      data: { status: parsed.data.status, reviewNote: parsed.data.reviewNote, reviewedById: req.user.id, reviewedAt: new Date() },
    });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.attendance_exception_reviewed', entityType: 'HrAttendanceException', entityId: exception.id,
      before: { status: exception.status }, after: { status: updated.status }, correlationId: req.correlationId,
    });
    return res.json({ success: true, exception: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
