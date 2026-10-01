// Server-side-only client for Yield Marketing's Lead Portal (a white-labeled
// Boberdoo instance) — the ONLY place Record Store talks to it. Every method
// here corresponds to a real, documented action from
// docs/lead-portal-api-reference.md — never an invented endpoint or field.
//
// Same honest-degradation contract as every other external integration in
// this codebase (aiProvider.js, stripe.js, email.js): isConfigured() gates
// every real call, and nothing here ever fabricates a Partner ID, Filter
// Set ID, or balance when the key is unset.
//
// Transport: plain `fetch`, form-encoded POST body (per the docs' own PHP
// sample), Format=json so responses are JSON rather than XML. The API key
// is NEVER sent to the browser, logged, or echoed back in any response —
// every normalized result here strips it before returning.

const BASE_URL = process.env.BOBERDOO_API_BASE_URL || 'https://yieldmarketing.leadportal.com/new_api/api.php';

function isConfigured() {
  return !!process.env.BOBERDOO_API_KEY;
}

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

// Normalizes Boberdoo's two documented error shapes
// (`response.errors.error` and `response.error.error`, each either a single
// string or an array) plus the success case into one consistent result.
// Never throws on a business-level error — only on a real transport
// failure (network/timeout/non-2xx/unparseable body), since a business
// error (e.g. "Partner not found") is an expected, handleable outcome, not
// an exception.
async function callAction(action, params = {}) {
  if (!isConfigured()) {
    return { success: false, configured: false, errorCode: 'NOT_CONFIGURED', errorMessage: 'Boberdoo is not configured.' };
  }

  const body = new URLSearchParams();
  body.set('Key', process.env.BOBERDOO_API_KEY);
  body.set('API_Action', action);
  body.set('Format', 'json');
  for (const [field, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    body.set(field, String(value));
  }

  let res;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    res = await fetch(BASE_URL, { method: 'POST', body, signal: controller.signal });
    clearTimeout(timeout);
  } catch (err) {
    return { success: false, configured: true, errorCode: 'NETWORK_ERROR', errorMessage: err.message };
  }

  if (!res.ok) {
    return { success: false, configured: true, errorCode: 'HTTP_ERROR', errorMessage: `Boberdoo returned HTTP ${res.status}` };
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    return { success: false, configured: true, errorCode: 'BAD_RESPONSE', errorMessage: 'Boberdoo returned a non-JSON response.' };
  }

  const response = json.response || {};
  const errorBlock = response.errors || response.error;
  if (errorBlock) {
    const raw = errorBlock.error;
    const errorMessage = Array.isArray(raw) ? raw.join('; ') : (raw || 'Unknown Boberdoo error');
    return { success: false, configured: true, errorCode: 'PROVIDER_ERROR', errorMessage, raw: response };
  }

  return { success: true, configured: true, data: response, raw: response };
}

// ---- Partners -------------------------------------------------------

// createNewPartner — docs §3 "Partners". Required fields per the docs:
// Login (email), Company_Name, First_Name, Last_Name, Address, City,
// State, Country, Zip, Phone, Lead_Email, Delivery_Option.
async function createPartner({ login, companyName, firstName, lastName, address, city, state, zip, phone, leadEmail, deliveryOption = 0, country = 'United States' }) {
  const result = await callAction('createNewPartner', {
    Login: login,
    Company_Name: companyName,
    First_Name: firstName,
    Last_Name: lastName,
    Address: address,
    City: city,
    State: state,
    Country: country,
    Zip: zip,
    Phone: phone,
    Lead_Email: leadEmail,
    Delivery_Option: deliveryOption,
  });
  if (!result.success) return result;
  // The docs don't pin down the exact response key name for the new id
  // (varies by endpoint version) — check the documented aliases defensively
  // rather than assuming one.
  const partnerId = result.data.partner_id || result.data.Partner_ID || result.data.id;
  return { ...result, partnerId };
}

async function getPartnerInfo(partnerId) {
  return callAction('getPartnerInfo', { Partner_ID: partnerId });
}

// getPartnerCreditandBalance — Balance, Credit_Limit, Total_Balance,
// Unlimited_Credit. This is the ONLY source of truth for "has the deposit
// actually landed" — never inferred from a redirect or a button click.
async function getPartnerBalance(partnerId) {
  const result = await callAction('getPartnerCreditandBalance', { Partner_ID: partnerId });
  if (!result.success) return result;
  const d = result.data;
  const toCents = (v) => (v === undefined || v === null || v === '' ? null : Math.round(parseFloat(v) * 100));
  return {
    ...result,
    balanceCents: toCents(d.Balance ?? d.balance),
    creditLimitCents: toCents(d.Credit_Limit ?? d.credit_limit),
    totalBalanceCents: toCents(d.Total_Balance ?? d.total_balance),
    unlimitedCredit: String(d.Unlimited_Credit ?? d.unlimited_credit).toLowerCase() === 'yes',
  };
}

