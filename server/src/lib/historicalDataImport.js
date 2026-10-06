// Parses a bulk "Historical Data" export (CSV/XLS/XLSX) into rows shaped
// for HistoricalRecord — deliberately NOT the same vocabulary as
// leadBulkImport.js's HEADER_SYNONYMS (these are raw historical facts, not
// workable-lead intake fields, and the two column sets would collide on
// shared words like "premium" if merged into one dictionary). Reuses the
// same xlsx-parsing approach (SheetJS from cdn.sheetjs.com — see
// leadBulkImport.js's own header comment for why not the npm package).

const XLSX = require('xlsx');

const HEADER_SYNONYMS = {
  // Required — an undated row can't be placed on any trend/timeline, so
  // rows missing this are rejected rather than imported with a guessed date.
  recordDate: ['date', 'saledate', 'closedate', 'createddate', 'receiveddate', 'eventdate', 'recorddate'],
  firstName: ['firstname', 'first', 'fname'],
  lastName: ['lastname', 'last', 'lname', 'surname'],
  name: ['name', 'fullname', 'customername', 'clientname'],
  phone: ['phone', 'phonenumber', 'cell', 'cellphone', 'mobile', 'mobilephone', 'telephone', 'contactnumber'],
  email: ['email', 'emailaddress'],
  product: ['product', 'line', 'productline', 'lineofbusiness', 'lob'],
  zip: ['zip', 'zipcode', 'postalcode'],
  vendorName: ['vendor', 'source', 'leadsource', 'vendorname'],
  agentName: ['agent', 'producer', 'rep', 'salesperson', 'assignedto', 'agentname'],
  premiumCents: ['premium', 'saleprice', 'policypremium', 'totalpremium', 'annualpremium'],
  outcome: ['status', 'disposition', 'policystatus', 'leadstatus', 'stage', 'outcome'],
};

const MAX_ROWS = 20000;

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

function parseDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Best-effort — strips everything but digits/decimal point, so "$1,200.00",
// "1200", and "1,200" all parse the same way.
function parsePremiumCentsOrNull(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const dollars = parseFloat(cleaned);
  if (Number.isNaN(dollars)) return null;
  return Math.round(dollars * 100);
}

function parseHistoricalFile(buffer) {
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
  if (headerMap.recordDate === undefined) {
    return { error: 'NO_DATE_COLUMN', message: 'Could not find a date column (e.g. "Date", "Sale Date", "Close Date") — historical data needs a real date on every row.' };
  }

  const dataRows = rows.slice(1, 1 + MAX_ROWS);
  const truncated = rows.length - 1 > MAX_ROWS;
  const records = [];
  const skipped = [];

  dataRows.forEach((row, i) => {
    const sourceRow = i + 2; // +1 for header, +1 for 1-indexing
    if (row.every((c) => String(c).trim() === '')) return;

    const get = (field) => (headerMap[field] !== undefined ? String(row[headerMap[field]] ?? '').trim() : '');

    const recordDate = parseDateOrNull(get('recordDate'));
    if (!recordDate) {
      skipped.push({ row: sourceRow, reason: 'Missing or unparseable date' });
      return;
    }

    let firstName = get('firstName');
    let lastName = get('lastName');
    if (!firstName && !lastName) {
      const full = get('name');
      if (full) {
        const parts = full.split(/\s+/);
        firstName = parts[0];
        lastName = parts.slice(1).join(' ') || '';
      }
    }

    const premiumCents = parsePremiumCentsOrNull(get('premiumCents'));

    records.push({
      _sourceRow: sourceRow,
      recordDate,
      firstName: firstName || null,
      lastName: lastName || null,
      phone: get('phone') || null,
      email: get('email') || null,
      product: get('product') || null,
      zip: get('zip') || null,
      vendorNameRaw: get('vendorName') || null,
      agentNameRaw: get('agentName') || null,
      premiumCents,
      isSold: !!premiumCents && premiumCents > 0,
      outcome: get('outcome') || null,
      rawFields: Object.fromEntries(
        Object.keys(HEADER_SYNONYMS)
          .map((field) => [field, get(field)])
          .filter(([, v]) => v !== '')
      ),
    });
  });

  return { records, skipped, totalRows: dataRows.length, truncated, matchedFields: Object.keys(headerMap) };
}

module.exports = { parseHistoricalFile };
