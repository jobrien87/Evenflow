const { test } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { parseCrossSellFile } = require('./crossSellBulkImport');

function bufferFromRows(rows) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

test('parseCrossSellFile: honors the real report headers (First/Last Name, phones, E-mail)', () => {
  const buffer = bufferFromRows([
    ['First Name', 'Last Name', 'Mobile Phone', 'Home Phone', 'E-mail', 'Address1', 'City', 'State', 'Zip'],
    ['Jane', 'Doe', '(904) 555-0100', '', 'jane@example.com', '1 Main St', 'Jacksonville', 'FL', '32216'],
  ]);
  const result = parseCrossSellFile(buffer);
  assert.equal(result.error, undefined);
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].firstName, 'Jane');
  assert.equal(result.contacts[0].lastName, 'Doe');
  assert.equal(result.contacts[0].phone, '(904) 555-0100');
  assert.equal(result.contacts[0].email, 'jane@example.com');
});

test('parseCrossSellFile: falls back to Organization as a name when First/Last Name are blank', () => {
  const buffer = bufferFromRows([
    ['First Name', 'Last Name', 'Organization', 'Mobile Phone'],
    ['', '', 'John R Craft', '(904) 555-0101'],
  ]);
  const result = parseCrossSellFile(buffer);
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].firstName, 'John');
});

test('parseCrossSellFile: skips a row with no usable name', () => {
  const buffer = bufferFromRows([
    ['First Name', 'Last Name', 'Mobile Phone'],
    ['', '', '(904) 555-0102'],
  ]);
  const result = parseCrossSellFile(buffer);
  assert.equal(result.contacts.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'Missing name');
});

test('parseCrossSellFile: skips a row with a name but no phone or email', () => {
  const buffer = bufferFromRows([
    ['First Name', 'Last Name', 'Mobile Phone', 'E-mail'],
    ['Jane', 'Doe', '', ''],
  ]);
  const result = parseCrossSellFile(buffer);
  assert.equal(result.contacts.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'Missing phone and email');
});

test('parseCrossSellFile: honest EMPTY error for a file with only a header row', () => {
  const buffer = bufferFromRows([['First Name', 'Last Name']]);
  const result = parseCrossSellFile(buffer);
  assert.equal(result.error, 'EMPTY');
});

test('parseCrossSellFile: honest NO_NAME_COLUMN error when no name-like column exists at all', () => {
  const buffer = bufferFromRows([
    ['Mobile Phone', 'E-mail'],
    ['(904) 555-0100', 'jane@example.com'],
  ]);
  const result = parseCrossSellFile(buffer);
  assert.equal(result.error, 'NO_NAME_COLUMN');
});

test('parseCrossSellFile: never throws on a non-spreadsheet buffer — returns an honest error instead', () => {
  const result = parseCrossSellFile(Buffer.from('not a real spreadsheet'));
  assert.ok(['UNREADABLE', 'EMPTY'].includes(result.error), `expected an error code, got ${JSON.stringify(result)}`);
});
