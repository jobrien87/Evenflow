// HrPosition CRUD — mirrors departments.js exactly.
const express = require('express');
const { z } = require('zod');
const { prisma } = require('../../lib/db');
const { recordAudit } = require('../../lib/audit');
const { requireHrRole } = require('../../middleware/hrAuth');

const router = express.Router();

router.get('/', requireHrRole('HR_ADMIN', 'HR_AUDITOR'), async (req, res, next) => {
  try {
    const positions = await prisma.hrPosition.findMany({
      where: { agencyId: req.hrAgencyId },
      include: { department: { select: { id: true, name: true } } },
      orderBy: { title: 'asc' },
    });
    return res.json({ success: true, positions });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  title: z.string().trim().min(1).max(120),
  departmentId: z.string().uuid().optional(),
});

router.post('/', requireHrRole('HR_ADMIN'), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    if (parsed.data.departmentId) {
      const dept = await prisma.hrDepartment.findUnique({ where: { id: parsed.data.departmentId }, select: { agencyId: true } });
      if (!dept || dept.agencyId !== req.hrAgencyId) {
        return res.status(400).json({ success: false, error: 'VALIDATION', message: 'departmentId must belong to this agency.' });
      }
    }
    const position = await prisma.hrPosition.create({ data: { agencyId: req.hrAgencyId, ...parsed.data } });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.position_created', entityType: 'HrPosition', entityId: position.id,
      after: position, correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, position });
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  departmentId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
});

router.patch('/:id', requireHrRole('HR_ADMIN'), async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const existing = await prisma.hrPosition.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.agencyId !== req.hrAgencyId) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    }
    const updated = await prisma.hrPosition.update({ where: { id: req.params.id }, data: parsed.data });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.position_updated', entityType: 'HrPosition', entityId: updated.id,
      before: existing, after: updated, correlationId: req.correlationId,
    });
    return res.json({ success: true, position: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
