// Parses an agency owner's uploaded lead list (CSV, XLS, or XLSX) into
// rows shaped like the real Lead intake fields (createLeadSchema in
// routes/leads.js), using flexible/fuzzy column-header matching instead
// of requiring an exact template — real agency spreadsheets never use
// identical headers to each other or to this app's own field names.
//
// Uses the SheetJS "xlsx" parser sourced directly from cdn.sheetjs.com
// (not the npm registry copy, which is stuck on an old release with a
// known, unpatched prototype-pollution/ReDoS advisory) — see this
// package's own package.json dependency entry.

const XLSX = require('xlsx');
const { buildHeaderMap, buildRawRowCapture, resolveHeaderMapWithAiFallback } = require('./columnMapper');

const HEADER_SYNONYMS = {
  firstName: ['firstname', 'first', 'fname'],
  lastName: ['lastname', 'last', 'lname', 'surname'],
  name: ['name', 'fullname', 'customername', 'clientname'],
  phone: ['phone', 'phonenumber', 'cell', 'cellphone', 'mobile', 'mobilephone', 'telephone', 'contactnumber'],
  email: ['email', 'emailaddress'],
  product: ['product', 'line', 'productline', 'lineofbusiness', 'lob'],
  dob: ['dob', 'dateofbirth', 'birthdate', 'birthday'],
  address: ['address', 'address1', 'street', 'streetaddress'],
  city: ['city'],
  state: ['state', 'st'],
  zip: ['zip', 'zipcode', 'postalcode'],
  vehicleYear: ['vehicleyear', 'autoyear', 'caryear'],
  vehicleMake: ['vehiclemake', 'make', 'carmake'],
  vehicleModel: ['vehiclemodel', 'model', 'carmodel'],
  additionalDrivers: ['additionaldrivers', 'otherdrivers', 'extradrivers'],
  autoClaims: ['autoclaims'],
  violations: ['violations', 'tickets'],
  ownRent: ['ownrent', 'homeownership', 'residence', 'ownorrent'],
  homeAge: ['homeage', 'ageofhome', 'yearbuilt'],
  sqFootage: ['sqfootage', 'sqft', 'squarefootage', 'squarefeet'],
  homeClaims: ['homeclaims'],
  currentInsurance: ['currentinsurance', 'currentcarrier', 'carrier', 'currentprovider'],
  currentPremium: ['currentpremium', 'premium'],
  yearsWithCarrier: ['yearswithcarrier', 'yearswithcurrentcarrier', 'tenure'],
  callbackTime: ['callbacktime', 'besttimetocall', 'preferredcalltime'],
  tmNotes: ['notes', 'comments', 'note'],
  // Captured for context only — never written to Lead.status (named
  // distinctly to avoid any confusion with that field). A ported-in
  // historical export's own status/disposition text (e.g. "Active",
  // "Lapsed", "Sold") has real business meaning in its SOURCE system but
  // isn't verified against this app's own LeadStatus enum or side effects
  // (a stray "Sold" here must never fabricate a RevenueEvent), so callers
  // that care record it as creation-event metadata instead of trusting it
  // as live status.
  externalStatus: ['status', 'disposition', 'policystatus', 'leadstatus', 'stage'],
};

const KNOWN_FIELDS = Object.keys(HEADER_SYNONYMS);
const FIELD_DESCRIPTIONS = {
  firstName: "the customer's first name",
  lastName: "the customer's last name",
  name: "the customer's full name, when first/last aren't split into separate columns",
  phone: "the customer's phone number",
  email: "the customer's email address",
  product: 'the insurance product/line of business (e.g. Auto, Home, Life)',
  dob: "the customer's date of birth",
  address: 'the street address',
  city: 'the city',
  state: 'the 2-letter state abbreviation',
  zip: 'the zip code',
  vehicleYear: 'the vehicle model year (Auto only)',
  vehicleMake: 'the vehicle make (Auto only)',
  vehicleModel: 'the vehicle model (Auto only)',
  currentInsurance: 'the current insurance carrier',
  currentPremium: 'the current premium amount',
  externalStatus: 'a status/disposition text from the source system (for context only)',
};

const MAX_ROWS = 5000;

