// Backstage HR — Phase 1 Part C: Leave. HrLeaveLedgerEntry (via
// lib/hrLeaveLedger.js's getBalanceMinutes) is the one and only source
// of truth for a balance — nothing here ever reads/writes a stored
// balance field. A protected leave type (isProtected) skips the ordinary
// balance-denial check and is simply left PENDING for HR_ADMIN manual
// review, never auto-approved or auto-denied. GET /hr/leave/calendar
// redacts a leave type's real category to "Approved time off" for anyone
// without HR_ADMIN authority — including an ordinary AGENCY_MANAGER, who
// can otherwise reach this route (team "who's out" visibility is
// deliberately broader than full HR access, matching how GET
// /timeclock/status is open to any authenticated agency member).
const express = require('express');
const { z } = require('zod');
const { prisma } = require('../../lib/db');
const { recordAudit } = require('../../lib/audit');
const { requireHrRole, hasHrRole } = require('../../middleware/hrAuth');
const { getBalanceMinutes } = require('../../lib/hrLeaveLedger');

const router = express.Router();

async function loadOwnEmployeeProfile(req) {
  return prisma.hrEmployeeProfile.findUnique({ where: { userId: req.user.id } });
}

// ---- Leave types (HR_ADMIN config) ----

router.get('/types', requireHrRole('HR_ADMIN', 'HR_AUDITOR'), async (req, res, next) => {
  try {
    const leaveTypes = await prisma.hrLeaveType.findMany({ where: { agencyId: req.hrAgencyId }, orderBy: { name: 'asc' } });
    return res.json({ success: true, leaveTypes });
  } catch (err) {
    next(err);
  }
});

const createLeaveTypeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  isPaid: z.boolean().optional(),
  isProtected: z.boolean().optional(),
});

router.post('/types', requireHrRole('HR_ADMIN'), async (req, res, next) => {
  try {
    const parsed = createLeaveTypeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const leaveType = await prisma.hrLeaveType.create({ data: { agencyId: req.hrAgencyId, ...parsed.data } });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.leave_type_created', entityType: 'HrLeaveType', entityId: leaveType.id,
      after: leaveType, correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, leaveType });
  } catch (err) {
    next(err);
  }
});

// ---- Leave policies (HR_ADMIN config) ----

router.get('/policies', requireHrRole('HR_ADMIN', 'HR_AUDITOR'), async (req, res, next) => {
  try {
    const policies = await prisma.hrLeavePolicy.findMany({
      where: { agencyId: req.hrAgencyId },
      include: { leaveType: true },
      orderBy: { name: 'asc' },
    });
    return res.json({ success: true, policies });
  } catch (err) {
    next(err);
  }
});

const createPolicySchema = z.object({
  leaveTypeId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  accrualMethod: z.enum(['FRONT_LOADED', 'PER_PAY_PERIOD', 'PER_HOUR_WORKED']),
  accrualAmountMinutes: z.number().int().positive().optional(),
  annualCapMinutes: z.number().int().positive().optional(),
  carryoverCapMinutes: z.number().int().min(0).optional(),
  waitingPeriodDays: z.number().int().min(0).optional(),
});

router.post('/policies', requireHrRole('HR_ADMIN'), async (req, res, next) => {
  try {
    const parsed = createPolicySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const leaveType = await prisma.hrLeaveType.findUnique({ where: { id: parsed.data.leaveTypeId } });
    if (!leaveType || leaveType.agencyId !== req.hrAgencyId) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'leaveTypeId must belong to this agency.' });
    }
    const policy = await prisma.hrLeavePolicy.create({ data: { agencyId: req.hrAgencyId, ...parsed.data }, include: { leaveType: true } });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.leave_policy_created', entityType: 'HrLeavePolicy', entityId: policy.id,
      after: policy, correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, policy });
  } catch (err) {
    next(err);
  }
});

// ---- Leave policy assignments (HR_ADMIN config — who accrues under which policy) ----

