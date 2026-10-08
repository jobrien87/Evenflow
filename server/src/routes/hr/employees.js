// HrEmployeeProfile CRUD — the 1:1 HR extension of a real User row (never
// a second identity, see schema.prisma's own comment on this model).
// PATCH writes an HrEmploymentHistoryEvent for every department/manager/
// position/location/status change, append-only, never edited or deleted.
const express = require('express');
const { z } = require('zod');
const { prisma } = require('../../lib/db');
const { recordAudit } = require('../../lib/audit');
const { requireHrRole } = require('../../middleware/hrAuth');

const router = express.Router();

const EMPLOYEE_INCLUDE = {
  user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, role: true, status: true, officeId: true } },
  department: { select: { id: true, name: true } },
  position: { select: { id: true, title: true } },
  manager: { select: { id: true, firstName: true, lastName: true } },
  legalEmployer: { select: { id: true, legalName: true } },
};

router.get('/', requireHrRole('HR_ADMIN', 'HR_AUDITOR'), async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 50, 1), 100);
    const search = (req.query.search || '').trim();
    const where = {
      agencyId: req.hrAgencyId,
      ...(req.query.departmentId ? { departmentId: req.query.departmentId } : {}),
      ...(search ? { user: { OR: [{ firstName: { contains: search, mode: 'insensitive' } }, { lastName: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }] } } : {}),
    };
    const [total, employees] = await Promise.all([
      prisma.hrEmployeeProfile.count({ where }),
      prisma.hrEmployeeProfile.findMany({
        where, include: EMPLOYEE_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize, take: pageSize,
      }),
    ]);
    return res.json({ success: true, page, pageSize, total, employees });
  } catch (err) {
    next(err);
  }
});

// Self-service — any authenticated user (within an hrEnabled agency, per
// hr/index.js's module gate) can read their own HR profile, no HR role
// required. Returns employee: null when no profile has been created for
// them yet, never a 404 — having no HR profile is a normal state, not an
// error. Must be registered before GET /:id so Express doesn't capture
// "me" as the :id param.
router.get('/me', async (req, res, next) => {
  try {
    const employee = await prisma.hrEmployeeProfile.findUnique({
      where: { userId: req.user.id },
      include: EMPLOYEE_INCLUDE,
    });
    return res.json({ success: true, employee: employee || null });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireHrRole('HR_ADMIN', 'HR_AUDITOR'), async (req, res, next) => {
  try {
    const employee = await prisma.hrEmployeeProfile.findUnique({
      where: { id: req.params.id },
      include: { ...EMPLOYEE_INCLUDE, employmentHistory: { orderBy: { effectiveFrom: 'desc' }, include: { recordedBy: { select: { id: true, firstName: true, lastName: true } } } } },
    });
    if (!employee || employee.agencyId !== req.hrAgencyId) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    }
    return res.json({ success: true, employee });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  userId: z.string().uuid(),
  legalEmployerId: z.string().uuid().optional(),
  employeeNumber: z.string().trim().max(50).optional(),
  legalFirstName: z.string().trim().max(100).optional(),
  legalLastName: z.string().trim().max(100).optional(),
  personalEmail: z.string().trim().email().optional(),
  employmentType: z.string().trim().max(50).optional(),
  workerClassification: z.string().trim().max(50).optional(),
  hireDate: z.coerce.date().optional(),
  originalHireDate: z.coerce.date().optional(),
  departmentId: z.string().uuid().optional(),
  positionId: z.string().uuid().optional(),
  managerId: z.string().uuid().optional(),
  workTimeZone: z.string().trim().max(50).optional(),
});

// Never creates a new identity — this only ever attaches an HR profile to
// an EXISTING User row in the same agency. If that User already has one,
// this is a 409, not a silent overwrite.
router.post('/', requireHrRole('HR_ADMIN'), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const targetUser = await prisma.user.findUnique({ where: { id: parsed.data.userId }, select: { id: true, agencyId: true } });
    if (!targetUser || targetUser.agencyId !== req.hrAgencyId) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'userId must belong to this agency.' });
    }
    const already = await prisma.hrEmployeeProfile.findUnique({ where: { userId: parsed.data.userId } });
    if (already) {
      return res.status(409).json({ success: false, error: 'PROFILE_EXISTS', message: 'This user already has an HR profile.' });
    }
    for (const [field, model] of [['departmentId', 'hrDepartment'], ['positionId', 'hrPosition'], ['legalEmployerId', 'hrLegalEmployer']]) {
      if (parsed.data[field]) {
        // eslint-disable-next-line no-await-in-loop
        const row = await prisma[model].findUnique({ where: { id: parsed.data[field] }, select: { agencyId: true } });
        if (!row || row.agencyId !== req.hrAgencyId) {
          return res.status(400).json({ success: false, error: 'VALIDATION', message: `${field} must belong to this agency.` });
        }
      }
    }
    if (parsed.data.managerId) {
      const manager = await prisma.user.findUnique({ where: { id: parsed.data.managerId }, select: { agencyId: true } });
      if (!manager || manager.agencyId !== req.hrAgencyId) {
        return res.status(400).json({ success: false, error: 'VALIDATION', message: 'managerId must belong to this agency.' });
      }
    }

    const employee = await prisma.hrEmployeeProfile.create({ data: { agencyId: req.hrAgencyId, ...parsed.data }, include: EMPLOYEE_INCLUDE });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.employee_profile_created', entityType: 'HrEmployeeProfile', entityId: employee.id,
      after: { userId: employee.userId }, correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, employee });
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({
  version: z.number().int(),
  legalEmployerId: z.string().uuid().nullable().optional(),
  employeeNumber: z.string().trim().max(50).nullable().optional(),
  legalFirstName: z.string().trim().max(100).nullable().optional(),
  legalLastName: z.string().trim().max(100).nullable().optional(),
  personalEmail: z.string().trim().email().nullable().optional(),
  employmentType: z.string().trim().max(50).nullable().optional(),
  workerClassification: z.string().trim().max(50).nullable().optional(),
  hireDate: z.coerce.date().nullable().optional(),
  originalHireDate: z.coerce.date().nullable().optional(),
  terminationDate: z.coerce.date().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  positionId: z.string().uuid().nullable().optional(),
  managerId: z.string().uuid().nullable().optional(),
  officeId: z.string().uuid().nullable().optional(),
  workTimeZone: z.string().trim().max(50).nullable().optional(),
  onboardingStatus: z.string().trim().max(30).optional(),
  offboardingStatus: z.string().trim().max(30).optional(),
});

