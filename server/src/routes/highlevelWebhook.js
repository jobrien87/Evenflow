const express = require('express');
const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');
const { prisma } = require('../lib/db');
const { requireVendorAuth, requireIntegrationType } = require('../middleware/vendorAuth');
const { checkVendorRateLimit } = require('../lib/vendorRateLimit');
const { computeFallbackEventId, applyHighLevelAppointmentEvent } = require('../lib/highLevelAppointments');

const router = express.Router();

// This app's own defined contract for the HighLevel Workflow's Custom
// Webhook action to match (the live Retell-to-HighLevel wiring is not
// verified yet, so there is no existing payload shape to conform to —
// see lib/postingInstructions.js's buildAppointmentWebhookInstructions,
// handed to whoever configures the HighLevel side).
const appointmentEventSchema = z.object({
  event_id: z.string().min(1).optional(),
  event_type: z.enum(['APPOINTMENT_CREATED', 'APPOINTMENT_RESCHEDULED', 'APPOINTMENT_CANCELLED', 'APPOINTMENT_UPDATED']),
  location_id: z.string().min(1),
  calendar_id: z.string().min(1),
  booking_id: z.string().min(1),
  contact_id: z.string().min(1),
  contact_first_name: z.string().optional(),
  contact_last_name: z.string().optional(),
  contact_phone: z.string().optional(),
  contact_email: z.string().email().optional(),
  start_time: z.string().datetime(),
  end_time: z.string().datetime(),
  time_zone: z.string().optional(),
  status: z.string().optional(),
  assigned_user_id: z.string().optional(),
  // The authoritative event timestamp the out-of-order guard depends on.
  // Strongly recommended but optional — see the honest degradation note
  // below when it's missing.
  updated_at: z.string().datetime().optional(),
});

// POST /api/v1/highlevel/appointment-events — inbound booking sync.
// Scoped to APPOINTMENT_WEBHOOK credentials only (requireIntegrationType)
// so a leaked lead-intake key can never authenticate here, and vice versa.
router.post('/highlevel/appointment-events', requireVendorAuth, requireIntegrationType('APPOINTMENT_WEBHOOK'), async (req, res) => {
  const correlationId = req.correlationId || uuidv4();

  if (!checkVendorRateLimit(req.vendor.id)) {
    return res.status(429).json({ success: false, error: 'RATE_LIMITED', correlation_id: correlationId });
  }

  const parsed = appointmentEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten(), correlation_id: correlationId });
  }
  const data = parsed.data;

  if (req.vendor.highLevelLocationId && data.location_id !== req.vendor.highLevelLocationId) {
    return res.status(400).json({ success: false, error: 'LOCATION_MISMATCH', correlation_id: correlationId });
  }
  if (req.vendor.highLevelCalendarId && data.calendar_id !== req.vendor.highLevelCalendarId) {
    return res.status(400).json({ success: false, error: 'CALENDAR_MISMATCH', correlation_id: correlationId });
  }

  // Honest degradation: without a real updated_at from HighLevel, the
  // out-of-order guard falls back to receipt time — correct only when
  // delivery order matches real event order. Flagged in the plan as a
  // risk to confirm once this is verified live; never silently assumed
  // to be as safe as a real event timestamp.
  const resolvedUpdatedAt = data.updated_at ? new Date(data.updated_at) : new Date();
  const eventId = data.event_id?.trim() || computeFallbackEventId({
    vendorId: req.vendor.id, bookingId: data.booking_id, eventType: data.event_type, updatedAt: data.updated_at,
  });

  // Unconditional receipt log, written before business logic — the
  // durable, owner-visible forensic record a failed/duplicate delivery
  // leaves behind. A P2002 collision means this exact event id was
  // already seen; if it already finished processing, this is a true
  // no-op. If the prior attempt failed or never finished, re-running the
  // business logic below is safe since it's a convergent find-or-update
  // keyed on (vendorId, providerBookingId), never a blind insert.
  let eventRow;
  try {
    eventRow = await prisma.highLevelWebhookEvent.create({
      data: { id: eventId, vendorId: req.vendor.id, type: data.event_type, providerBookingId: data.booking_id, payload: req.body },
    });
  } catch (err) {
    if (err.code !== 'P2002') throw err;
    eventRow = await prisma.highLevelWebhookEvent.findUnique({ where: { id: eventId } });
    if (eventRow?.processedAt) {
      return res.status(200).json({ success: true, duplicate: true, correlation_id: correlationId });
    }
  }

  try {
    const { appointment, task } = await applyHighLevelAppointmentEvent({ vendor: req.vendor, data, resolvedUpdatedAt });
    await prisma.highLevelWebhookEvent.update({ where: { id: eventId }, data: { processedAt: new Date(), processingError: null } });
    return res.status(200).json({ success: true, appointmentId: appointment.id, taskId: task ? task.id : null, correlation_id: correlationId });
  } catch (err) {
    console.error(`[highlevelWebhook] processing failed correlationId=${correlationId}`, err);
    await prisma.highLevelWebhookEvent.update({ where: { id: eventId }, data: { processingError: err.message } }).catch(() => {});
    // Non-2xx so a retrying sender gets another chance — never ack success
    // on a thrown processing error, same discipline as the Stripe webhook.
    return res.status(500).json({ success: false, error: 'INTERNAL_ERROR', correlation_id: correlationId });
  }
});

module.exports = router;