router.get('/policy-assignments', requireHrRole('HR_ADMIN', 'HR_AUDITOR'), async (req, res, next) => {
  try {
    const where = { leavePolicy: { agencyId: req.hrAgencyId } };
    if (req.query.employeeProfileId) where.employeeProfileId = req.query.employeeProfileId;
    const assignments = await prisma.hrLeavePolicyAssignment.findMany({
      where,
      include: { leavePolicy: { include: { leaveType: true } }, employeeProfile: { include: { user: { select: { firstName: true, lastName: true } } } } },
      orderBy: { effectiveFrom: 'desc' },
    });
    return res.json({ success: true, assignments });
  } catch (err) {
    next(err);
  }
});

const createAssignmentSchema = z.object({
  employeeProfileId: z.string().uuid(),
  leavePolicyId: z.string().uuid(),
  effectiveFrom: z.coerce.date().optional(),
});

router.post('/policy-assignments', requireHrRole('HR_ADMIN'), async (req, res, next) => {
  try {
    const parsed = createAssignmentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const [employee, policy] = await Promise.all([
      prisma.hrEmployeeProfile.findUnique({ where: { id: parsed.data.employeeProfileId } }),
      prisma.hrLeavePolicy.findUnique({ where: { id: parsed.data.leavePolicyId } }),
    ]);
    if (!employee || employee.agencyId !== req.hrAgencyId) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'employeeProfileId must belong to this agency.' });
    }
    if (!policy || policy.agencyId !== req.hrAgencyId) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'leavePolicyId must belong to this agency.' });
    }
    const assignment = await prisma.hrLeavePolicyAssignment.create({
      data: { employeeProfileId: parsed.data.employeeProfileId, leavePolicyId: parsed.data.leavePolicyId, effectiveFrom: parsed.data.effectiveFrom || new Date() },
      include: { leavePolicy: { include: { leaveType: true } } },
    });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.leave_policy_assigned', entityType: 'HrLeavePolicyAssignment', entityId: assignment.id,
      after: { employeeProfileId: assignment.employeeProfileId, leavePolicyId: assignment.leavePolicyId }, correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, assignment });
  } catch (err) {
    next(err);
  }
});

// ---- Balance ----

// Self-service by default (the caller's own HrEmployeeProfile); an
// HR_ADMIN/HR_AUDITOR may pass ?employeeProfileId= to check someone
// else's. Never a stored field — always SUM(minutes) over the ledger,
// computed fresh.
router.get('/balance', async (req, res, next) => {
  try {
    let employeeProfileId = req.query.employeeProfileId || null;
    let agencyId;
    if (employeeProfileId) {
      const target = await prisma.hrEmployeeProfile.findUnique({ where: { id: employeeProfileId } });
      if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
      agencyId = target.agencyId;
      const allowed = await hasHrRole(req.user, agencyId, 'HR_AUDITOR');
      if (!allowed && target.userId !== req.user.id) {
        return res.status(403).json({ success: false, error: 'FORBIDDEN' });
      }
    } else {
      const own = await loadOwnEmployeeProfile(req);
      if (!own) return res.json({ success: true, balances: [] });
      employeeProfileId = own.id;
      agencyId = own.agencyId;
    }

    const leaveTypes = await prisma.hrLeaveType.findMany({ where: { agencyId, isActive: true } });
    const balances = await Promise.all(leaveTypes.map(async (lt) => ({
      leaveTypeId: lt.id,
      leaveTypeName: lt.name,
      isPaid: lt.isPaid,
      isProtected: lt.isProtected,
      balanceMinutes: await getBalanceMinutes(prisma, { employeeProfileId, leaveTypeId: lt.id }),
    })));
    return res.json({ success: true, employeeProfileId, balances });
  } catch (err) {
    next(err);
  }
});

// ---- Leave requests ----

