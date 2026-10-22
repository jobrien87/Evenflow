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
    return { success: false, configured: false, errorCode: 'NOT_CONFIGURED', errorMessage: "Record Store's lead exchange is not configured." };
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
    return { success: false, configured: true, errorCode: 'HTTP_ERROR', errorMessage: `Record Store's lead exchange returned HTTP ${res.status}` };
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    return { success: false, configured: true, errorCode: 'BAD_RESPONSE', errorMessage: "Record Store's lead exchange returned a non-JSON response." };
  }

  const response = json.response || {};
  const errorBlock = response.errors || response.error;
  if (errorBlock) {
    const raw = errorBlock.error;
    const errorMessage = Array.isArray(raw) ? raw.join('; ') : (raw || "Unknown error from Record Store's lead exchange");
    return { success: false, configured: true, errorCode: 'PROVIDER_ERROR', errorMessage, raw: response };
  }

  return { success: true, configured: true, data: response, raw: response };
}

// ---- Partners -------------------------------------------------------

// createNewPartner — docs §3 "Partners". Required fields per the docs:
// Login (email), Company_Name, First_Name, Last_Name, Address, City,
// State, Country, Zip, Phone, Lead_Email, Delivery_Option. Confirmed
// against a real account (2026-10-22): Password is also required even
// though the docs page didn't list it — see provisionPartner's comment
// for why this is always a discarded, auto-generated value rather than
// something a Partner ever logs in with.
async function createPartner({ login, companyName, firstName, lastName, address, city, state, zip, phone, leadEmail, password, deliveryOption = 0, country = 'United States' }) {
  const result = await callAction('createNewPartner', {
    Login: login,
    Password: password,
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
  // rather than assuming one. Confirmed against a real account
  // (2026-10-22): Boberdoo returns this as a JSON number, not a string —
  // every ID this client hands back is coerced to a string so it matches
  // the String columns (RecordStoreSubscription.boberdooFilterSetId,
  // Agency.boberdooPartnerId) it ultimately gets written into.
  const rawPartnerId = result.data.partner_id ?? result.data.Partner_ID ?? result.data.id;
  const partnerId = rawPartnerId === undefined || rawPartnerId === null ? null : String(rawPartnerId);
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
// insertUpdateFilterSet's full field list was NOT fully documented by the
// docs page (see docs/lead-portal-api-reference.md §3's own note) — now
// reverse-engineered against a real account (2026-10-22) by reading its
// own validation errors: Mode ("insert"/"update", same convention as
// insertUpdatePartner), Partner_ID, Client_ID (same value as Partner_ID
// in every case tested), and the lead type as TYPE. Required for every
// create: Filter_Set_Price (not "Lead_Price" — that's only the read-side
// getFilterSet field name), Accepted_Sources (comma-separated string),
// Match_Priority, Daily_Limit/Weekly_Limit/Monthly_Limit (0 = no limit),
// Accept_Only_Reprocessed_Leads ("Yes"/"No"). Confirmed NOT to work this
// way: per-lead-type qualifying criteria (e.g. driver history, home year
// built) — guessing Title_Case versions of getFilterSet's response field
// names for those was rejected outright, so templateFields/fields here
// still only carries what a Super Admin has explicitly entered, never an
// invented field, for anything beyond this confirmed core set.
async function createFilterSet(partnerId, templateFields = {}) {
  const result = await callAction('insertUpdateFilterSet', { Mode: 'insert', Partner_ID: partnerId, Client_ID: partnerId, ...templateFields });
  if (!result.success) return result;
  const rawFilterSetId = result.data.filter_set_ID ?? result.data.Filter_Set_ID ?? result.data.id;
  const filterSetId = rawFilterSetId === undefined || rawFilterSetId === null ? null : String(rawFilterSetId);
  return { ...result, filterSetId };
}

async function updateFilterSet(filterSetId, partnerId, fields = {}) {
  return callAction('insertUpdateFilterSet', { Mode: 'update', Filter_Set_ID: filterSetId, Partner_ID: partnerId, Client_ID: partnerId, ...fields });
}

async function getFilterSet(filterSetId) {
  return callAction('getFilterSet', { Filter_Set_ID: filterSetId });
}

// setFilterSetStatus — 0 Not Active / 1 Active.
async function setFilterSetStatus(partnerId, filterSetId, status) {
  return callAction('setFilterSetStatus', { Partner_ID: partnerId, Filter_Set_ID: filterSetId, Status: status });
}

// Daily_Limit is the confirmed real field (verified against a real
// account 2026-10-22, via updateFilterSet above) — getFilterSet's own
// response just doesn't happen to echo it back under that name.
async function updateFilterSetDailyVolume(filterSetId, partnerId, dailyVolume) {
  return updateFilterSet(filterSetId, partnerId, { Daily_Limit: dailyVolume });
}

// ---- IPR (live call / inbound phone routing) filter sets --------------
// iprInsertFilterSet/iprUpdateFilterSet's field list IS fully documented —
// see docs/lead-portal-api-reference.md §3's IPR table. Daily_Limit is the
// real, documented volume field for these (unlike the standard filter-set
// case above).
async function createIprFilterSet(partnerId, fields = {}) {
  const result = await callAction('iprInsertFilterSet', { Partner_ID: partnerId, ...fields });
  if (!result.success) return result;
  const rawFilterSetId = result.data.filter_set_ID ?? result.data.Filter_Set_ID ?? result.data.id;
  const filterSetId = rawFilterSetId === undefined || rawFilterSetId === null ? null : String(rawFilterSetId);
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

// ---- Vendors / sources (upstream lead origin) --------------------------
// getVendorsAndSources — docs §3 "Vendors / sources". Lists vendors and
// each vendor's sources[] (name, cost) for one lead type — the "who am I
// willing to accept leads from" list the Custom Builder's sources picker
// needs. NOTE: confirmed against the real account this app currently has
// a key for (2026-10-22) that this specific action returns "Authentication
// failed" even though Partner/Filter-Set actions on the same key work
// fine — a real permission-scope limit on that key, not a bug here. The
// caller (routes/recordStore.js) is the one place that decides what to
// show the customer when this fails; this function never fabricates a
// source list of its own.
async function getVendorsAndSources(leadTypeId) {
  const result = await callAction('getVendorsAndSources', { TYPE: leadTypeId });
  if (!result.success) return result;
  const rawVendors = result.data.vendors?.vendor;
  const vendors = (Array.isArray(rawVendors) ? rawVendors : rawVendors ? [rawVendors] : []).map((v) => {
    const rawSources = v.sources?.source;
    const sources = Array.isArray(rawSources) ? rawSources : rawSources ? [rawSources] : [];
    return { name: v.name || v.company_name, sources: sources.map((s) => ({ name: s.name, cost: s.cost })) };
  });
  return { ...result, vendors };
}

// submitPayment — docs §3/§4 "Partners". Credits (or charges) a Partner's
// balance directly; it has no concept of a card or a payment page at all.
// Real money is collected by EvenFlow's own Stripe integration first (see
// lib/stripe.js's createRecordStoreFundingCheckoutSession +
// routes/billing.js's webhook) — this call only posts the resulting
// bookkeeping entry once that charge has actually cleared. Operation_Type
// 2 ("Payment on account", a credit) is the default and the only code
// this app uses; the full code table lives in
// docs/lead-portal-api-reference.md.
async function submitPayment(partnerId, amountCents, operationType = 2) {
  const amount = (amountCents / 100).toFixed(2);
  const result = await callAction('submitPayment', { Partner_ID: partnerId, Amount: amount, Operation_Type: operationType });
  if (!result.success) return result;
  const d = result.data;
  const toCents = (v) => (v === undefined || v === null || v === '' ? null : Math.round(parseFloat(v) * 100));
  return { ...result, totalBalanceCents: toCents(d.total_balance ?? d.Total_Balance) };
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
  getVendorsAndSources,
  updateIprFilterSet,
  updateIprDailyVolume,
  getIprFilterSets,
  submitPayment,
};
