// Parses a bulk "Historical Data" export (CSV/XLS/XLSX) into rows shaped
// for HistoricalRecord — deliberately NOT the same vocabulary as
// leadBulkImport.js's HEADER_SYNONYMS (these are raw historical facts, not
// workable-lead intake fields, and the two column sets would collide on
// shared words like "premium" if merged into one dictionary). Reuses the
// same xlsx-parsing approach (SheetJS from cdn.sheetjs.com — see
// leadBulkImport.js's own header comment for why not the npm package).

const XLSX = require('xlsx');
const { buildHeaderMap, buildRawRowCapture, resolveHeaderMapWithAiFallback } = require('./columnMapper');

const HEADER_SYNONYMS = {
  // Required — an undated row can't be placed on any trend/timeline, so
  // rows missing this are rejected rather than imported with a guessed date.
  // "issueddate"/"issuedate" covers Performology's own export convention
  // ("we use the issue date as the date").
  recordDate: ['date', 'saledate', 'closedate', 'createddate', 'receiveddate', 'eventdate', 'recorddate', 'issueddate', 'issuedate'],
  firstName: ['firstname', 'first', 'fname'],
  lastName: ['lastname', 'last', 'lname', 'surname'],
  name: ['name', 'fullname', 'customername', 'clientname', 'customer'],
  phone: ['phone', 'phonenumber', 'cell', 'cellphone', 'mobile', 'mobilephone', 'telephone', 'contactnumber'],
  email: ['email', 'emailaddress'],
  product: ['product', 'line', 'productline', 'lineofbusiness', 'lob', 'policytype'],
  zip: ['zip', 'zipcode', 'postalcode'],
  vendorName: ['vendor', 'source', 'leadsource', 'vendorname'],
  agentName: ['agent', 'producer', 'rep', 'salesperson', 'assignedto', 'agentname'],
  premiumCents: ['premium', 'saleprice', 'policypremium', 'totalpremium', 'annualpremium', 'premiumamount'],
  // The raw status/disposition text for context — also where a "Dataset"
  // column (Sales/Terminations/Reinstatements) lands, so isSold's
  // keyword classifier below has something real to read.
  outcome: ['status', 'disposition', 'policystatus', 'leadstatus', 'stage', 'outcome', 'dataset', 'recordtype'],
  office: ['location', 'office', 'branch', 'officename'],
};

// Every known target field this parser can place a column into — used both
// by the deterministic pass above and by the AI fallback (lib/columnMapper.js)
// for whichever of these a source file's headers don't obviously name.
const KNOWN_FIELDS = Object.keys(HEADER_SYNONYMS);
const FIELD_DESCRIPTIONS = {
  recordDate: 'the date this record happened (sale, close, or issue date) — required',
  firstName: "the customer's first name",
  lastName: "the customer's last name",
  name: "the customer's full name, when first/last aren't split into separate columns",
  phone: "the customer's phone number",
  email: "the customer's email address",
  product: 'the insurance product/line of business (e.g. Auto, Home, Life)',
  zip: "the customer's zip code",
  vendorName: 'the lead source/vendor this record came from',
  agentName: 'the producer/agent/rep this record is attributed to',
  premiumCents: 'the dollar premium amount',
  outcome: 'the raw status/disposition/record-type text (e.g. Sale, Termination, Reinstatement)',
  office: 'the office/branch/location name this record belongs to',
};

// A Termination can carry its original policy's premium, which must never
// be double-counted as a new sale; a Reinstatement is a real incremental
// revenue event, not a reversal. Anything else (including no outcome
// column at all) falls through to the premiumCents>0 rule, unchanged —
// keeps this fully backward compatible with imports that have no status
// column at all.
const NEGATIVE_SALE_SIGNALS = ['terminat', 'cancel', 'lapsed', 'nsf', 'chargeback', 'void', 'reject'];
const POSITIVE_SALE_SIGNALS = ['sale', 'sold', 'issued', 'bound', 'active', 'reinstat'];

function classifyIsSold(outcome, premiumCents) {
  const text = String(outcome || '').toLowerCase();
  if (text) {
    if (NEGATIVE_SALE_SIGNALS.some((sig) => text.includes(sig))) return false;
    if (POSITIVE_SALE_SIGNALS.some((sig) => text.includes(sig))) return true;
  }
  return !!premiumCents && premiumCents > 0;
}

const MAX_ROWS = 20000;

// Excel's date epoch is 1899-12-30 (not 1900-01-01 — accounts for the
// historical 1900-leap-year bug Excel still carries). Only needed for a
// formula/computed cell that yields a raw serial number rather than a
// real date-typed cell (which cellDates:true already turns into a Date
// before this ever runs).
function excelSerialToDate(serial) {
  const utcDays = Math.floor(serial - 25569);
  const date = new Date(utcDays * 86400 * 1000);
  const fractionalDay = serial - Math.floor(serial);
  if (fractionalDay > 0) date.setUTCMilliseconds(Math.round(fractionalDay * 86400 * 1000));
  return date;
}

// Explicit, unambiguous formats tried before falling back to the generic
// `new Date(string)` parse — a text-typed date cell (not a real Excel date
// cell) round-trips through SheetJS as a literal string, and a legacy
// export's exact format isn't guaranteed to be one `new Date()` on its own
// reliably parses the same way across platforms/locales.
const EXPLICIT_DATE_PATTERNS = [
  // MM/DD/YYYY, M/D/YYYY, MM-DD-YYYY, ... (US convention — this parser's
  // existing synonyms and acceptance tests are already US-insurance-data
  // oriented, so this assumption matches the rest of the file).
  { re: /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/, build: (m) => new Date(Date.UTC(+m[3], +m[1] - 1, +m[2])) },
  // YYYY-MM-DD, YYYY/MM/DD (ISO-ish, unambiguous regardless of locale).
  { re: /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/, build: (m) => new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) },
  // MM/DD/YY, M/D/YY — 2-digit year, assumed 2000s (no insurance data this
  // app imports predates the year 2000).
  { re: /^(\d{1,2})[/-](\d{1,2})[/-](\d{2})$/, build: (m) => new Date(Date.UTC(2000 + Number(m[3]), +m[1] - 1, +m[2])) },
];

function parseDateOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  // A real Excel date cell, read with cellDates:true + raw:true below,
  // arrives here as an actual Date instance — use it directly rather than
  // round-tripping through a formatted display string, which is the real
  // cause a legacy export's date format could silently fail to parse.
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = excelSerialToDate(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const text = String(value).trim();
  if (!text) return null;
  // Strip a trailing time-of-day fragment some exports append to an
  // otherwise plain date (e.g. "10/06/2026 12:00:00 AM") so the date-only
  // patterns above still match.
  const datePart = text.split(/\s+\d{1,2}:\d{2}/)[0].trim();
  for (const { re, build } of EXPLICIT_DATE_PATTERNS) {
    const m = datePart.match(re);
    if (m) {
      const d = build(m);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  const generic = new Date(text);
  return Number.isNaN(generic.getTime()) ? null : generic;
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
  // raw:true (paired with cellDates:true above) returns a real date cell as
  // a native Date instance and a text cell as its literal original string —
  // never SheetJS's own locale-formatted display string, which was the real
  // cause some rows' dates silently failed to parse (a legacy export's
  // date format round-tripped through formatting into something
  // new Date() couldn't read, with no visible reason why).
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  if (rows.length < 2) return { error: 'EMPTY', message: 'No data rows found below the header row.' };

  return { headerRow: rows[0], dataRows: rows.slice(1) };
}

// Pure, synchronous row extraction given an already-resolved headerMap —
// shared by both the deterministic-only entry point and the AI-assisted one.
function extractHistoricalRecords({ headerRow, dataRows, headerMap }) {
  if (headerMap.recordDate === undefined) {
    return { error: 'NO_DATE_COLUMN', message: 'Could not find a date column (e.g. "Date", "Sale Date", "Issue Date") — historical data needs a real date on every row.' };
  }

  const truncated = dataRows.length > MAX_ROWS;
  const limitedRows = dataRows.slice(0, MAX_ROWS);
  const records = [];
  const skipped = [];

  limitedRows.forEach((row, i) => {
    const sourceRow = i + 2; // +1 for header, +1 for 1-indexing
    // A blank row previously vanished silently — counted in totalRows
    // (measured before this filter) but added to neither records nor
    // skipped, so the numbers shown to the user never reconciled. Folded
    // into skipped now, same as any other real skip reason.
    if (row.every((c) => String(c ?? '').trim() === '')) {
      skipped.push({ row: sourceRow, reason: 'Blank row' });
      return;
    }

    const get = (field) => (headerMap[field] !== undefined ? String(row[headerMap[field]] ?? '').trim() : '');
    // Deliberately NOT routed through get()'s String()-coercion — a real
    // date cell needs its native Date/number value, not a stringified one.
    const getRaw = (field) => (headerMap[field] !== undefined ? row[headerMap[field]] : undefined);

    const recordDate = parseDateOrNull(getRaw('recordDate'));
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
    const outcome = get('outcome') || null;

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
      officeNameRaw: get('office') || null,
      premiumCents,
      isSold: classifyIsSold(outcome, premiumCents),
      outcome,
      // The full original row, keyed by its own literal header text — never
      // just the fields this parser recognizes, so an unmatched column
      // (e.g. "Source Batch", "Policy #") is still captured losslessly.
      rawFields: buildRawRowCapture(headerRow, row),
    });
  });

  // A tally alongside the per-row `skipped` list — lets the client show a
  // clean "340 missing/unparseable date, 12 blank" breakdown instead of
  // either a vague guess or dumping every individual row for a huge file.
  const skippedReasons = {};
  for (const s of skipped) skippedReasons[s.reason] = (skippedReasons[s.reason] || 0) + 1;

  return { records, skipped, skippedReasons, totalRows: limitedRows.length, truncated, matchedFields: Object.keys(headerMap) };
}

// Deterministic-only entry point — no AI call, ever. Kept as the simple,
// synchronous default for anything that doesn't need the AI fallback.
function parseHistoricalFile(buffer) {
  const read = readWorkbookRows(buffer);
  if (read.error) return read;
  const headerMap = buildHeaderMap(read.headerRow, HEADER_SYNONYMS);
  return extractHistoricalRecords({ headerRow: read.headerRow, dataRows: read.dataRows, headerMap });
}

// The real entry point for the import route: deterministic pass first
// (free, handles the common case — including every real Performology
// header this round added synonyms for, with zero AI calls), then one
// batched AI call for whatever's still unmapped (lib/columnMapper.js's
// honest-degradation contract — never throws, skips cleanly when
// unconfigured or nothing is left to map). Returns the same shape as
// parseHistoricalFile, plus a `columnMapping` block.
async function parseHistoricalFileWithAi(buffer) {
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

  const extracted = extractHistoricalRecords({ headerRow: read.headerRow, dataRows: read.dataRows, headerMap: mapping.headerMap });
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

module.exports = { parseHistoricalFile, parseHistoricalFileWithAi, classifyIsSold, HEADER_SYNONYMS, KNOWN_FIELDS };