// HR review queue.
router.get('/requests', requireHrRole('HR_ADMIN', 'HR_AUDITOR'), async (req, res, next) => {
  try {
    const where = { agencyId: req.hrAgencyId };
    if (req.query.status) where.status = req.query.status;
    const requests = await prisma.hrLeaveRequest.findMany({
      where,
      include: { leaveType: true, employeeProfile: { include: { user: { select: { firstName: true, lastName: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    // A protected leave type is flagged to HR for manual review, not
    // hidden — HR_ADMIN/HR_AUDITOR see its real category here, unlike
    // the redacted team calendar below.
    return res.json({ success: true, requests });
  } catch (err) {
    next(err);
  }
});

// Self-service — the signed-in user's own leave-request history. Must be
// registered before anything that could otherwise capture "mine" as a
// param (there is no GET /requests/:id in Part C, but this follows the
// same precedent as /timesheets/mine for consistency).
router.get('/requests/mine', async (req, res, next) => {
  try {
    const own = await loadOwnEmployeeProfile(req);
    if (!own) return res.json({ success: true, requests: [] });
    const requests = await prisma.hrLeaveRequest.findMany({
      where: { employeeProfileId: own.id },
      include: { leaveType: true },
      orderBy: { createdAt: 'desc' },
      take: 52,
    });
    return res.json({ success: true, requests });
  } catch (err) {
    next(err);
  }
});

const createRequestSchema = z.object({
  leaveTypeId: z.string().uuid(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  requestedMinutes: z.number().int().positive(),
  note: z.string().trim().max(1000).optional(),
});

// Self-service create — any authenticated user with an HR profile can
// request their own leave. Ordinary (non-protected) leave types are
// rejected outright when the real computed balance can't cover the
// request; a protected leave type explicitly skips that check per the
// directive's own rule and is simply left PENDING for HR_ADMIN review —
// never auto-approved, never auto-denied.
router.post('/requests', async (req, res, next) => {
  try {
    const parsed = createRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    if (parsed.data.endDate < parsed.data.startDate) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'endDate cannot be before startDate.' });
    }
    const own = await loadOwnEmployeeProfile(req);
    if (!own) {
      return res.status(400).json({ success: false, error: 'NO_PROFILE', message: 'You need an HR profile before requesting leave.' });
    }
    const leaveType = await prisma.hrLeaveType.findUnique({ where: { id: parsed.data.leaveTypeId } });
    if (!leaveType || leaveType.agencyId !== own.agencyId || !leaveType.isActive) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'leaveTypeId must be an active leave type in your agency.' });
    }

    if (!leaveType.isProtected) {
      const balance = await getBalanceMinutes(prisma, { employeeProfileId: own.id, leaveTypeId: leaveType.id });
      if (balance < parsed.data.requestedMinutes) {
        return res.status(400).json({
          success: false, error: 'INSUFFICIENT_BALANCE',
          message: `Your ${leaveType.name} balance (${balance}m) does not cover this request (${parsed.data.requestedMinutes}m).`,
          balanceMinutes: balance,
        });
      }
    }

    const leaveRequest = await prisma.hrLeaveRequest.create({
      data: {
        employeeProfileId: own.id, agencyId: own.agencyId, leaveTypeId: leaveType.id,
        startDate: parsed.data.startDate, endDate: parsed.data.endDate,
        requestedMinutes: parsed.data.requestedMinutes, note: parsed.data.note,
      },
      include: { leaveType: true },
    });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: own.agencyId,
      action: 'hr.leave_request_created', entityType: 'HrLeaveRequest', entityId: leaveRequest.id,
      after: { leaveTypeId: leaveRequest.leaveTypeId, requestedMinutes: leaveRequest.requestedMinutes, protectedReview: leaveType.isProtected },
      correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, leaveRequest, flaggedForProtectedReview: leaveType.isProtected });
  } catch (err) {
    next(err);
  }
});

