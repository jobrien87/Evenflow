const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { recordAudit } = require('../lib/audit');
const { notifyUser } = require('../lib/notifications');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const where = req.user.role === 'PLATFORM_OWNER' ? {} : { agencyId: req.user.agencyId };
    const tickets = await prisma.supportTicket.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
    return res.json({ success: true, tickets });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  category: z.string().min(1),
  subject: z.string().min(1),
  description: z.string().min(1),
  metadata: z.record(z.any()).optional(),
});

router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });

    const ticket = await prisma.supportTicket.create({
      data: {
        agencyId: req.user.agencyId,
        userId: req.user.id,
        category: parsed.data.category,
        subject: parsed.data.subject,
        description: parsed.data.description,
        metadata: {
          ...(parsed.data.metadata || {}),
          correlationId: req.correlationId,
          page: req.headers.referer || null,
        },
      },
    });

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: req.user.agencyId,
      action: 'support.ticket_created', entityType: 'SupportTicket', entityId: ticket.id,
      after: { subject: parsed.data.subject, category: parsed.data.category }, correlationId: req.correlationId,
    });

    return res.status(201).json({ success: true, ticket });
  } catch (err) {
    next(err);
  }
});

const statusSchema = z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED']) });

router.patch('/:id/status', requireRole('PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'VALIDATION' });
    const ticket = await prisma.supportTicket.update({ where: { id: req.params.id }, data: { status: parsed.data.status } });

    await notifyUser({
      userId: ticket.userId,
      agencyId: ticket.agencyId,
      type: 'support.status_changed',
      severity: 'ACTION',
      title: `Support ticket ${parsed.data.status.replace(/_/g, ' ').toLowerCase()}`,
      body: ticket.subject,
      relatedEntityType: 'SupportTicket',
      relatedEntityId: ticket.id,
    });

    return res.json({ success: true, ticket });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