router.patch('/:id', requireHrRole('HR_ADMIN'), async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const { version, officeId, ...rest } = parsed.data;

    const existing = await prisma.hrEmployeeProfile.findUnique({ where: { id: req.params.id }, include: { user: { select: { officeId: true, agencyId: true } } } });
    if (!existing || existing.agencyId !== req.hrAgencyId) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    }
    if (existing.version !== version) {
      return res.status(409).json({ success: false, error: 'CONFLICT', message: 'This profile was changed by someone else — reload and try again.' });
    }
    if (officeId !== undefined && officeId !== null) {
      const office = await prisma.office.findUnique({ where: { id: officeId }, select: { agencyId: true } });
      if (!office || office.agencyId !== req.hrAgencyId) {
        return res.status(400).json({ success: false, error: 'VALIDATION', message: 'officeId must belong to this agency.' });
      }
    }

    const historyEvents = [];
    const noteChange = (changeType, field, previousValue, newValue) => {
      if (previousValue === newValue) return;
      historyEvents.push({ employeeProfileId: existing.id, agencyId: req.hrAgencyId, changeType, effectiveFrom: new Date(), previousValue: { [field]: previousValue }, newValue: { [field]: newValue }, recordedById: req.user.id });
    };
    if ('departmentId' in rest) noteChange('DEPARTMENT_CHANGE', 'departmentId', existing.departmentId, rest.departmentId ?? null);
    if ('positionId' in rest) noteChange('POSITION_CHANGE', 'positionId', existing.positionId, rest.positionId ?? null);
    if ('managerId' in rest) noteChange('MANAGER_CHANGE', 'managerId', existing.managerId, rest.managerId ?? null);
    if (officeId !== undefined) noteChange('LOCATION_CHANGE', 'officeId', existing.user.officeId, officeId);
    if (rest.onboardingStatus !== undefined && rest.onboardingStatus !== existing.onboardingStatus) {
      historyEvents.push({ employeeProfileId: existing.id, agencyId: req.hrAgencyId, changeType: 'STATUS_CHANGE', previousValue: { onboardingStatus: existing.onboardingStatus }, newValue: { onboardingStatus: rest.onboardingStatus }, recordedById: req.user.id });
    }
    if (rest.offboardingStatus !== undefined && rest.offboardingStatus !== existing.offboardingStatus) {
      historyEvents.push({ employeeProfileId: existing.id, agencyId: req.hrAgencyId, changeType: 'STATUS_CHANGE', previousValue: { offboardingStatus: existing.offboardingStatus }, newValue: { offboardingStatus: rest.offboardingStatus }, recordedById: req.user.id });
    }

    const [updated] = await prisma.$transaction([
      prisma.hrEmployeeProfile.update({ where: { id: existing.id }, data: { ...rest, version: { increment: 1 } }, include: EMPLOYEE_INCLUDE }),
      ...(officeId !== undefined ? [prisma.user.update({ where: { id: existing.userId }, data: { officeId } })] : []),
      ...historyEvents.map((data) => prisma.hrEmploymentHistoryEvent.create({ data })),
    ]);

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.employee_profile_updated', entityType: 'HrEmployeeProfile', entityId: existing.id,
      before: { departmentId: existing.departmentId, positionId: existing.positionId, managerId: existing.managerId },
      after: { departmentId: updated.departmentId, positionId: updated.positionId, managerId: updated.managerId },
      correlationId: req.correlationId,
    });
    return res.json({ success: true, employee: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
