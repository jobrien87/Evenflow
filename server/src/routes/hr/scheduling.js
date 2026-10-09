// Backstage HR — Phase 1 Part C: Scheduling. A shift swap always
// requires explicit manager approval before HrShiftAssignment actually
// changes — never auto-applied. Scheduling a shift that overlaps an
// approved leave request produces a warning in the response, never a
// silent block and never a silent double-booking.
const express = require('express');
const { z } = require('zod');
const { prisma } = require('../../lib/db');
const { recordAudit } = require('../../lib/audit');
const { requireHrRole, hasHrRole } = require('../../middleware/hrAuth');
const { resolveShiftInstants, workDateOverlapsLeave, isoWeekRange, wallClockHHMM } = require('../../lib/hrScheduling');

const router = express.Router();

const DEFAULT_WEEKLY_OVERTIME_THRESHOLD_MINUTES = 40 * 60;
const DEFAULT_WORK_TIME_ZONE = 'America/New_York';

// Scheduling is a line-manager task, not exclusively an "HR" one —
// matches the plan's own "create, HR_ADMIN/manager" note: a plain
// AGENCY_OWNER/AGENCY_MANAGER (or PLATFORM_OWNER) may create/edit shifts
// for their own agency with no HR grant required, same as an HR_ADMIN
// grant-holder.
function requireHrAdminOrManager() {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ success: false, error: 'UNAUTHENTICATED', correlationId: req.correlationId });
      const agencyId = req.user.role === 'PLATFORM_OWNER'
        ? (req.query.agencyId || req.params.agencyId || req.body.agencyId || null)
        : req.user.agencyId;
      if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED', correlationId: req.correlationId });

      const isManager = req.user.role === 'PLATFORM_OWNER'
        || (['AGENCY_OWNER', 'AGENCY_MANAGER'].includes(req.user.role) && req.user.agencyId === agencyId);
      if (isManager || await hasHrRole(req.user, agencyId, 'HR_ADMIN')) {
        req.hrAgencyId = agencyId;
        return next();
      }
      return res.status(403).json({
        success: false, error: 'FORBIDDEN',
        message: 'You need HR_ADMIN authority or a manager role in this agency.',
        correlationId: req.correlationId,
      });
    } catch (err) {
      next(err);
    }
  };
}

function resolveBroadAgencyId(req) {
  return req.user.role === 'PLATFORM_OWNER' ? (req.query.agencyId || null) : req.user.agencyId;
}

const SHIFT_INCLUDE = {
  employeeProfile: { include: { user: { select: { id: true, firstName: true, lastName: true } } } },
  shiftTemplate: true,
};

// ---- Shift templates ----

// Broad visibility (any authenticated agency member), same reasoning as
// GET /hr/leave/calendar — knowing the shift pattern isn't sensitive.
router.get('/schedule/shift-templates', async (req, res, next) => {
  try {
    const agencyId = resolveBroadAgencyId(req);
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    const shiftTemplates = await prisma.hrShiftTemplate.findMany({
      where: { agencyId, isActive: true },
      include: { department: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });
    return res.json({ success: true, shiftTemplates });
  } catch (err) {
    next(err);
  }
});

const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  startTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'HH:MM required'),
  endTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'HH:MM required'),
  departmentId: z.string().uuid().optional(),
});

router.post('/schedule/shift-templates', requireHrAdminOrManager(), async (req, res, next) => {
  try {
    const parsed = createTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    if (parsed.data.departmentId) {
      const dept = await prisma.hrDepartment.findUnique({ where: { id: parsed.data.departmentId }, select: { agencyId: true } });
      if (!dept || dept.agencyId !== req.hrAgencyId) {
        return res.status(400).json({ success: false, error: 'VALIDATION', message: 'departmentId must belong to this agency.' });
      }
    }
    const shiftTemplate = await prisma.hrShiftTemplate.create({ data: { agencyId: req.hrAgencyId, ...parsed.data } });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.shift_template_created', entityType: 'HrShiftTemplate', entityId: shiftTemplate.id,
      after: shiftTemplate, correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, shiftTemplate });
  } catch (err) {
    next(err);
  }
});

