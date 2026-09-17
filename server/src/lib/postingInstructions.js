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

module.exports = { buildPostingInstructions };
