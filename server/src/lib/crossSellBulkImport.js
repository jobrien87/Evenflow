// Parses an agency's own externally-sourced cross-sell report (people who
// already hold ONE real product and are a genuine candidate for the
// complementary one — e.g. an "Auto, no Home" book-of-business export)
// into Customer + CROSS_SELL Opportunity rows. Mirrors lib/leadBulkImport.js's
// two-phase shape exactly (parse, then import) and its fuzzy-header-matching
// philosophy — a real agency's AMS export never uses identical headers to
// this app's own field names.
//
// Uses the SheetJS "xlsx" parser from cdn.sheetjs.com (not the npm
// registry copy — see package.json's own dependency entry and
// leadBulkImport.js's matching comment).

const XLSX = require('xlsx');
const { prisma } = require('./db');
const { normalizePhone, normalizeEmail } = require('./normalize');
const { updateCustomerProductsAndDetectCrossSells } = require('./opportunityEvents');

const HEADER_SYNONYMS = {
  firstName: ['firstname', 'first', 'fname'],
  lastName: ['lastname', 'last', 'lname', 'surname'],
  name: ['name', 'fullname', 'customername', 'clientname', 'preferredname'],
  organization: ['organization', 'company', 'business', 'businessname'],
  mobilePhone: ['mobilephone', 'mobile', 'cellphone', 'cell'],
  homePhone: ['homephone', 'phone', 'phonenumber', 'telephone'],
  workPhone: ['workphone', 'businessphone'],
  otherPhone: ['otherphone'],
  email: ['email', 'emailaddress', 'e-mail'],
  address: ['address', 'address1', 'street', 'streetaddress'],
  city: ['city'],
  state: ['state', 'st'],
  zip: ['zip', 'zipcode', 'postalcode'],
};

const MAX_ROWS = 10000;

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

function parseCrossSellFile(buffer) {
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
  if (headerMap.firstName === undefined && headerMap.name === undefined && headerMap.organization === undefined) {
    return { error: 'NO_NAME_COLUMN', message: 'Could not find a name column (e.g. "First Name"/"Last Name", "Name", or "Organization").' };
  }

  const dataRows = rows.slice(1, 1 + MAX_ROWS);
  const truncated = rows.length - 1 > MAX_ROWS;
  const contacts = [];
  const skipped = [];

  dataRows.forEach((row, i) => {
    const sourceRow = i + 2;
    if (row.every((c) => String(c).trim() === '')) return;

    const get = (field) => (headerMap[field] !== undefined ? String(row[headerMap[field]] ?? '').trim() : '');

    let firstName = get('firstName');
    let lastName = get('lastName');
    if (!firstName && !lastName) {
      const full = get('name') || get('organization');
      if (full) {
        const parts = full.split(/\s+/);
        firstName = parts[0];
        lastName = parts.slice(1).join(' ') || parts[0];
      }
    }
    if (!firstName && !lastName) {
      skipped.push({ row: sourceRow, reason: 'Missing name' });
      return;
    }

    const phone = get('mobilePhone') || get('homePhone') || get('workPhone') || get('otherPhone');
    const email = get('email');
    if (!phone && !email) {
      skipped.push({ row: sourceRow, reason: 'Missing phone and email' });
      return;
    }

    contacts.push({
      _sourceRow: sourceRow,
      firstName: firstName || '(unknown)',
      lastName: lastName || '(unknown)',
      phone,
      email,
      address: get('address'),
      city: get('city'),
      state: get('state'),
      zip: get('zip'),
    });
  });

  return { contacts, skipped, totalRows: dataRows.length, truncated, matchedFields: Object.keys(headerMap) };
}

// Customer de-duplication matches routes/leads.js's createLeadRecord
// convention exactly (match by normalized phone OR email before creating),
// so re-running an import never creates duplicate customers. Opportunity
// de-duplication is handled by updateCustomerProductsAndDetectCrossSells
// itself (skips a product that already has a non-terminal cross-sell for
// that customer).
async function importCrossSellContacts({ contacts, agencyId, havesProduct, needsProduct }) {
  let customersCreated = 0;
  let customersMatched = 0;
  let opportunitiesCreated = 0;

  for (const contact of contacts) {
    const phoneNormalized = normalizePhone(contact.phone);
    const email = normalizeEmail(contact.email);

    let customer = await prisma.customer.findFirst({
      where: { OR: [phoneNormalized ? { phoneNormalized } : undefined, email ? { email } : undefined].filter(Boolean) },
    });

    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          firstName: contact.firstName,
          lastName: contact.lastName,
          phoneNormalized,
          email,
          address: contact.address || null,
          city: contact.city || null,
          state: contact.state || null,
          zip: contact.zip || null,
        },
      });
      customersCreated++;
    } else {
      customersMatched++;
    }

    const created = await updateCustomerProductsAndDetectCrossSells({ customerId: customer.id, agencyId, soldProduct: havesProduct });
    opportunitiesCreated += created.filter((o) => o.product === needsProduct).length;
  }

  return { customersCreated, customersMatched, opportunitiesCreated };
}

module.exports = { parseCrossSellFile, importCrossSellContacts, MAX_ROWS };
