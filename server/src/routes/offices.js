// Physical branch/location CRUD for agencies with more than one office —
// see schema.prisma's Office model. Agency Owner/Manager manage their own
// agency's offices; Platform Owner can manage any (scoped via ?agencyId=,
// mirroring vendors.js's scopedAgencyId pattern).
const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');

const router = express.Router();
router.use(requireAuth);

function scopedAgencyId(req) {
  return req.user.role === 'PLATFORM_OWNER' ? req.query.agencyId || req.body.agencyId : req.user.agencyId;
}

router.get('/', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencyId = scopedAgencyId(req);
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
    const offices = await prisma.office.findMany({
      where: { agencyId },
      include: { users: { select: { id: true, firstName: true, lastName: true }, where: { role: 'PRODUCER' } } },
      orderBy: { createdAt: 'asc' },
    });
    return res.json({ success: true, offices });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({ name: z.string().trim().min(1).max(120), agencyId: z.string().uuid().optional() });

router.post('/', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const agencyId = req.user.role === 'PLATFORM_OWNER' ? parsed.data.agencyId : req.user.agencyId;
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const office = await prisma.office.create({ data: { agencyId, name: parsed.data.name } });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId,
      action: 'office.created', entityType: 'Office', entityId: office.id,
      after: { name: office.name }, correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, office: { ...office, users: [] } });
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({ name: z.string().trim().min(1).max(120) });

router.patch('/:officeId', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const office = await prisma.office.findUnique({ where: { id: req.params.officeId } });
    if (!office) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && office.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    const updated = await prisma.office.update({ where: { id: office.id }, data: { name: parsed.data.name } });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: office.agencyId,
      action: 'office.updated', entityType: 'Office', entityId: office.id,
      before: { name: office.name }, after: { name: updated.name }, correlationId: req.correlationId,
    });
    return res.json({ success: true, office: updated });
  } catch (err) {
    next(err);
  }
});

router.delete('/:officeId', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const office = await prisma.office.findUnique({ where: { id: req.params.officeId } });
    if (!office) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && office.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }
    // Producers assigned to a deleted office fall back to unassigned
    // (officeId nullable) rather than being blocked or cascade-deleted.
    await prisma.$transaction([
      prisma.user.updateMany({ where: { officeId: office.id }, data: { officeId: null } }),
      prisma.office.delete({ where: { id: office.id } }),
    ]);
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: office.agencyId,
      action: 'office.deleted', entityType: 'Office', entityId: office.id,
      before: { name: office.name }, correlationId: req.correlationId,
    });
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