// ---- Schedule (shift assignments) ----

router.get('/schedule', async (req, res, next) => {
  try {
    const agencyId = resolveBroadAgencyId(req);
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    const where = { agencyId };
    if (!req.query.includeCancelled) where.status = { not: 'CANCELLED' };
    if (req.query.start) where.workDate = { ...(where.workDate || {}), gte: new Date(req.query.start) };
    if (req.query.end) where.workDate = { ...(where.workDate || {}), lte: new Date(req.query.end) };
    if (req.query.employeeProfileId) where.employeeProfileId = req.query.employeeProfileId;
    if (req.query.departmentId) where.employeeProfile = { departmentId: req.query.departmentId };

    const shifts = await prisma.hrShiftAssignment.findMany({ where, include: SHIFT_INCLUDE, orderBy: { workDate: 'asc' }, take: 1000 });
    return res.json({ success: true, shifts });
  } catch (err) {
    next(err);
  }
});

// Self-service — the signed-in user's own shifts.
router.get('/schedule/mine', async (req, res, next) => {
  try {
    const own = await prisma.hrEmployeeProfile.findUnique({ where: { userId: req.user.id } });
    if (!own) return res.json({ success: true, shifts: [] });
    const where = { employeeProfileId: own.id, status: { not: 'CANCELLED' } };
    if (req.query.start) where.workDate = { ...(where.workDate || {}), gte: new Date(req.query.start) };
    if (req.query.end) where.workDate = { ...(where.workDate || {}), lte: new Date(req.query.end) };
    const shifts = await prisma.hrShiftAssignment.findMany({
      where,
      include: { shiftTemplate: true, swapRequests: { where: { status: 'PENDING' }, select: { id: true, status: true } } },
      orderBy: { workDate: 'asc' },
      take: 200,
    });
    return res.json({ success: true, shifts });
  } catch (err) {
    next(err);
  }
});

async function computeWarnings({ agencyId, employeeProfileId, workDate, startAt, endAt, excludeShiftId }) {
  const warnings = [];

  const approvedLeave = await prisma.hrLeaveRequest.findMany({ where: { agencyId, employeeProfileId, status: 'APPROVED' } });
  if (approvedLeave.some((lr) => workDateOverlapsLeave(workDate, lr))) {
    warnings.push('SHIFT_OVERLAPS_APPROVED_LEAVE');
  }

  const { start: weekStart, end: weekEnd } = isoWeekRange(workDate);
  const [settings, weekShifts] = await Promise.all([
    prisma.hrSettings.findUnique({ where: { agencyId } }),
    prisma.hrShiftAssignment.findMany({
      where: {
        agencyId, employeeProfileId, status: { not: 'CANCELLED' },
        workDate: { gte: weekStart, lt: weekEnd },
        ...(excludeShiftId ? { id: { not: excludeShiftId } } : {}),
      },
      select: { startAt: true, endAt: true },
    }),
  ]);
  const threshold = settings?.weeklyOvertimeThresholdMinutes ?? DEFAULT_WEEKLY_OVERTIME_THRESHOLD_MINUTES;
  const existingMinutes = weekShifts.reduce((sum, s) => sum + Math.round((s.endAt.getTime() - s.startAt.getTime()) / 60000), 0);
  const newMinutes = Math.round((endAt.getTime() - startAt.getTime()) / 60000);
  if (existingMinutes + newMinutes > threshold) {
    warnings.push('WEEKLY_OVERTIME_THRESHOLD_EXCEEDED');
  }

  return warnings;
}

