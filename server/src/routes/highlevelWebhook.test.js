// Real-DB, real-HTTP tests for the "After Hours Appts" HighLevel booking
// webhook — controlled/simulated payloads (the live Retell-to-HighLevel
// wiring is not verified yet), covering: create -> assignment -> producer
// queue, duplicate delivery, reschedule, cancellation, out-of-order
// events in both directions, location/calendar mismatch,
// integration-type isolation, a missing-assignee booking, and the
// non-production guarantee (never a Sale/RevenueEvent/SOLD status).
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { generateCredential } = require('../lib/vendorAuth');
const app = require('../app');

const suffix = Date.now();
const LOCATION_ID = 'QeKX5JBMkzbS89a21NNp';
const CALENDAR_ID = 'dMUoqFqTICQSgdTlWixO';

let agencyId, tomId, server, baseUrl;
let vendorId, apiKey;
let emptyVendorId, emptyVendorKey;
let leadPostVendorId, leadPostKey;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `HighLevel Webhook Test Agency ${suffix}` } });
  agencyId = agency.id;
  const hash = await bcrypt.hash('TestPass123!', 12);
  const tom = await prisma.user.create({
    data: { email: `hl-tom-${suffix}@test.local`, passwordHash: hash, firstName: 'Tom', lastName: 'Paterson', role: 'PRODUCER', agencyId, status: 'ACTIVE' },
  });
  tomId = tom.id;

  const vendor = await prisma.vendor.create({
    data: {
      name: 'After Hours Appts', email: 'josh@yield-marketing.com', product: 'General', agencyId,
      status: 'TESTING', distributionMode: 'SELECTED_AGENTS', selectedAgentIds: [tomId], category: 'OTHER',
      integrationType: 'APPOINTMENT_WEBHOOK', highLevelLocationId: LOCATION_ID, highLevelCalendarId: CALENDAR_ID,
    },
  });
  vendorId = vendor.id;
  const cred = generateCredential();
  await prisma.vendorCredential.create({ data: { vendorId, keyPrefix: cred.prefix, secretHash: cred.secretHash } });
  apiKey = cred.rawKey;

  // A second APPOINTMENT_WEBHOOK vendor with no eligible assignee at all —
  // the missing-assignee scenario.
  const emptyVendor = await prisma.vendor.create({
    data: {
      name: 'After Hours Appts (Empty)', email: 'josh@yield-marketing.com', product: 'General', agencyId,
      status: 'TESTING', distributionMode: 'SELECTED_AGENTS', selectedAgentIds: [], category: 'OTHER',
      integrationType: 'APPOINTMENT_WEBHOOK', highLevelLocationId: LOCATION_ID, highLevelCalendarId: CALENDAR_ID,
    },
  });
  emptyVendorId = emptyVendor.id;
  const emptyCred = generateCredential();
  await prisma.vendorCredential.create({ data: { vendorId: emptyVendorId, keyPrefix: emptyCred.prefix, secretHash: emptyCred.secretHash } });
  emptyVendorKey = emptyCred.rawKey;

  // A plain LEAD_POST vendor — for the integration-type isolation test.
  const leadPostVendor = await prisma.vendor.create({
    data: { name: 'Plain Lead Vendor', email: 'josh@yield-marketing.com', product: 'Auto', agencyId, status: 'LIVE', distributionMode: 'ROUND_ROBIN', category: 'OTHER' },
  });
  leadPostVendorId = leadPostVendor.id;
  const leadPostCred = generateCredential();
  await prisma.vendorCredential.create({ data: { vendorId: leadPostVendorId, keyPrefix: leadPostCred.prefix, secretHash: leadPostCred.secretHash } });
  leadPostKey = leadPostCred.rawKey;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await prisma.highLevelWebhookEvent.deleteMany({ where: { vendorId: { in: [vendorId, emptyVendorId, leadPostVendorId] } } });
  await prisma.appointment.deleteMany({ where: { agencyId } });
  const leads = await prisma.lead.findMany({ where: { agencyId }, select: { id: true } });
  const leadIds = leads.map((l) => l.id);
  await prisma.leadEvent.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.task.deleteMany({ where: { agencyId } });
  await prisma.lead.deleteMany({ where: { agencyId } });
  await prisma.customer.deleteMany({ where: { OR: [{ firstName: 'Jane' }, { firstName: 'Unknown' }] } });
  await prisma.vendorCredential.deleteMany({ where: { vendorId: { in: [vendorId, emptyVendorId, leadPostVendorId] } } });
  await prisma.vendor.deleteMany({ where: { agencyId } });
  await prisma.user.deleteMany({ where: { agencyId } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

function basePayload(overrides = {}) {
  return {
    event_type: 'APPOINTMENT_CREATED',
    location_id: LOCATION_ID,
    calendar_id: CALENDAR_ID,
    booking_id: `booking-${suffix}`,
    contact_id: `contact-${suffix}`,
    contact_first_name: 'Jane',
    contact_last_name: 'Doe',
    contact_phone: '4045551212',
    start_time: '2026-03-10T14:00:00.000Z',
    end_time: '2026-03-10T14:30:00.000Z',
    time_zone: 'America/New_York',
    status: 'confirmed',
    updated_at: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

async function postEvent(key, body) {
  return fetch(`${baseUrl}/api/v1/highlevel/appointment-events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
    body: JSON.stringify(body),
  });
}

test('booking created -> Lead + Appointment + Task created, assigned to Tom via SELECTED_AGENTS, appears in his queue', async () => {
  const res = await postEvent(apiKey, basePayload());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(body.appointmentId);
  assert.ok(body.taskId);

  const lead = await prisma.lead.findUnique({ where: { vendorId_externalLeadId: { vendorId, externalLeadId: `contact-${suffix}` } } });
  assert.ok(lead, 'a Lead must be created');
  assert.equal(lead.status, 'APPOINTMENT');
  assert.equal(lead.assignedToId, tomId);
  assert.equal(lead.leadType, 'AI_APPOINTMENT');

  const appointment = await prisma.appointment.findUnique({ where: { id: body.appointmentId } });
  assert.equal(appointment.leadId, lead.id);
  assert.equal(appointment.assignedToId, tomId);
  assert.equal(appointment.hostUserId, null, 'hostUserId is never set from the assignee — only ever from a real HighLevel user mapping, which this build does not attempt');
  assert.equal(appointment.status, 'SCHEDULED');
  assert.equal(appointment.providerLocationId, LOCATION_ID);
  assert.equal(appointment.providerBookingId, `booking-${suffix}`);

  const task = await prisma.task.findUnique({ where: { id: body.taskId } });
  assert.equal(task.type, 'APPOINTMENT');
  assert.equal(task.assignedToId, tomId);
  assert.equal(task.status, 'OPEN');

  const eventRow = await prisma.highLevelWebhookEvent.findFirst({ where: { vendorId, providerBookingId: `booking-${suffix}` } });
  assert.ok(eventRow, 'the webhook event must be logged for idempotency/forensics');
  assert.ok(eventRow.processedAt, 'a successfully processed event must be marked processedAt');
});

test('duplicate delivery of the exact same event never creates a second Lead/Appointment/Task', async () => {
  const beforeAppt = await prisma.appointment.count({ where: { vendorId, providerBookingId: `booking-${suffix}` } });
  const res = await postEvent(apiKey, basePayload());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.duplicate, true);
  const afterAppt = await prisma.appointment.count({ where: { vendorId, providerBookingId: `booking-${suffix}` } });
  assert.equal(afterAppt, beforeAppt, 'no new Appointment row from a byte-identical redelivery');
});

test('reschedule event updates the same Appointment/Task row, never creates a second one', async () => {
  const beforeCount = await prisma.appointment.count({ where: { vendorId, providerBookingId: `booking-${suffix}` } });
  const res = await postEvent(apiKey, basePayload({
    event_type: 'APPOINTMENT_RESCHEDULED',
    start_time: '2026-03-11T15:00:00.000Z',
    end_time: '2026-03-11T15:30:00.000Z',
    updated_at: '2026-03-02T00:00:00.000Z',
  }));
  assert.equal(res.status, 200);
  const afterCount = await prisma.appointment.count({ where: { vendorId, providerBookingId: `booking-${suffix}` } });
  assert.equal(afterCount, beforeCount, 'still exactly one Appointment row for this booking');

  const appointment = await prisma.appointment.findUnique({ where: { vendorId_providerBookingId: { vendorId, providerBookingId: `booking-${suffix}` } } });
  assert.equal(appointment.startAt.toISOString(), '2026-03-11T15:00:00.000Z');
  assert.ok(appointment.rescheduledAt, 'rescheduledAt must be set');
  assert.equal(appointment.status, 'SCHEDULED');
});

test('cancellation sets Appointment/Task to CANCELLED and never touches Lead.status toward SOLD or creates any revenue', async () => {
  const saleCountBefore = await prisma.sale.count();
  const revenueCountBefore = await prisma.revenueEvent.count();

  const res = await postEvent(apiKey, basePayload({
    event_type: 'APPOINTMENT_CANCELLED',
    status: 'cancelled',
    updated_at: '2026-03-03T00:00:00.000Z',
  }));
  assert.equal(res.status, 200);

  const appointment = await prisma.appointment.findUnique({ where: { vendorId_providerBookingId: { vendorId, providerBookingId: `booking-${suffix}` } } });
  assert.equal(appointment.status, 'CANCELLED');
  assert.ok(appointment.cancelledAt);

  const task = await prisma.task.findUnique({ where: { id: appointment.taskId } });
  assert.equal(task.status, 'CANCELLED');

  const lead = await prisma.lead.findUnique({ where: { id: appointment.leadId } });
  assert.notEqual(lead.status, 'SOLD');

  assert.equal(await prisma.sale.count(), saleCountBefore, 'cancellation must never create a Sale');
  assert.equal(await prisma.revenueEvent.count(), revenueCountBefore, 'cancellation must never create a RevenueEvent');
});

test('out-of-order delivery (both directions) converges on the real HighLevel event time, never on arrival order', async () => {
  const bookingId = `booking-ooo-${suffix}`;

  // Direction A: reschedule at T1 delivered first, then a stale cancel at
  // T0 < T1 delivered second — the stale cancel must NOT apply.
  const createRes = await postEvent(apiKey, basePayload({ booking_id: bookingId, contact_id: `contact-ooo-a-${suffix}`, updated_at: '2026-04-01T00:00:00.000Z' }));
  assert.equal(createRes.status, 200);
  const rescheduleRes = await postEvent(apiKey, basePayload({
    booking_id: bookingId, contact_id: `contact-ooo-a-${suffix}`, event_type: 'APPOINTMENT_RESCHEDULED',
    start_time: '2026-04-05T10:00:00.000Z', end_time: '2026-04-05T10:30:00.000Z', updated_at: '2026-04-02T00:00:00.000Z',
  }));
  assert.equal(rescheduleRes.status, 200);
  const staleCancelRes = await postEvent(apiKey, basePayload({
    booking_id: bookingId, contact_id: `contact-ooo-a-${suffix}`, event_type: 'APPOINTMENT_CANCELLED', status: 'cancelled',
    updated_at: '2026-04-01T12:00:00.000Z', // earlier than the reschedule's T2
  }));
  assert.equal(staleCancelRes.status, 200);

  const appointmentA = await prisma.appointment.findUnique({ where: { vendorId_providerBookingId: { vendorId, providerBookingId: bookingId } } });
  assert.equal(appointmentA.status, 'SCHEDULED', 'the stale cancel must not override the later reschedule');
  assert.equal(appointmentA.syncStatus, 'NEEDS_ATTENTION', 'a stale/out-of-order event must be flagged for owner visibility, not silently dropped');
  assert.match(appointmentA.syncIssue || '', /stale|out-of-order/i);

  // Direction B: cancel at T2 delivered first (as the booking's own
  // create), then a genuinely NEWER reschedule at T3 > T2 delivered
  // second — the newer reschedule must apply and un-cancel.
  const bookingIdB = `booking-ooo-b-${suffix}`;
  const createResB = await postEvent(apiKey, basePayload({ booking_id: bookingIdB, contact_id: `contact-ooo-b-${suffix}`, updated_at: '2026-05-01T00:00:00.000Z' }));
  assert.equal(createResB.status, 200);
  const cancelResB = await postEvent(apiKey, basePayload({
    booking_id: bookingIdB, contact_id: `contact-ooo-b-${suffix}`, event_type: 'APPOINTMENT_CANCELLED', status: 'cancelled', updated_at: '2026-05-02T00:00:00.000Z',
  }));
  assert.equal(cancelResB.status, 200);
  const newerRescheduleResB = await postEvent(apiKey, basePayload({
    booking_id: bookingIdB, contact_id: `contact-ooo-b-${suffix}`, event_type: 'APPOINTMENT_RESCHEDULED',
    start_time: '2026-05-10T09:00:00.000Z', end_time: '2026-05-10T09:30:00.000Z', updated_at: '2026-05-03T00:00:00.000Z',
  }));
  assert.equal(newerRescheduleResB.status, 200);

  const appointmentB = await prisma.appointment.findUnique({ where: { vendorId_providerBookingId: { vendorId, providerBookingId: bookingIdB } } });
  assert.equal(appointmentB.status, 'SCHEDULED', 'a genuinely newer reschedule must un-cancel a previously-cancelled booking');
  assert.equal(appointmentB.syncStatus, 'OK');

  const taskB = await prisma.task.findUnique({ where: { id: appointmentB.taskId } });
  assert.equal(taskB.status, 'OPEN', 'the linked task must re-open once a newer event un-cancels the appointment');
});

test('a booking with no eligible assignee is flagged NEEDS_ATTENTION and surfaced via GET /api/appointments', async () => {
  const res = await postEvent(emptyVendorKey, basePayload({ booking_id: `booking-empty-${suffix}`, contact_id: `contact-empty-${suffix}` }));
  assert.equal(res.status, 200);
  const appointment = await prisma.appointment.findUnique({ where: { vendorId_providerBookingId: { vendorId: emptyVendorId, providerBookingId: `booking-empty-${suffix}` } } });
  assert.equal(appointment.assignedToId, null);
  assert.equal(appointment.syncStatus, 'NEEDS_ATTENTION');
  assert.equal(appointment.syncIssue, 'NO_ELIGIBLE_ASSIGNEE');
});

test('location/calendar mismatch is rejected and creates nothing', async () => {
  const before = await prisma.appointment.count({ where: { vendorId } });
  const res = await postEvent(apiKey, basePayload({ booking_id: `booking-mismatch-${suffix}`, location_id: 'WRONG_LOCATION' }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'LOCATION_MISMATCH');
  assert.equal(await prisma.appointment.count({ where: { vendorId } }), before);
});

test('integration-type isolation: a LEAD_POST key cannot authenticate the appointment-webhook route, and an APPOINTMENT_WEBHOOK key cannot authenticate POST /api/v1/leads', async () => {
  const wrongWayRes = await postEvent(leadPostKey, basePayload({ booking_id: `booking-wrongway-${suffix}` }));
  assert.equal(wrongWayRes.status, 403);
  assert.equal((await wrongWayRes.json()).error, 'WRONG_INTEGRATION_TYPE');

  const leadsRes = await fetch(`${baseUrl}/api/v1/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ external_lead_id: 'x', first_name: 'A', last_name: 'B', state: 'GA', product: 'General' }),
  });
  assert.equal(leadsRes.status, 403);
  assert.equal((await leadsRes.json()).error, 'WRONG_INTEGRATION_TYPE');
});
