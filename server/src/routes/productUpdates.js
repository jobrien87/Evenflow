// Platform-Owner CRUD for ED's "what's new" feed (ProductUpdate rows) —
// see lib/productUpdates.js for how ED actually reads these back. Thin on
// purpose: every row is live the moment it's created, no draft/publish
// state machine (see schema.prisma's own comment on the model).
const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('PLATFORM_OWNER'));

router.get('/', async (req, res, next) => {
  try {
    const updates = await prisma.productUpdate.findMany({ orderBy: { publishedAt: 'desc' }, take: 100 });
    return res.json({ success: true, updates });
  } catch (err) {
    next(err);
  }
});

// Matches the real User.role enum values an update's audience can be
// scoped to — never a freeform string, same discipline as every other
// role-gated field in this app.
const VALID_ROLES = ['PRODUCER', 'TELEMARKETER', 'AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'];

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(2000),
  // Empty = every role sees/hears about it.
  audienceRoles: z.array(z.enum(VALID_ROLES)).max(VALID_ROLES.length).default([]),
  // Lets a Platform Owner backdate an entry for something that shipped
  // slightly before they got around to writing it up — defaults to now.
  publishedAt: z.string().datetime().optional(),
});

router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const update = await prisma.productUpdate.create({
      data: {
        title: parsed.data.title,
        body: parsed.data.body,
        audienceRoles: parsed.data.audienceRoles,
        ...(parsed.data.publishedAt ? { publishedAt: new Date(parsed.data.publishedAt) } : {}),
        createdById: req.user.id,
      },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, action: 'PRODUCT_UPDATE_PUBLISHED',
      entityType: 'ProductUpdate', entityId: update.id, after: { title: update.title }, correlationId: req.correlationId,
    });

    return res.status(201).json({ success: true, update });
  } catch (err) {
    next(err);
  }
});

const patchSchema = createSchema.partial();

router.patch('/:id', async (req, res, next) => {
  try {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const existing = await prisma.productUpdate.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    const data = { ...parsed.data };
    if (data.publishedAt) data.publishedAt = new Date(data.publishedAt);

    const update = await prisma.productUpdate.update({ where: { id: req.params.id }, data });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, action: 'PRODUCT_UPDATE_EDITED',
      entityType: 'ProductUpdate', entityId: update.id, before: { title: existing.title, body: existing.body }, after: data, correlationId: req.correlationId,
    });

    return res.json({ success: true, update });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await prisma.productUpdate.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ success: false, error: 'NOT_FOUND' });

    await prisma.productUpdate.delete({ where: { id: req.params.id } });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, action: 'PRODUCT_UPDATE_DELETED',
      entityType: 'ProductUpdate', entityId: req.params.id, before: { title: existing.title }, correlationId: req.correlationId,
    });

    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
