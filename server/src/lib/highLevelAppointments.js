// Business logic for inbound HighLevel appointment-booking webhooks —
// find-or-create the right Lead, find-or-update the one Appointment (+
// its linked Task) for a given booking, with an out-of-order guard so a
// cancel/reschedule pair delivered in either HTTP order converges to the
// same correct final state. Kept separate from the thin route handler
// (routes/highlevelWebhook.js) the same way lib/stripe.js's
// processStripeEvent is separate from routes/billing.js's handler, so the
// transactional logic here is independently testable.
//
// Never touches Lead.status beyond 'APPOINTMENT' (forward-only, never a
// SOLD/production path), never creates a Sale/RevenueEvent, and never
// writes Appointment.hostUserId/hostExternalName from anywhere but here —
// the EF reassignment route (routes/appointments.js) only ever writes
// assignedToId, never the host fields, which is what keeps "EF
// reassignment must not silently change the HighLevel host" true by
// construction rather than by convention.

const crypto = require('crypto');
const { prisma } = require('./db');
const { normalizePhone, normalizeEmail } = require('./normalize');
const { resolveVendorAssignment } = require('./leadDistribution');
const { deriveLeadType } = require('./leadType');
const { scoreLead } = require('./priority');
const { recordAudit } = require('./audit');
const { notifyAgencyOwners, notifyUser } = require('./notifications');

// A booking event is only ever allowed to advance a Lead's status INTO
// 'APPOINTMENT' from one of these — a lead already further along
// (QUOTED/SOLD/LOST/etc.) is never regressed by a repeat/rebooking event.
const ADVANCEABLE_LEAD_STATUSES = ['NEW', 'CONTACTED', 'LEFT_VM', 'QUOTED', 'QUOTED_HOT', 'FOLLOW_UP'];

const CANCEL_STATUS_HINTS = ['cancel', 'invalid', 'void'];
const NOSHOW_STATUS_HINTS = ['noshow', 'no-show', 'no_show'];
const COMPLETE_STATUS_HINTS = ['showed', 'completed', 'complete'];

// Our own normalized vocabulary (AppointmentStatus), mapped defensively
// from HighLevel's raw status text — an unrecognized or absent value
// never throws and never guesses CANCELLED/COMPLETED, only ever falls
// back to SCHEDULED.
function mapAppointmentStatus(eventType, rawStatus) {
  const raw = (rawStatus || '').toLowerCase();
  if (CANCEL_STATUS_HINTS.some((h) => raw.includes(h))) return 'CANCELLED';
  if (NOSHOW_STATUS_HINTS.some((h) => raw.includes(h))) return 'NO_SHOW';
  if (COMPLETE_STATUS_HINTS.some((h) => raw.includes(h))) return 'COMPLETED';
  if (eventType === 'APPOINTMENT_CANCELLED') return 'CANCELLED';
  return 'SCHEDULED';
}

// The idempotency key when the payload carries no event_id of its own —
// deterministic, so a byte-identical redelivery collides on
// HighLevelWebhookEvent's unique id instead of double-processing.
function computeFallbackEventId({ vendorId, bookingId, eventType, updatedAt }) {
  return crypto.createHash('sha256').update(`${vendorId}:${eventType}:${bookingId}:${updatedAt || ''}`).digest('hex');
}

