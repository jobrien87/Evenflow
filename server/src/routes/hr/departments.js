// HrDepartment CRUD — org-structure foundation for Backstage HR. Never
// hard-deleted (matches this app's "never destroy history" convention);
// "delete" is PATCHing isActive: false.
const express = require('express');
const { z } = require('zod');
const { prisma } = require('../../lib/db');
const { recordAudit } = require('../../lib/audit');
const { requireHrRole } = require('../../middleware/hrAuth');

const router = express.Router();

router.get('/', requireHrRole('HR_ADMIN', 'HR_AUDITOR'), async (req, res, next) => {
  try {
    const departments = await prisma.hrDepartment.findMany({
      where: { agencyId: req.hrAgencyId },
      include: {
        manager: { select: { id: true, firstName: true, lastName: true } },
        parentDepartment: { select: { id: true, name: true } },
      },
      orderBy: { name: 'asc' },
    });
    return res.json({ success: true, departments });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentDepartmentId: z.string().uuid().optional(),
  managerId: z.string().uuid().optional(),
});

router.post('/', requireHrRole('HR_ADMIN'), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    if (parsed.data.parentDepartmentId) {
      const parent = await prisma.hrDepartment.findUnique({ where: { id: parsed.data.parentDepartmentId }, select: { agencyId: true } });
      if (!parent || parent.agencyId !== req.hrAgencyId) {
        return res.status(400).json({ success: false, error: 'VALIDATION', message: 'parentDepartmentId must belong to this agency.' });
      }
    }
    if (parsed.data.managerId) {
      const manager = await prisma.user.findUnique({ where: { id: parsed.data.managerId }, select: { agencyId: true } });
      if (!manager || manager.agencyId !== req.hrAgencyId) {
        return res.status(400).json({ success: false, error: 'VALIDATION', message: 'managerId must belong to this agency.' });
      }
    }
    const department = await prisma.hrDepartment.create({ data: { agencyId: req.hrAgencyId, ...parsed.data } });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.department_created', entityType: 'HrDepartment', entityId: department.id,
      after: department, correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, department });
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  parentDepartmentId: z.string().uuid().nullable().optional(),
  managerId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
});

router.patch('/:id', requireHrRole('HR_ADMIN'), async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const existing = await prisma.hrDepartment.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.agencyId !== req.hrAgencyId) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    }
    if (parsed.data.parentDepartmentId && parsed.data.parentDepartmentId === req.params.id) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'A department cannot be its own parent.' });
    }
    const updated = await prisma.hrDepartment.update({ where: { id: req.params.id }, data: parsed.data });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.department_updated', entityType: 'HrDepartment', entityId: updated.id,
      before: existing, after: updated, correlationId: req.correlationId,
    });
    return res.json({ success: true, department: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