const createShiftSchema = z.object({
  employeeProfileId: z.string().uuid(),
  shiftTemplateId: z.string().uuid().optional(),
  workDate: z.coerce.date(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
  endTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
  notes: z.string().trim().max(1000).optional(),
}).refine((d) => d.shiftTemplateId || (d.startTime && d.endTime), {
  message: 'Either shiftTemplateId or both startTime and endTime are required.',
});

router.post('/schedule/shifts', requireHrAdminOrManager(), async (req, res, next) => {
  try {
    const parsed = createShiftSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const employee = await prisma.hrEmployeeProfile.findUnique({ where: { id: parsed.data.employeeProfileId } });
    if (!employee || employee.agencyId !== req.hrAgencyId) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'employeeProfileId must belong to this agency.' });
    }

    let startTime = parsed.data.startTime;
    let endTime = parsed.data.endTime;
    let shiftTemplateId = parsed.data.shiftTemplateId || null;
    if (shiftTemplateId) {
      const template = await prisma.hrShiftTemplate.findUnique({ where: { id: shiftTemplateId } });
      if (!template || template.agencyId !== req.hrAgencyId) {
        return res.status(400).json({ success: false, error: 'VALIDATION', message: 'shiftTemplateId must belong to this agency.' });
      }
      startTime = template.startTime;
      endTime = template.endTime;
    }

    const timeZone = employee.workTimeZone || DEFAULT_WORK_TIME_ZONE;
    const instants = resolveShiftInstants({ workDate: parsed.data.workDate, startTime, endTime, timeZone });
    if (!instants) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Could not resolve shift start/end times.' });
    }

    const warnings = await computeWarnings({
      agencyId: req.hrAgencyId, employeeProfileId: employee.id, workDate: parsed.data.workDate,
      startAt: instants.startAt, endAt: instants.endAt,
    });

    const shift = await prisma.hrShiftAssignment.create({
      data: {
        agencyId: req.hrAgencyId, employeeProfileId: employee.id, shiftTemplateId,
        workDate: parsed.data.workDate, startAt: instants.startAt, endAt: instants.endAt,
        notes: parsed.data.notes, createdById: req.user.id,
      },
      include: SHIFT_INCLUDE,
    });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.shift_created', entityType: 'HrShiftAssignment', entityId: shift.id,
      after: { employeeProfileId: shift.employeeProfileId, workDate: shift.workDate }, correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, shift, warnings });
  } catch (err) {
    next(err);
  }
});

const updateShiftSchema = z.object({
  workDate: z.coerce.date().optional(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
  endTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

router.patch('/schedule/shifts/:id', requireHrAdminOrManager(), async (req, res, next) => {
  try {
    const parsed = updateShiftSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const existing = await prisma.hrShiftAssignment.findUnique({ where: { id: req.params.id }, include: { employeeProfile: true } });
    if (!existing || existing.agencyId !== req.hrAgencyId) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (existing.status === 'CANCELLED') {
      return res.status(409).json({ success: false, error: 'INVALID_STATUS', message: 'A cancelled shift cannot be edited.' });
    }

    const workDate = parsed.data.workDate || existing.workDate;
    let startAt = existing.startAt;
    let endAt = existing.endAt;
    let warnings = [];
    if (parsed.data.workDate || parsed.data.startTime || parsed.data.endTime) {
      const timeZone = existing.employeeProfile.workTimeZone || DEFAULT_WORK_TIME_ZONE;
      const startTime = parsed.data.startTime || wallClockHHMM(existing.startAt, timeZone);
      const endTime = parsed.data.endTime || wallClockHHMM(existing.endAt, timeZone);
      const instants = resolveShiftInstants({ workDate, startTime, endTime, timeZone });
      if (!instants) return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Could not resolve shift start/end times.' });
      startAt = instants.startAt;
      endAt = instants.endAt;
      warnings = await computeWarnings({
        agencyId: req.hrAgencyId, employeeProfileId: existing.employeeProfileId, workDate, startAt, endAt, excludeShiftId: existing.id,
      });
    }

    const updated = await prisma.hrShiftAssignment.update({
      where: { id: existing.id },
      data: { workDate, startAt, endAt, notes: parsed.data.notes === undefined ? undefined : parsed.data.notes },
      include: SHIFT_INCLUDE,
    });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.shift_updated', entityType: 'HrShiftAssignment', entityId: updated.id,
      before: { workDate: existing.workDate, startAt: existing.startAt, endAt: existing.endAt },
      after: { workDate: updated.workDate, startAt: updated.startAt, endAt: updated.endAt }, correlationId: req.correlationId,
    });
    return res.json({ success: true, shift: updated, warnings });
  } catch (err) {
    next(err);
  }
});

// Soft-cancel — matches this codebase's "never destroy history"
// convention (same precedent as HrDepartment's PATCH isActive: false
// "delete"); the row and its history stay, just flagged CANCELLED.
router.delete('/schedule/shifts/:id', requireHrAdminOrManager(), async (req, res, next) => {
  try {
    const existing = await prisma.hrShiftAssignment.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.agencyId !== req.hrAgencyId) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    const updated = await prisma.hrShiftAssignment.update({ where: { id: existing.id }, data: { status: 'CANCELLED' } });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.shift_cancelled', entityType: 'HrShiftAssignment', entityId: updated.id,
      before: { status: existing.status }, after: { status: 'CANCELLED' }, correlationId: req.correlationId,
    });
    return res.json({ success: true, shift: updated });
  } catch (err) {
    next(err);
  }
});

