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
};

const MAX_ROWS = 5000;

function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildHeaderMap(headerRow) {
  const map = {};
  headerRow.forEach((raw, idx) => {
    const norm = normalizeHeader(raw);
    if (!norm) return;
    for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS)) {
      if (map[field] === undefined && synonyms.includes(norm)) {
        map[field] = idx;
      }
    }
  });
  return map;
}

// Best-effort — a spreadsheet date can arrive as almost any format.
// Silently drops an unparsable value rather than failing the whole row
// over one optional field.
function toIsoDateOrEmpty(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function parseLeadFile(buffer) {
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

  const headerMap = buildHeaderMap(rows[0]);
  if (headerMap.firstName === undefined && headerMap.name === undefined) {
    return { error: 'NO_NAME_COLUMN', message: 'Could not find a name column (e.g. "First Name"/"Last Name", or "Name").' };
  }

  const dataRows = rows.slice(1, 1 + MAX_ROWS);
  const truncated = rows.length - 1 > MAX_ROWS;
  const leads = [];
  const skipped = [];

  dataRows.forEach((row, i) => {
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
    });
  });

  return { leads, skipped, totalRows: dataRows.length, truncated, matchedFields: Object.keys(headerMap) };
}

module.exports = { parseLeadFile };
