const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole, scopeAgencyId } = require('../middleware/auth');
const { eligibleProducersWhere } = require('../lib/eligibleProducersQuery');
const { recordAudit } = require('../lib/audit');
const { notifyUser } = require('../lib/notifications');

const router = express.Router();
router.use(requireAuth);

// Fixed, server-authored caveat strings — reused by the response here and
// by any client surface that renders a reassignment result, so the two
// can never drift into inconsistent wording. These are the concrete
// mechanism behind "must not imply the HighLevel host changed" and "must
// not imply availability was checked."
const REASSIGN_WARNINGS = [
  'This changes who owns this appointment inside EvenFlow only — the HighLevel calendar host is unchanged.',
  'Availability has not been verified for the newly assigned producer — confirm directly before relying on this time.',
];

// GET /api/appointments — the owner-visible surface for failed syncs and
// unassigned/missing bookings (requirement: "visible to the owner for
// resolution, not silently lost"). A dedicated endpoint rather than
// bolted onto GET /tasks, since syncStatus/unassigned/time fields are
// Appointment-specific vocabulary GET /tasks has no reason to carry for
// its 6 other task types.
router.get('/', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PRODUCER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const agencyId = scopeAgencyId(req);
    const where = {
      ...(agencyId ? { agencyId } : {}),
      ...(req.user.role === 'PRODUCER' ? { assignedToId: req.user.id } : {}),
      ...(req.query.status ? { status: req.query.status } : {}),
      ...(req.query.syncStatus ? { syncStatus: req.query.syncStatus } : {}),
      ...(req.query.unassigned === 'true' ? { assignedToId: null } : {}),
      ...(req.query.vendorId ? { vendorId: req.query.vendorId } : {}),
      ...(req.query.leadId ? { leadId: req.query.leadId } : {}),
    };
    const appointments = await prisma.appointment.findMany({
      where,
      include: {
        lead: { include: { customer: true } },
        task: true,
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
        hostUser: { select: { id: true, firstName: true, lastName: true } },
        vendor: { select: { id: true, name: true } },
      },
      orderBy: { startAt: 'desc' },
    });
    return res.json({ success: true, appointments });
  } catch (err) {
    next(err);
  }
});

const reassignSchema = z.object({
  assignedToId: z.string().uuid(),
});

// POST /api/appointments/:appointmentId/reassign — the appointment-to-
// producer workflow gap the deployed build's lead REASSIGN control never
// closed (lead reassign moves only Lead.assignedToId, with no linked-task
// sync and a broader role check than this needs). Kept as its own route
// rather than extending leads.js's /reassign: a narrower, explicit role
// check (no Producer self-reassignment — "authorized owner/manager" per
// the request) and zero added regression risk to the heavily-used
// existing route.
router.post('/:appointmentId/reassign', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER', 'PLATFORM_OWNER'), async (req, res, next) => {
  try {
    const parsed = reassignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }

    const appointment = await prisma.appointment.findUnique({ where: { id: req.params.appointmentId } });
    if (!appointment) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    if (req.user.role !== 'PLATFORM_OWNER' && appointment.agencyId !== req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' });
    }

    const previousAssigneeId = appointment.assignedToId;
    const { assignedToId: newAssigneeId } = parsed.data;
    if (newAssigneeId === previousAssigneeId) {
      return res.status(400).json({ success: false, error: 'VALIDATION', message: 'This appointment is already assigned to that person.' });
    }

    // Never trust the client-supplied target blindly — must be a real,
    // active, production-eligible teammate in this exact same agency.
    // Reuses the same shared predicate leads.js's /reassign uses — never
    // widened beyond it.
    const target = await prisma.user.findFirst({
      where: eligibleProducersWhere(appointment.agencyId, { id: newAssigneeId }),
      select: { id: true },
    });
    if (!target) {
      return res.status(400).json({ success: false, error: 'INVALID_ASSIGNEE', message: 'assignedToId must be a real, active producer or manager in this agency.' });
    }

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        // Atomic concurrency guard — same updateMany-then-recheck idiom as
        // leads.js's /reassign, keyed on the assignee actually still being
        // who we read above.
        const appointmentUpdate = await tx.appointment.updateMany({
          where: { id: appointment.id, assignedToId: previousAssigneeId },
          data: { assignedToId: newAssigneeId },
        });
        if (appointmentUpdate.count === 0) {
          const err = new Error('ALREADY_REASSIGNED');
          err.code = 'ALREADY_REASSIGNED';
          throw err;
        }

        // Keep Task and Lead assignment in lockstep — this data object
        // contains assignedToId and nothing else; assignedAt/
        // firstAttemptAt/firstContactAt are never written here, exactly
        // preserving the original intake/first-attempt timestamps.
        if (appointment.taskId) {
          await tx.task.update({ where: { id: appointment.taskId }, data: { assignedToId: newAssigneeId } });
        }
        await tx.lead.update({ where: { id: appointment.leadId }, data: { assignedToId: newAssigneeId } });

        await tx.leadEvent.create({
          data: {
            leadId: appointment.leadId,
            type: 'lead.appointment_reassigned',
            metadata: { appointmentId: appointment.id, fromAssigneeId: previousAssigneeId, toAssigneeId: newAssigneeId, reassignedById: req.user.id },
          },
        });

        return tx.appointment.findUnique({
          where: { id: appointment.id },
          include: {
            lead: { include: { customer: true } },
            task: true,
            assignedTo: { select: { id: true, firstName: true, lastName: true } },
            hostUser: { select: { id: true, firstName: true, lastName: true } },
          },
        });
      });
    } catch (err) {
      if (err.code === 'ALREADY_REASSIGNED') {
        return res.status(409).json({ success: false, error: 'ALREADY_REASSIGNED', message: 'This appointment was just reassigned by someone else.' });
      }
      throw err;
    }

    await recordAudit({
      actorId: req.user.id, actorRole: req.user.role, agencyId: appointment.agencyId,
      action: 'appointment.reassigned', entityType: 'Appointment', entityId: appointment.id,
      before: { assignedToId: previousAssigneeId }, after: { assignedToId: newAssigneeId },
      correlationId: req.correlationId,
    });

    await notifyUser({
      userId: newAssigneeId,
      agencyId: appointment.agencyId,
      type: 'appointment.assigned',
      severity: 'INFO',
      title: 'An appointment was reassigned to you',
      body: 'Check your queue for the details.',
      relatedEntityType: 'Appointment',
      relatedEntityId: appointment.id,
    });

    return res.json({ success: true, appointment: result, warnings: REASSIGN_WARNINGS });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