// ---- Shift swap requests ----

const swapRequestSchema = z.object({
  proposedCoveringUserId: z.string().uuid().optional(),
  reason: z.string().trim().max(1000).optional(),
});

// Employee-initiated — the shift's own owner only (requireAuth is
// already applied once for the whole /hr router in hr/index.js; no HR
// role is required to request a swap on your own shift).
router.post('/schedule/shifts/:id/swap-request', async (req, res, next) => {
  try {
    const parsed = swapRequestSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const shift = await prisma.hrShiftAssignment.findUnique({ where: { id: req.params.id }, include: { employeeProfile: true } });
    if (!shift) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (shift.employeeProfile.userId !== req.user.id) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Only the assigned employee can request a swap for their own shift.' });
    }
    if (shift.status !== 'SCHEDULED') {
      return res.status(409).json({ success: false, error: 'INVALID_STATUS', message: 'Only a SCHEDULED shift can have a swap requested.' });
    }
    if (parsed.data.proposedCoveringUserId) {
      const coveringUser = await prisma.user.findUnique({ where: { id: parsed.data.proposedCoveringUserId }, select: { agencyId: true } });
      if (!coveringUser || coveringUser.agencyId !== shift.agencyId) {
        return res.status(400).json({ success: false, error: 'VALIDATION', message: 'proposedCoveringUserId must belong to this agency.' });
      }
    }
    const swapRequest = await prisma.hrShiftSwapRequest.create({
      data: { shiftAssignmentId: shift.id, requestedById: req.user.id, proposedCoveringUserId: parsed.data.proposedCoveringUserId, reason: parsed.data.reason },
    });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: shift.agencyId,
      action: 'hr.shift_swap_requested', entityType: 'HrShiftSwapRequest', entityId: swapRequest.id,
      after: { shiftAssignmentId: shift.id }, correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, swapRequest });
  } catch (err) {
    next(err);
  }
});

