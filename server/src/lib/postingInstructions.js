// Generates vendor-facing posting instructions directly from the canonical
// lead payload shape used by the real POST /api/v1/leads validator
// (see routes/vendorApi.js -> postSchema). If that schema changes, this
// documentation changes with it automatically since it draws from the same
// field list rather than being maintained by hand.

const CANONICAL_FIELDS = [
  { name: 'external_lead_id', type: 'string', required: true, note: 'Your unique ID for this lead. Used for idempotency.' },
  { name: 'first_name', type: 'string', required: true },
  { name: 'last_name', type: 'string', required: true },
  { name: 'phone', type: 'string', required: false },
  { name: 'email', type: 'string', required: false },
  { name: 'state', type: 'string (2-letter)', required: true },
  { name: 'zip', type: 'string', required: false },
  { name: 'product', type: 'string', required: true, note: 'Must match this vendor connection\'s configured product.' },
  { name: 'current_carrier', type: 'string', required: false },
  { name: 'consent_timestamp', type: 'ISO 8601 datetime', required: false },
  { name: 'source', type: 'string', required: false },
  { name: 'sub_id', type: 'string', required: false },
];

function buildPostingInstructions({ vendor, credential, appApiUrl }) {
  const endpoint = `${appApiUrl}/api/v1/leads`;
  const exampleBody = {
    external_lead_id: 'vendor-lead-12345',
    first_name: 'Jane',
    last_name: 'Doe',
    phone: '4045551212',
    email: 'jane@example.com',
    state: 'GA',
    zip: '30301',
    product: vendor.product,
    current_carrier: 'Progressive',
    consent_timestamp: new Date().toISOString(),
    source: vendor.name,
  };

  const curlExample = `curl -X POST '${endpoint}' \\
  -H 'Content-Type: application/json' \\
  -H 'X-Api-Key: ${credential ? credential.rawKey : '<YOUR_API_KEY>'}' \\
  -d '${JSON.stringify(exampleBody)}'`;

  return {
    vendorName: vendor.name,
    product: vendor.product,
    environment: 'production',
    endpoint,
    method: 'POST',
    contentType: 'application/json',
    authentication: 'Header: X-Api-Key: <prefix>.<secret> (shown once at credential creation; store it securely)',
    fields: CANONICAL_FIELDS,
    exampleBody,
    curlExample,
    responses: {
      success: { success: true, lead_id: '<uuid>', status: 'NEW', timestamp: '<ISO datetime>' },
      validation_error: { success: false, error: 'VALIDATION', field_errors: { first_name: ['Required'] } },
      duplicate: { success: false, error: 'DUPLICATE', duplicate: true, existing_lead_id: '<uuid>' },
      auth_error: { success: false, error: 'UNAUTHORIZED' },
      rate_limited: { success: false, error: 'RATE_LIMITED' },
      server_error: { success: false, error: 'INTERNAL_ERROR', correlation_id: '<uuid>' },
    },
    testProcedure: [
      'Send one test lead using the curl example above with a unique external_lead_id.',
      'Confirm you receive a 201 response with success:true and a lead_id.',
      "Resubmit the exact same request; you should receive success:false, error:'DUPLICATE' rather than a second lead.",
      'Contact your EvenFlow account contact to move this connection from TESTING to LIVE.',
    ],
  };
}

