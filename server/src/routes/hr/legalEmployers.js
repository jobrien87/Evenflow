// HrLegalEmployer CRUD — the "which legal entity actually employs this
// person" concept, kept separate from Agency (the SaaS tenant) per the
// directive's own "do not treat the SaaS tenant as automatically
// identical to the legal employer" rule. jurisdictionCountry/Region are
// plain strings (not an enum) — Phase 1 is U.S.-only by decision, but
// this shape means a future jurisdiction never needs a schema rework.
const express = require('express');
const { z } = require('zod');
const { prisma } = require('../../lib/db');
const { recordAudit } = require('../../lib/audit');
const { requireHrRole } = require('../../middleware/hrAuth');

const router = express.Router();

router.get('/', requireHrRole('HR_ADMIN', 'HR_AUDITOR'), async (req, res, next) => {
  try {
    const legalEmployers = await prisma.hrLegalEmployer.findMany({
      where: { agencyId: req.hrAgencyId },
      orderBy: { legalName: 'asc' },
    });
    return res.json({ success: true, legalEmployers });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  legalName: z.string().trim().min(1).max(200),
  jurisdictionCountry: z.string().trim().length(2).toUpperCase(),
  jurisdictionRegion: z.string().trim().min(1).max(10).optional(),
});

router.post('/', requireHrRole('HR_ADMIN'), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const legalEmployer = await prisma.hrLegalEmployer.create({ data: { agencyId: req.hrAgencyId, ...parsed.data } });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.legal_employer_created', entityType: 'HrLegalEmployer', entityId: legalEmployer.id,
      after: legalEmployer, correlationId: req.correlationId,
    });
    return res.status(201).json({ success: true, legalEmployer });
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({
  legalName: z.string().trim().min(1).max(200).optional(),
  jurisdictionCountry: z.string().trim().length(2).toUpperCase().optional(),
  jurisdictionRegion: z.string().trim().min(1).max(10).nullable().optional(),
});

router.patch('/:id', requireHrRole('HR_ADMIN'), async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const existing = await prisma.hrLegalEmployer.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.agencyId !== req.hrAgencyId) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    }
    const updated = await prisma.hrLegalEmployer.update({ where: { id: req.params.id }, data: parsed.data });
    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.hrAgencyId,
      action: 'hr.legal_employer_updated', entityType: 'HrLegalEmployer', entityId: updated.id,
      before: existing, after: updated, correlationId: req.correlationId,
    });
    return res.json({ success: true, legalEmployer: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
