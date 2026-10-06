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
      include: {
        users: { select: { id: true, firstName: true, lastName: true }, where: { role: 'PRODUCER' } },
        alphaAssignments: { include: { user: { select: { id: true, firstName: true, lastName: true } } } },
      },
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

const zipRangeSchema = z.object({
  start: z.string().regex(/^[0-9]{5}$/, 'start must be a 5-digit zip'),
  end: z.string().regex(/^[0-9]{5}$/, 'end must be a 5-digit zip'),
}).refine((r) => r.start <= r.end, { message: 'start must be <= end' });

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  routingCities: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  routingZipRanges: z.array(zipRangeSchema).max(50).optional(),
  isDefaultOffice: z.boolean().optional(),
  routingMode: z.enum(['ROUND_ROBIN', 'ALPHA_SPLIT']).optional(),
});

// A city/zip-range value configured on one office while it's already
// claimed by another office in the same agency silently decides nothing —
// resolveOfficeForLead just matches whichever office it iterates to first.
// Reject at write time instead, naming the conflicting office, so an owner
// finds out immediately rather than discovering it from misrouted leads.
function findGeographyConflict(otherOffices, { routingCities, routingZipRanges }) {
  if (routingCities && routingCities.length > 0) {
    const normalized = routingCities.map((c) => c.trim().toUpperCase());
    for (const other of otherOffices) {
      const overlap = (other.routingCities || []).find((c) => normalized.includes(c));
      if (overlap) return { office: other, field: 'routingCities', value: overlap };
    }
  }
  if (routingZipRanges && routingZipRanges.length > 0) {
    for (const other of otherOffices) {
      let otherRanges = [];
      try {
        otherRanges = Array.isArray(other.routingZipRanges) ? other.routingZipRanges : JSON.parse(other.routingZipRanges || '[]');
      } catch {
        otherRanges = [];
      }
      for (const r of routingZipRanges) {
        const overlap = otherRanges.find((o) => o && o.start && o.end && r.start <= o.end && o.start <= r.end);
        if (overlap) return { office: other, field: 'routingZipRanges', value: overlap };
      }
    }
  }
  return null;
}

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

    const normalizedCities = parsed.data.routingCities
      ? [...new Set(parsed.data.routingCities.map((c) => c.trim().toUpperCase()))]
      : undefined;

    if (normalizedCities || parsed.data.routingZipRanges) {
      const otherOffices = await prisma.office.findMany({ where: { agencyId: office.agencyId, id: { not: office.id } } });
      const conflict = findGeographyConflict(otherOffices, { routingCities: normalizedCities, routingZipRanges: parsed.data.routingZipRanges });
      if (conflict) {
        return res.status(409).json({
          success: false, error: 'GEOGRAPHY_CONFLICT',
          message: `${conflict.field === 'routingCities' ? `City "${conflict.value}"` : `Zip range ${conflict.value.start}-${conflict.value.end}`} overlaps with office "${conflict.office.name}".`,
        });
      }
    }

    const data = {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(normalizedCities !== undefined ? { routingCities: normalizedCities } : {}),
      ...(parsed.data.routingZipRanges !== undefined ? { routingZipRanges: parsed.data.routingZipRanges } : {}),
      ...(parsed.data.routingMode !== undefined ? { routingMode: parsed.data.routingMode } : {}),
      ...(parsed.data.isDefaultOffice !== undefined ? { isDefaultOffice: parsed.data.isDefaultOffice } : {}),
    };

    const updated = await prisma.$transaction(async (tx) => {
      if (parsed.data.isDefaultOffice === true) {
        await tx.office.updateMany({ where: { agencyId: office.agencyId, id: { not: office.id } }, data: { isDefaultOffice: false } });
      }
      return tx.office.update({ where: { id: office.id }, data });
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: office.agencyId,
      action: 'office.updated', entityType: 'Office', entityId: office.id,
      before: { name: office.name, routingCities: office.routingCities, routingZipRanges: office.routingZipRanges, isDefaultOffice: office.isDefaultOffice, routingMode: office.routingMode },
      after: data, correlationId: req.correlationId,
    });
    return res.json({ success: true, office: updated });
  } catch (err) {
    next(err);
  }
});

const alphaAssignmentsSchema = z.object({
  assignments: z.array(z.object({
    userId: z.string().uuid(),
    letters: z.array(z.string().regex(/^[A-Z]$/)).max(26),
    isFallback: z.boolean().optional(),
  })).max(50),
});

// Full-replace semantics (delete-all + recreate in one transaction),
// matching Vendor.selectedAgentIds's existing whole-array-replace
// convention — simpler and safer than trying to diff a partial PATCH
// against whatever letter claims already exist.
router.put('/:officeId/alpha-assignments', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = alphaAssignmentsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const office = await prisma.office.findUnique({ where: { id: req.params.officeId } });
    if (!office) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && office.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    const { assignments } = parsed.data;
    const fallbackCount = assignments.filter((a) => a.isFallback).length;
    if (assignments.length > 0 && fallbackCount !== 1) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Exactly one producer must be marked as the fallback for any unclaimed letter.' });
    }
    const letterOwners = new Map();
    for (const a of assignments) {
      if (a.isFallback) continue;
      for (const letter of a.letters) {
        if (letterOwners.has(letter)) {
          return res.status(400).json({ success: false, error: 'VALIDATION', message: `Letter "${letter}" is claimed by more than one producer.` });
        }
        letterOwners.set(letter, a.userId);
      }
    }
    if (assignments.length > 0) {
      const userIds = assignments.map((a) => a.userId);
      const activeAtThisOffice = await prisma.user.findMany({
        where: { id: { in: userIds }, role: 'PRODUCER', status: 'ACTIVE', officeId: office.id },
        select: { id: true },
      });
      const validIds = new Set(activeAtThisOffice.map((u) => u.id));
      const invalid = userIds.find((id) => !validIds.has(id));
      if (invalid) {
        return res.status(400).json({ success: false, error: 'VALIDATION', message: 'Every producer must be an ACTIVE producer already assigned to this office.' });
      }
    }

    await prisma.$transaction([
      prisma.officeAlphaAssignment.deleteMany({ where: { officeId: office.id } }),
      ...(assignments.length > 0
        ? [prisma.officeAlphaAssignment.createMany({
            data: assignments.map((a) => ({ officeId: office.id, userId: a.userId, letters: a.letters, isFallback: !!a.isFallback })),
          })]
        : []),
    ]);

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: office.agencyId,
      action: 'office.alpha_assignments_updated', entityType: 'Office', entityId: office.id,
      after: { assignments }, correlationId: req.correlationId,
    });

    const refreshed = await prisma.officeAlphaAssignment.findMany({
      where: { officeId: office.id },
      include: { user: { select: { id: true, firstName: true, lastName: true } } },
    });
    return res.json({ success: true, assignments: refreshed });
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
    // Letter claims at this office have no meaning once it's gone.
    await prisma.$transaction([
      prisma.officeAlphaAssignment.deleteMany({ where: { officeId: office.id } }),
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
