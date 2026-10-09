// HrRoleGrant management — delegating HR_ADMIN/HR_AUDITOR authority to a
// specific user. Deliberately gated to AGENCY_OWNER/PLATFORM_OWNER
// directly (requireRole, not requireHrRole) rather than to HR_ADMIN —
// an appointed HR Admin should not be able to mint further HR Admins;
// only the agency's actual owner (or the platform) delegates this.
const express = require('express');
const { z } = require('zod');
const { prisma } = require('../../lib/db');
const { recordAudit } = require('../../lib/audit');
const { requireRole, scopeAgencyId } = require('../../middleware/auth');
const { requireHrRole } = require('../../middleware/hrAuth');

const router = express.Router();

// Read access matches every other HR route's convention (ADMIN + AUDITOR
// can both see who holds HR authority — that's exactly what "auditor"
// means); only the writes below stay AGENCY_OWNER/PLATFORM_OWNER-only.
router.get('/', requireHrRole('HR_ADMIN', 'HR_AUDITOR'), async (req, res, next) => {
  try {
    const grants = await prisma.hrRoleGrant.findMany({
      where: { agencyId: req.hrAgencyId, revokedAt: null },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
        grantedBy: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { grantedAt: 'desc' },
    });
    return res.json({ success: true, grants });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  userId: z.string().uuid(),
  hrRole: z.enum(['HR_ADMIN', 'HR_AUDITOR']),
});

router.post('/', requireRole('AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const agencyId = scopeAgencyId(req) || req.body.agencyId;
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const target = await prisma.user.findUnique({ where: { id: parsed.data.userId }, select: { id: true, agencyId: true, status: true } });
    if (!target || target.agencyId !== agencyId) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'userId must belong to this agency.' });
    }
    if (target.status !== 'ACTIVE') {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Only an active user can be granted HR authority.' });
    }

    const existing = await prisma.hrRoleGrant.findUnique({
      where: { userId_agencyId_hrRole: { userId: parsed.data.userId, agencyId, hrRole: parsed.data.hrRole } },
    });
    let grant;
    if (existing) {
      grant = await prisma.hrRoleGrant.update({
        where: { id: existing.id },
        data: { revokedAt: null, grantedById: req.user.id, grantedAt: new Date() },
      });
    } else {
      grant = await prisma.hrRoleGrant.create({
        data: { userId: parsed.data.userId, agencyId, hrRole: parsed.data.hrRole, grantedById: req.user.id },
      });
    }

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId,
      action: 'hr.role_granted', entityType: 'HrRoleGrant', entityId: grant.id,
      after: { userId: grant.userId, hrRole: grant.hrRole }, correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, grant });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/revoke', requireRole('AGENCY_OWNER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencyId = scopeAgencyId(req);
    const existing = await prisma.hrRoleGrant.findUnique({ where: { id: req.params.id } });
    if (!existing || (agencyId && existing.agencyId !== agencyId)) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    }
    if (existing.revokedAt) {
      return res.status(409).json({ success: false, error: 'ALREADY_REVOKED' });
    }
    const revoked = await prisma.hrRoleGrant.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: existing.agencyId,
      action: 'hr.role_revoked', entityType: 'HrRoleGrant', entityId: revoked.id,
      before: { revokedAt: null }, after: { revokedAt: revoked.revokedAt }, correlationId: req.correlationId,
    });
    return res.json({ success: true, grant: revoked });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