// vendor: the full Vendor row (req.vendor from requireVendorAuth).
// data: the validated webhook body (see routes/highlevelWebhook.js's zod schema).
// resolvedUpdatedAt: a real Date — the authoritative event timestamp the
// out-of-order guard compares against (falls back to "now" at the route
// layer when the payload has none, a documented reduced-safety case).
async function applyHighLevelAppointmentEvent({ vendor, data, resolvedUpdatedAt }) {
  return prisma.$transaction(async (tx) => {
    // ---- 1. Find-or-advance the Lead, keyed on (vendorId, externalLeadId=contact_id) ----
    let lead = await tx.lead.findUnique({
      where: { vendorId_externalLeadId: { vendorId: vendor.id, externalLeadId: data.contact_id } },
    });

    if (!lead) {
      const phoneNormalized = normalizePhone(data.contact_phone);
      const email = normalizeEmail(data.contact_email);
      let customer = null;
      if (phoneNormalized || email) {
        customer = await tx.customer.findFirst({
          where: { OR: [phoneNormalized ? { phoneNormalized } : undefined, email ? { email } : undefined].filter(Boolean) },
        });
      }
      if (!customer) {
        customer = await tx.customer.create({
          data: {
            firstName: data.contact_first_name || 'Unknown',
            lastName: data.contact_last_name || 'Unknown',
            phoneNormalized,
            email,
          },
        });
      }

      // Phone-level TCPA suppression — same check vendorApi.js's lead-POST
      // path already makes. A suppressed customer's booking still lands
      // (the appointment itself already happened/was scheduled) but is
      // never distributed to a producer.
      const isSuppressed = customer.doNotContact;
      const assignment = isSuppressed
        ? { assignedToId: null, mode: null, reason: 'Customer is DO_NOT_CONTACT — not distributed' }
        : await resolveVendorAssignment(tx, vendor, { lastName: customer.lastName });

      lead = await tx.lead.create({
        data: {
          agencyId: vendor.agencyId,
          customerId: customer.id,
          vendorId: vendor.id,
          externalLeadId: data.contact_id,
          source: `vendor:${vendor.name}`,
          product: vendor.product,
          status: isSuppressed ? 'DO_NOT_CONTACT' : 'APPOINTMENT',
          archivedAt: isSuppressed ? new Date() : null,
          assignedToId: assignment.assignedToId,
          assignedAt: assignment.assignedToId ? new Date() : null,
          leadType: deriveLeadType({ vendorIntegrationType: vendor.integrationType, vendorCategory: vendor.category }),
        },
      });

      const agencyRow = await tx.agency.findUnique({ where: { id: vendor.agencyId }, select: { priorityRules: true } });
      const { priorityScore, priorityReason } = scoreLead(lead, agencyRow?.priorityRules);
      lead = await tx.lead.update({ where: { id: lead.id }, data: { priorityScore, priorityReason } });

      await tx.leadEvent.create({
        data: {
          leadId: lead.id,
          type: 'lead.created.highlevel_booking',
          toStatus: lead.status,
          metadata: {
            vendorId: vendor.id, bookingId: data.booking_id, distributionMode: assignment.mode, distributionReason: assignment.reason,
            ...(isSuppressed ? { suppressedReason: customer.doNotContactReason || 'Customer marked DO_NOT_CONTACT' } : {}),
          },
        },
      });
    } else if (ADVANCEABLE_LEAD_STATUSES.includes(lead.status)) {
      const previousStatus = lead.status;
      lead = await tx.lead.update({ where: { id: lead.id }, data: { status: 'APPOINTMENT' } });
      await tx.leadEvent.create({
        data: {
          leadId: lead.id,
          type: 'lead.status_auto_advanced',
          fromStatus: previousStatus,
          toStatus: 'APPOINTMENT',
          metadata: { reason: 'highlevel_booking_event', bookingId: data.booking_id },
        },
      });
    }
    // Lead.assignedAt/firstAttemptAt/firstContactAt are never touched on
    // either branch above — only ever set at first-creation time.

    // ---- 2. Find-or-update the Appointment, keyed on (vendorId, providerBookingId) ----
    const normalizedStatus = mapAppointmentStatus(data.event_type, data.status);
    const existing = await tx.appointment.findUnique({
      where: { vendorId_providerBookingId: { vendorId: vendor.id, providerBookingId: data.booking_id } },
    });

    const isStale = !!(existing && existing.providerUpdatedAt && resolvedUpdatedAt
      && resolvedUpdatedAt.getTime() <= existing.providerUpdatedAt.getTime());

    let appointment;
    let task = null;

    if (!existing) {
      const contactName = `${data.contact_first_name || ''} ${data.contact_last_name || ''}`.trim() || 'After-hours appointment';
      task = await tx.task.create({
        data: {
          agencyId: vendor.agencyId,
          leadId: lead.id,
          type: 'APPOINTMENT',
          title: `After Hours Appts — ${contactName}`,
          dueAt: new Date(data.start_time),
          assignedToId: lead.assignedToId,
          status: normalizedStatus === 'CANCELLED' ? 'CANCELLED' : 'OPEN',
        },
      });

      appointment = await tx.appointment.create({
        data: {
          agencyId: vendor.agencyId,
          leadId: lead.id,
          vendorId: vendor.id,
          taskId: task.id,
          providerLocationId: data.location_id,
          providerCalendarId: data.calendar_id,
          providerBookingId: data.booking_id,
          providerContactId: data.contact_id,
          startAt: new Date(data.start_time),
          endAt: new Date(data.end_time),
          timeZone: data.time_zone || 'America/New_York',
          status: normalizedStatus,
          providerStatus: data.status || null,
          providerUpdatedAt: resolvedUpdatedAt,
          hostExternalName: data.assigned_user_id || null,
          assignedToId: lead.assignedToId,
          syncStatus: lead.assignedToId ? 'OK' : 'NEEDS_ATTENTION',
          syncIssue: lead.assignedToId ? null : 'NO_ELIGIBLE_ASSIGNEE',
        },
      });

      await recordAudit({
        agencyId: vendor.agencyId, action: 'appointment.created', entityType: 'Appointment', entityId: appointment.id,
        after: { leadId: lead.id, bookingId: data.booking_id, status: normalizedStatus },
      });

      if (!lead.assignedToId) {
        await notifyAgencyOwners(vendor.agencyId, {
          type: 'appointment.needs_attention',
          severity: 'WARNING',
          title: 'New After Hours appointment has no assignee',
          body: `A booking from ${vendor.name} has no eligible producer to assign — needs manual resolution.`,
          relatedEntityType: 'Appointment',
          relatedEntityId: appointment.id,
        });
      } else {
        await notifyUser({
          userId: lead.assignedToId,
          agencyId: vendor.agencyId,
          type: 'appointment.assigned',
          severity: 'INFO',
          title: 'New appointment assigned to you',
          body: `${contactName} — booked via ${vendor.name}`,
          relatedEntityType: 'Appointment',
          relatedEntityId: appointment.id,
        });
      }
    } else if (isStale) {
      // Out-of-order/stale event — never mutate status/times. Flagged for
      // visibility (per "failed syncs must be visible to the owner")
      // rather than silently dropped, since the live HighLevel timestamp
      // field is unverified at this stage.
      appointment = await tx.appointment.update({
        where: { id: existing.id },
        data: {
          syncStatus: 'NEEDS_ATTENTION',
          syncIssue: `Stale/out-of-order event ignored (incoming ${resolvedUpdatedAt ? resolvedUpdatedAt.toISOString() : 'unknown'} <= applied ${existing.providerUpdatedAt.toISOString()})`,
        },
      });
      await notifyAgencyOwners(vendor.agencyId, {
        type: 'appointment.needs_attention',
        severity: 'WARNING',
        title: 'Out-of-order appointment update ignored',
        body: `An update for a booking from ${vendor.name} arrived out of order and was not applied — review this appointment.`,
        relatedEntityType: 'Appointment',
        relatedEntityId: appointment.id,
      });
      if (existing.taskId) task = await tx.task.findUnique({ where: { id: existing.taskId } });
    } else {
      const wasCancelled = existing.status === 'CANCELLED';
      const updateData = {
        startAt: new Date(data.start_time),
        endAt: new Date(data.end_time),
        timeZone: data.time_zone || existing.timeZone,
        status: normalizedStatus,
        providerStatus: data.status || null,
        providerUpdatedAt: resolvedUpdatedAt,
        hostExternalName: data.assigned_user_id || existing.hostExternalName,
        syncStatus: 'OK',
        syncIssue: null,
      };
      if (normalizedStatus === 'CANCELLED') updateData.cancelledAt = new Date();
      if (data.event_type === 'APPOINTMENT_RESCHEDULED') updateData.rescheduledAt = new Date();

      appointment = await tx.appointment.update({ where: { id: existing.id }, data: updateData });

      if (existing.taskId) {
        const taskUpdate = { dueAt: new Date(data.start_time) };
        if (normalizedStatus === 'CANCELLED') {
          taskUpdate.status = 'CANCELLED';
        } else if (normalizedStatus === 'COMPLETED') {
          taskUpdate.status = 'COMPLETED';
          taskUpdate.completedAt = new Date();
        } else if (wasCancelled) {
          // A later, newer event un-cancels a previously-cancelled booking.
          taskUpdate.status = 'OPEN';
        }
        task = await tx.task.update({ where: { id: existing.taskId }, data: taskUpdate });
      }

      await recordAudit({
        agencyId: vendor.agencyId, action: 'appointment.updated', entityType: 'Appointment', entityId: appointment.id,
        before: { status: existing.status, startAt: existing.startAt },
        after: { status: normalizedStatus, startAt: data.start_time },
        metadata: { eventType: data.event_type },
      });

      if (appointment.assignedToId) {
        await notifyUser({
          userId: appointment.assignedToId,
          agencyId: vendor.agencyId,
          type: 'appointment.updated',
          severity: normalizedStatus === 'CANCELLED' ? 'WARNING' : 'INFO',
          title: normalizedStatus === 'CANCELLED' ? 'Appointment cancelled' : 'Appointment updated',
          body: `Booking via ${vendor.name} was ${data.event_type === 'APPOINTMENT_RESCHEDULED' ? 'rescheduled' : 'updated'}.`,
          relatedEntityType: 'Appointment',
          relatedEntityId: appointment.id,
        });
      }
    }

    return { lead, appointment, task, outOfOrder: isStale };
  });
}

module.exports = {
  mapAppointmentStatus,
  computeFallbackEventId,
  applyHighLevelAppointmentEvent,
  ADVANCEABLE_LEAD_STATUSES,
};
