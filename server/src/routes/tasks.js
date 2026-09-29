const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole, scopeAgencyId } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { computeProducerScore } = require('../lib/flowScore');

const router = express.Router();
router.use(requireAuth);

// A Telemarketer has no agencyId of their own (cross-agency via
// TelemarketerAssignment) — scopeAgencyId(req) returns null for them,
// which would otherwise omit the agencyId filter entirely rather than
// scope it (see opportunities.js for the same fix/reasoning). Scope a
// TM strictly to their own assignedToId instead, same as a Producer.
router.get('/', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PRODUCER', 'TELEMARKETER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const isTelemarketer = req.user.role === 'TELEMARKETER';
    const agencyId = isTelemarketer ? null : scopeAgencyId(req);
    const where = {
      ...(isTelemarketer ? { assignedToId: req.user.id } : agencyId ? { agencyId } : {}),
      ...(req.user.role === 'PRODUCER' ? { assignedToId: req.user.id } : {}),
      ...(req.query.status ? { status: req.query.status } : {}),
    };
    const tasks = await prisma.task.findMany({
      where,
      include: { lead: { include: { customer: true } } },
      orderBy: [{ priority: 'desc' }, { dueAt: 'asc' }],
    });
    return res.json({ success: true, tasks });
  } catch (err) {
    next(err);
  }
});

const createTaskSchema = z.object({
  agencyId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
  type: z.enum(['FOLLOW_UP', 'CALLBACK', 'APPOINTMENT', 'MANAGER', 'TRAINING', 'WINBACK', 'CROSS_SELL']),
  title: z.string().min(1),
  description: z.string().optional(),
  dueAt: z.string().datetime().optional(),
  assignedToId: z.string().uuid().optional(),
  priority: z.number().int().min(0).max(100).optional(),
});

router.post('/', async (req, res, next) => {
  try {
    const parsed = createTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    let agencyId;
    if (req.user.role === 'PLATFORM_OWNER') {
      agencyId = parsed.data.agencyId;
    } else if (req.user.role === 'TELEMARKETER') {
      // Never trust a client-supplied agencyId blindly — require a real
      // ACTIVE assignment to that exact agency, same pattern leads.js
      // already uses for a TM's other cross-agency writes.
      const requested = parsed.data.agencyId;
      if (!requested) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });
      const assignment = await prisma.telemarketerAssignment.findFirst({
        where: { telemarketerId: req.user.id, agencyId: requested, status: 'ACTIVE' },
      });
      if (!assignment) return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Not assigned to that agency.' });
      agencyId = requested;
    } else {
      agencyId = req.user.agencyId;
    }
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const task = await prisma.task.create({
      data: {
        agencyId,
        leadId: parsed.data.leadId,
        type: parsed.data.type,
        title: parsed.data.title,
        description: parsed.data.description,
        dueAt: parsed.data.dueAt ? new Date(parsed.data.dueAt) : null,
        assignedToId: parsed.data.assignedToId,
        priority: parsed.data.priority ?? 0,
        createdById: req.user.id,
      },
    });

    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      agencyId,
      action: 'task.created',
      entityType: 'Task',
      entityId: task.id,
      after: task,
      correlationId: req.correlationId,
    });

    return res.status(201).json({ success: true, task });
  } catch (err) {
    next(err);
  }
});

const completeSchema = z.object({
  outcome: z.string().optional(),
  status: z.enum(['COMPLETED', 'SNOOZED', 'CANCELLED']).default('COMPLETED'),
  snoozeUntil: z.string().datetime().optional(),
});

router.post('/:taskId/complete', async (req, res, next) => {
  try {
    const parsed = completeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const task = await prisma.task.findUnique({ where: { id: req.params.taskId } });
    if (!task) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    // A Telemarketer's own agencyId is always null (cross-agency), so the
    // plain agency-match check would always 403 them out of their own
    // task — allow completing a task that's genuinely assigned to you,
    // regardless of the agency-membership check, in addition to it.
    const sameAgency = req.user.role === 'PLATFORM_OWNER' || task.agencyId === req.user.agencyId;
    const isOwnTask = task.assignedToId === req.user.id;
    if (!sameAgency && !isOwnTask) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    const data = { status: parsed.data.status, outcome: parsed.data.outcome };
    if (parsed.data.status === 'COMPLETED') data.completedAt = new Date();
    if (parsed.data.status === 'SNOOZED' && parsed.data.snoozeUntil) data.dueAt = new Date(parsed.data.snoozeUntil);

    const updated = await prisma.task.update({ where: { id: task.id }, data });

    await recordAudit({
      actorId: req.user.id,
      actorRole: req.user.role,
      agencyId: task.agencyId,
      action: `task.${parsed.data.status.toLowerCase()}`,
      entityType: 'Task',
      entityId: task.id,
      before: { status: task.status },
      after: { status: updated.status },
      correlationId: req.correlationId,
    });

    if (updated.status === 'COMPLETED' && updated.assignedToId) {
      computeProducerScore(updated.assignedToId).catch((err) =>
        console.error('[flowScore] recompute after task completion failed', err.message)
      );
    }

    return res.json({ success: true, task: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