// Sibling to buildPostingInstructions above, for a vendor whose
// integrationType is APPOINTMENT_WEBHOOK (an external calendar/booking
// provider, e.g. HighLevel) instead of a lead-POST source. Documents the
// POST /api/v1/highlevel/appointment-events contract this app itself
// defines (see routes/highlevelWebhook.js) — distinct endpoint, distinct
// payload shape, same X-Api-Key auth mechanism.
const APPOINTMENT_EVENT_FIELDS = [
  { name: 'event_id', type: 'string', required: false, note: 'Your own unique id for this delivery, if available — strengthens duplicate detection.' },
  { name: 'event_type', type: "'APPOINTMENT_CREATED' | 'APPOINTMENT_RESCHEDULED' | 'APPOINTMENT_CANCELLED' | 'APPOINTMENT_UPDATED'", required: true },
  { name: 'location_id', type: 'string', required: true, note: 'Must match this vendor connection\'s configured HighLevel location.' },
  { name: 'calendar_id', type: 'string', required: true, note: 'Must match this vendor connection\'s configured HighLevel calendar.' },
  { name: 'booking_id', type: 'string', required: true, note: 'HighLevel\'s own appointment id — identifies one booking across create/reschedule/cancel.' },
  { name: 'contact_id', type: 'string', required: true, note: 'HighLevel\'s contact id for the booked person.' },
  { name: 'contact_first_name', type: 'string', required: false },
  { name: 'contact_last_name', type: 'string', required: false },
  { name: 'contact_phone', type: 'string', required: false },
  { name: 'contact_email', type: 'string', required: false },
  { name: 'start_time', type: 'ISO 8601 datetime', required: true },
  { name: 'end_time', type: 'ISO 8601 datetime', required: true },
  { name: 'time_zone', type: 'string (IANA zone)', required: false },
  { name: 'status', type: 'string', required: false, note: 'Raw calendar status text (e.g. confirmed, cancelled, showed, noshow).' },
  { name: 'assigned_user_id', type: 'string', required: false, note: 'HighLevel\'s own id for the calendar host — informational only, never changed by EvenFlow.' },
  { name: 'updated_at', type: 'ISO 8601 datetime', required: false, note: 'The real event timestamp. Strongly recommended — without it, out-of-order deliveries are resolved by arrival order instead of true event time.' },
];

function buildAppointmentWebhookInstructions({ vendor, credential, appApiUrl }) {
  const endpoint = `${appApiUrl}/api/v1/highlevel/appointment-events`;
  const exampleBody = {
    event_id: 'evt-98765',
    event_type: 'APPOINTMENT_CREATED',
    location_id: vendor.highLevelLocationId || '<HIGHLEVEL_LOCATION_ID>',
    calendar_id: vendor.highLevelCalendarId || '<HIGHLEVEL_CALENDAR_ID>',
    booking_id: 'appt-12345',
    contact_id: 'contact-67890',
    contact_first_name: 'Jane',
    contact_last_name: 'Doe',
    contact_phone: '4045551212',
    start_time: new Date().toISOString(),
    end_time: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    time_zone: 'America/New_York',
    status: 'confirmed',
    updated_at: new Date().toISOString(),
  };

  const curlExample = `curl -X POST '${endpoint}' \\
  -H 'Content-Type: application/json' \\
  -H 'X-Api-Key: ${credential ? credential.rawKey : '<YOUR_API_KEY>'}' \\
  -d '${JSON.stringify(exampleBody)}'`;

  return {
    vendorName: vendor.name,
    integrationType: 'APPOINTMENT_WEBHOOK',
    environment: 'production',
    endpoint,
    method: 'POST',
    contentType: 'application/json',
    authentication: 'Header: X-Api-Key: <prefix>.<secret> (shown once at credential creation; store it securely). This key only authenticates appointment-webhook calls — it will not work against the lead-intake endpoint, and a lead-intake key will not work here.',
    fields: APPOINTMENT_EVENT_FIELDS,
    exampleBody,
    curlExample,
    responses: {
      success: { success: true, taskId: '<uuid>' },
      duplicate: { success: true, duplicate: true },
      validation_error: { success: false, error: 'VALIDATION', fieldErrors: { event_type: ['Required'] } },
      location_mismatch: { success: false, error: 'LOCATION_MISMATCH' },
      calendar_mismatch: { success: false, error: 'CALENDAR_MISMATCH' },
      auth_error: { success: false, error: 'UNAUTHORIZED' },
      wrong_integration: { success: false, error: 'WRONG_INTEGRATION_TYPE' },
      server_error: { success: false, error: 'INTERNAL_ERROR' },
    },
    testProcedure: [
      'Configure the HighLevel Workflow\'s Custom Webhook action to POST this exact JSON shape to the endpoint above, with the X-Api-Key header set.',
      'Trigger one test booking and confirm EvenFlow returns a 201/200 with success:true and a taskId.',
      'Resubmit the exact same event; you should receive success:true, duplicate:true rather than a second appointment.',
      'Trigger a reschedule and a cancellation on the same test booking and confirm EvenFlow\'s record updates in place rather than creating new ones.',
      'Contact your EvenFlow account contact to move this connection from TESTING to LIVE once confirmed.',
    ],
  };
}

module.exports = { buildPostingInstructions, buildAppointmentWebhookInstructions };