// Best-effort — a spreadsheet date can arrive as almost any format.
// Silently drops an unparsable value rather than failing the whole row
// over one optional field.
function toIsoDateOrEmpty(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function readWorkbookRows(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch {
    return { error: 'UNREADABLE', message: 'Could not read this file as a spreadsheet. Upload a CSV, XLS, or XLSX file.' };
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { error: 'EMPTY', message: 'This file has no sheets.' };

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  if (rows.length < 2) return { error: 'EMPTY', message: 'No data rows found below the header row.' };

  return { headerRow: rows[0], dataRows: rows.slice(1) };
}

function extractLeads({ headerRow, dataRows, headerMap }) {
  if (headerMap.firstName === undefined && headerMap.name === undefined) {
    return { error: 'NO_NAME_COLUMN', message: 'Could not find a name column (e.g. "First Name"/"Last Name", or "Name").' };
  }

  const truncated = dataRows.length > MAX_ROWS;
  const limitedRows = dataRows.slice(0, MAX_ROWS);
  const leads = [];
  const skipped = [];

  limitedRows.forEach((row, i) => {
    const sourceRow = i + 2; // +1 for header, +1 for 1-indexing
    if (row.every((c) => String(c).trim() === '')) return;

    const get = (field) => (headerMap[field] !== undefined ? String(row[headerMap[field]] ?? '').trim() : '');

    let firstName = get('firstName');
    let lastName = get('lastName');
    if (!firstName && !lastName) {
      const full = get('name');
      if (full) {
        const parts = full.split(/\s+/);
        firstName = parts[0];
        lastName = parts.slice(1).join(' ') || parts[0];
      }
    }

    if (!firstName || !lastName) {
      skipped.push({ row: sourceRow, reason: 'Missing name' });
      return;
    }

    leads.push({
      _sourceRow: sourceRow,
      firstName,
      lastName,
      phone: get('phone'),
      email: get('email'),
      product: get('product'),
      dob: toIsoDateOrEmpty(get('dob')),
      address: get('address'),
      city: get('city'),
      state: get('state'),
      zip: get('zip'),
      vehicleYear: get('vehicleYear'),
      vehicleMake: get('vehicleMake'),
      vehicleModel: get('vehicleModel'),
      additionalDrivers: get('additionalDrivers'),
      autoClaims: get('autoClaims'),
      violations: get('violations'),
      ownRent: get('ownRent'),
      homeAge: get('homeAge'),
      sqFootage: get('sqFootage'),
      homeClaims: get('homeClaims'),
      currentInsurance: get('currentInsurance'),
      currentPremium: get('currentPremium'),
      yearsWithCarrier: get('yearsWithCarrier'),
      callbackTime: get('callbackTime'),
      tmNotes: get('tmNotes'),
      externalStatus: get('externalStatus'),
      // The full original row, keyed by its own literal header text — never
      // just the fields this parser recognizes, so an unmatched column is
      // still captured losslessly (see Lead.rawImportFields).
      rawImportFields: buildRawRowCapture(headerRow, row),
    });
  });

  return { leads, skipped, totalRows: limitedRows.length, truncated, matchedFields: Object.keys(headerMap) };
}

// Deterministic-only entry point — no AI call, ever.
function parseLeadFile(buffer) {
  const read = readWorkbookRows(buffer);
  if (read.error) return read;
  const headerMap = buildHeaderMap(read.headerRow, HEADER_SYNONYMS);
  return extractLeads({ headerRow: read.headerRow, dataRows: read.dataRows, headerMap });
}

// Deterministic pass first (free, handles the common case), then one
// batched AI call for whatever target field is still unmapped — same
// honest-degradation contract as historicalDataImport.js's own AI-assisted
// entry point (lib/columnMapper.js never throws, skips cleanly when
// unconfigured or nothing is left to map).
async function parseLeadFileWithAi(buffer) {
  const read = readWorkbookRows(buffer);
  if (read.error) return read;

  const deterministicMap = buildHeaderMap(read.headerRow, HEADER_SYNONYMS);
  const mapping = await resolveHeaderMapWithAiFallback({
    headerRow: read.headerRow,
    rows: read.dataRows,
    HEADER_SYNONYMS,
    knownFields: KNOWN_FIELDS,
    fieldDescriptions: FIELD_DESCRIPTIONS,
    headerMap: deterministicMap,
  });

  const extracted = extractLeads({ headerRow: read.headerRow, dataRows: read.dataRows, headerMap: mapping.headerMap });
  if (extracted.error) return extracted;

  return {
    ...extracted,
    columnMapping: {
      matchedFields: Object.keys(mapping.headerMap),
      aiUsed: mapping.aiUsed,
      aiSkippedReason: mapping.aiSkippedReason,
      aiSuggestions: mapping.aiSuggestions,
      unmappedHeaders: mapping.unmappedHeaders,
    },
  };
}

module.exports = { parseLeadFile, parseLeadFileWithAi };