// Approve/deny — concurrency-safe via a conditional updateMany
// (WHERE status: 'PENDING') inside the same transaction as the USE
// ledger write: if two approval attempts race, Postgres's row lock on
// the UPDATE serializes them, and the loser's updateMany matches zero
// rows once the winner has committed — exactly one succeeds. Denying
// posts no ledger entry at all.
router.post('/requests/:id/approve', requireHrRole('HR_ADMIN'), async (req, res, next) => {
  try {
    const existing = await prisma.hrLeaveRequest.findUnique({ where: { id: req.params.id }, include: { leaveType: true } });
    if (!existing || existing.agencyId !== req.hrAgencyId) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (existing.status !== 'PENDING') {
      return res.status(409).json({ success: false, error: 'INVALID_STATUS', message: 'This request is no longer PENDING.' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const updateResult = await tx.hrLeaveRequest.updateMany({
        where: { id: existing.id, status: 'PENDING' },
        data: { status: 'APPROVED', decidedById: req.user.id, decidedAt: new Date() },
      });
      if (updateResult.count === 0) return { conflict: true };

      await tx.hrLeaveLedgerEntry.create({
        data: {
          employeeProfileId: existing.employeeProfileId, leaveTypeId: existing.leaveTypeId, agencyId: existing.agencyId,
          transactionType: 'USE', minutes: -existing.requestedMinutes,
          reason: `Leave approved: ${existing.leaveType.name} ${existing.startDate.toISOString().slice(0, 10)}–${existing.endDate.toISOString().slice(0, 10)}`,
          sourceRequestId: existing.id, recordedById: req.user.id,
        },
      });
      const updated = await tx.hrLeaveRequest.findUnique({ where: { id: existing.id } });
      return { updated };
    });

    if (result.conflict) {
      return res.status(409).json({ success: false, error: 'INVALID_STATUS', message: 'This request is no longer PENDING.' });
    }
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.leave_request_approved', entityType: 'HrLeaveRequest', entityId: existing.id,
      before: { status: 'PENDING' }, after: { status: 'APPROVED' }, correlationId: req.correlationId,
    });
    return res.json({ success: true, leaveRequest: result.updated });
  } catch (err) {
    next(err);
  }
});

const denySchema = z.object({ decisionNote: z.string().trim().max(1000).optional() });

router.post('/requests/:id/deny', requireHrRole('HR_ADMIN'), async (req, res, next) => {
  try {
    const parsed = denySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const existing = await prisma.hrLeaveRequest.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.agencyId !== req.hrAgencyId) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const updateResult = await prisma.hrLeaveRequest.updateMany({
      where: { id: existing.id, status: 'PENDING' },
      data: { status: 'DENIED', decidedById: req.user.id, decidedAt: new Date(), decisionNote: parsed.data.decisionNote },
    });
    if (updateResult.count === 0) {
      return res.status(409).json({ success: false, error: 'INVALID_STATUS', message: 'This request is no longer PENDING.' });
    }
    const updated = await prisma.hrLeaveRequest.findUnique({ where: { id: existing.id } });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.leave_request_denied', entityType: 'HrLeaveRequest', entityId: existing.id,
      before: { status: 'PENDING' }, after: { status: 'DENIED' }, correlationId: req.correlationId,
    });
    return res.json({ success: true, leaveRequest: updated });
  } catch (err) {
    next(err);
  }
});

// ---- Team calendar ----

// Open to any authenticated agency member (not HR-role-gated) — the same
// "who's out" transparency GET /timeclock/status already gives the whole
// team, per the existing-system audit. Redaction, not access, is what
// protects a protected leave type: anyone without real HR_ADMIN
// authority for this agency sees "Approved time off" instead of the
// actual leave type name, and only ever sees APPROVED requests (never a
// PENDING one, which could itself leak a sensitive reason before HR has
// even reviewed it).
router.get('/calendar', async (req, res, next) => {
  try {
    const agencyId = req.user.role === 'PLATFORM_OWNER'
      ? (req.query.agencyId || null)
      : req.user.agencyId;
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const where = { agencyId, status: 'APPROVED' };
    if (req.query.start) where.endDate = { gte: new Date(req.query.start) };
    if (req.query.end) where.startDate = { ...(where.startDate || {}), lte: new Date(req.query.end) };

    const requests = await prisma.hrLeaveRequest.findMany({
      where,
      include: { leaveType: true, employeeProfile: { include: { user: { select: { firstName: true, lastName: true } } } } },
      orderBy: { startDate: 'asc' },
      take: 500,
    });

    const canSeeProtected = await hasHrRole(req.user, agencyId, 'HR_ADMIN');
    const entries = requests.map((r) => ({
      id: r.id,
      employeeProfileId: r.employeeProfileId,
      employeeName: `${r.employeeProfile.user.firstName || ''} ${r.employeeProfile.user.lastName || ''}`.trim(),
      startDate: r.startDate,
      endDate: r.endDate,
      leaveTypeName: (!canSeeProtected && r.leaveType.isProtected) ? 'Approved time off' : r.leaveType.name,
      isProtected: canSeeProtected ? r.leaveType.isProtected : false,
    }));
    return res.json({ success: true, entries });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