// setPartnerStatus — 0 Not Active / 1 Temporarily Stopped / 2 Active.
async function setPartnerStatus(partnerId, status, statusReason = '') {
  return callAction('setPartnerStatus', { Partner_ID: partnerId, Status: status, Status_Reason: statusReason });
}

// ---- Standard (non-IPR) filter sets -----------------------------------
// insertUpdateFilterSet's full field list isn't fully documented (see
// docs/lead-portal-api-reference.md §3's own note: "re-fetch the real
// field list before building"). Rather than guess at field names, this
// forwards exactly whatever a Super Admin has entered in the owning
// template's configurationJson — never an invented field — plus the
// handful of values every create/update genuinely needs (Partner_ID,
// Filter_Set_ID for updates, and the one documented response field,
// filter_set_ID).
async function createFilterSet(partnerId, templateFields = {}) {
  const result = await callAction('insertUpdateFilterSet', { Partner_ID: partnerId, ...templateFields });
  if (!result.success) return result;
  const filterSetId = result.data.filter_set_ID || result.data.Filter_Set_ID || result.data.id;
  return { ...result, filterSetId };
}

async function updateFilterSet(filterSetId, fields = {}) {
  return callAction('insertUpdateFilterSet', { Filter_Set_ID: filterSetId, ...fields });
}

async function getFilterSet(filterSetId) {
  return callAction('getFilterSet', { Filter_Set_ID: filterSetId });
}

// setFilterSetStatus — 0 Not Active / 1 Active.
async function setFilterSetStatus(partnerId, filterSetId, status) {
  return callAction('setFilterSetStatus', { Partner_ID: partnerId, Filter_Set_ID: filterSetId, Status: status });
}

// Standard filter sets expose no single documented "leads per day" field
// (getFilterSet's response shows leads_per_week/leads_per_month/
// total_delivery_limit, not a flat daily cap) — per the master spec's own
// instruction, this is handled by letting the template's own
// configurationJson.volumeField name the real field to set for that
// specific template, rather than this client guessing one. Returns an
// honest NOT_CONFIGURED result (never silently no-ops) if the template
// hasn't been told which field to use yet.
async function updateFilterSetDailyVolume(filterSetId, dailyVolume, { volumeField } = {}) {
  if (!volumeField) {
    return { success: false, configured: isConfigured(), errorCode: 'VOLUME_FIELD_NOT_CONFIGURED', errorMessage: 'This product has no configured Boberdoo volume field yet.' };
  }
  return callAction('insertUpdateFilterSet', { Filter_Set_ID: filterSetId, [volumeField]: dailyVolume });
}

// ---- IPR (live call / inbound phone routing) filter sets --------------
// iprInsertFilterSet/iprUpdateFilterSet's field list IS fully documented —
// see docs/lead-portal-api-reference.md §3's IPR table. Daily_Limit is the
// real, documented volume field for these (unlike the standard filter-set
// case above).
async function createIprFilterSet(partnerId, fields = {}) {
  const result = await callAction('iprInsertFilterSet', { Partner_ID: partnerId, ...fields });
  if (!result.success) return result;
  const filterSetId = result.data.filter_set_ID || result.data.Filter_Set_ID || result.data.id;
  return { ...result, filterSetId };
}

async function updateIprFilterSet(filterSetId, fields = {}) {
  return callAction('iprUpdateFilterSet', { Filter_Set_ID: filterSetId, ...fields });
}

async function updateIprDailyVolume(filterSetId, dailyVolume) {
  return callAction('iprUpdateFilterSet', { Filter_Set_ID: filterSetId, Daily_Limit: dailyVolume });
}

async function getIprFilterSets(partnerId) {
  return callAction('iprGetFilterSets', { Partner_ID: partnerId });
}

function getPaymentPageUrl() {
  return process.env.BOBERDOO_PAYMENT_PAGE_URL || null;
}

module.exports = {
  isConfigured,
  maskKey,
  createPartner,
  getPartnerInfo,
  getPartnerBalance,
  setPartnerStatus,
  createFilterSet,
  updateFilterSet,
  getFilterSet,
  setFilterSetStatus,
  updateFilterSetDailyVolume,
  createIprFilterSet,
  updateIprFilterSet,
  updateIprDailyVolume,
  getIprFilterSets,
  getPaymentPageUrl,
};