router.get('/schedule/swap-requests', requireHrAdminOrManager(), async (req, res, next) => {
  try {
    const where = { shiftAssignment: { agencyId: req.hrAgencyId } };
    if (req.query.status) where.status = req.query.status;
    const swapRequests = await prisma.hrShiftSwapRequest.findMany({
      where,
      include: { shiftAssignment: { include: SHIFT_INCLUDE } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return res.json({ success: true, swapRequests });
  } catch (err) {
    next(err);
  }
});

const decideSwapSchema = z.object({ coveringUserId: z.string().uuid().optional() });

// Approving always goes through explicit manager/HR_ADMIN approval and
// only THEN mutates HrShiftAssignment — never auto-applied. A covering
// employee is required to complete the swap (either proposed on the
// original request, or supplied fresh here); without one, there is
// nothing to reassign the shift to.
router.post('/schedule/swap-requests/:id/approve', requireHrAdminOrManager(), async (req, res, next) => {
  try {
    const parsed = decideSwapSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const existing = await prisma.hrShiftSwapRequest.findUnique({ where: { id: req.params.id }, include: { shiftAssignment: true } });
    if (!existing || existing.shiftAssignment.agencyId !== req.hrAgencyId) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (existing.status !== 'PENDING') {
      return res.status(409).json({ success: false, error: 'INVALID_STATUS', message: 'This swap request is no longer PENDING.' });
    }
    const coveringUserId = parsed.data.coveringUserId || existing.proposedCoveringUserId;
    if (!coveringUserId) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'A covering employee is required to approve a swap.' });
    }
    const coveringProfile = await prisma.hrEmployeeProfile.findUnique({ where: { userId: coveringUserId } });
    if (!coveringProfile || coveringProfile.agencyId !== req.hrAgencyId) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'The covering employee must have an HR profile in this agency.' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const updateResult = await tx.hrShiftSwapRequest.updateMany({
        where: { id: existing.id, status: 'PENDING' },
        data: { status: 'APPROVED', decidedById: req.user.id, decidedAt: new Date() },
      });
      if (updateResult.count === 0) return { conflict: true };
      const shift = await tx.hrShiftAssignment.update({
        where: { id: existing.shiftAssignmentId },
        data: { employeeProfileId: coveringProfile.id, status: 'COVERED' },
        include: SHIFT_INCLUDE,
      });
      const swapRequest = await tx.hrShiftSwapRequest.findUnique({ where: { id: existing.id } });
      return { swapRequest, shift };
    });
    if (result.conflict) {
      return res.status(409).json({ success: false, error: 'INVALID_STATUS', message: 'This swap request is no longer PENDING.' });
    }
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.shift_swap_approved', entityType: 'HrShiftSwapRequest', entityId: existing.id,
      before: { shiftEmployeeProfileId: existing.shiftAssignment.employeeProfileId },
      after: { shiftEmployeeProfileId: coveringProfile.id }, correlationId: req.correlationId,
    });
    return res.json({ success: true, swapRequest: result.swapRequest, shift: result.shift });
  } catch (err) {
    next(err);
  }
});

router.post('/schedule/swap-requests/:id/deny', requireHrAdminOrManager(), async (req, res, next) => {
  try {
    const existing = await prisma.hrShiftSwapRequest.findUnique({ where: { id: req.params.id }, include: { shiftAssignment: true } });
    if (!existing || existing.shiftAssignment.agencyId !== req.hrAgencyId) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    const updateResult = await prisma.hrShiftSwapRequest.updateMany({
      where: { id: existing.id, status: 'PENDING' },
      data: { status: 'DENIED', decidedById: req.user.id, decidedAt: new Date() },
    });
    if (updateResult.count === 0) {
      return res.status(409).json({ success: false, error: 'INVALID_STATUS', message: 'This swap request is no longer PENDING.' });
    }
    const swapRequest = await prisma.hrShiftSwapRequest.findUnique({ where: { id: existing.id } });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.shift_swap_denied', entityType: 'HrShiftSwapRequest', entityId: existing.id,
      before: { status: 'PENDING' }, after: { status: 'DENIED' }, correlationId: req.correlationId,
    });
    return res.json({ success: true, swapRequest });
  } catch (err) {
    next(err);
  }
});

// ---- Settings (weekly overtime scheduling heads-up) ----

router.get('/settings', requireHrRole('HR_ADMIN', 'HR_AUDITOR'), async (req, res, next) => {
  try {
    const settings = await prisma.hrSettings.findUnique({ where: { agencyId: req.hrAgencyId } });
    return res.json({ success: true, settings: settings || { agencyId: req.hrAgencyId, weeklyOvertimeThresholdMinutes: DEFAULT_WEEKLY_OVERTIME_THRESHOLD_MINUTES } });
  } catch (err) {
    next(err);
  }
});

const settingsSchema = z.object({ weeklyOvertimeThresholdMinutes: z.number().int().positive() });

router.patch('/settings', requireHrRole('HR_ADMIN'), async (req, res, next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const settings = await prisma.hrSettings.upsert({
      where: { agencyId: req.hrAgencyId },
      create: { agencyId: req.hrAgencyId, weeklyOvertimeThresholdMinutes: parsed.data.weeklyOvertimeThresholdMinutes },
      update: { weeklyOvertimeThresholdMinutes: parsed.data.weeklyOvertimeThresholdMinutes },
    });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.settings_updated', entityType: 'HrSettings', entityId: settings.id,
      after: settings, correlationId: req.correlationId,
    });
    return res.json({ success: true, settings });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
