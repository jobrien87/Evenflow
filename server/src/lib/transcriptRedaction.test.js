const { test } = require('node:test');
const assert = require('node:assert/strict');
const { redactTranscript } = require('./transcriptRedaction');

test('redacts an SSN', () => {
  const out = redactTranscript('My SSN is 123-45-6789 for verification.');
  assert.equal(out, 'My SSN is [REDACTED-SSN] for verification.');
});

test('redacts phone numbers in several common formats', () => {
  assert.ok(redactTranscript('Call (555) 123-4567 anytime.').includes('[REDACTED-PHONE]'));
  assert.ok(redactTranscript('Call 555-123-4567 anytime.').includes('[REDACTED-PHONE]'));
  assert.ok(redactTranscript('Call 555.123.4567 anytime.').includes('[REDACTED-PHONE]'));
  assert.ok(redactTranscript('Call +1 555 123 4567 anytime.').includes('[REDACTED-PHONE]'));
});

test('redacts an email address', () => {
  const out = redactTranscript('Reach me at jane.doe+test@example.co.uk please.');
  assert.ok(out.includes('[REDACTED-EMAIL]'));
  assert.ok(!out.includes('jane.doe'));
});

test('redacts a 16-digit card number whether grouped or bare', () => {
  assert.equal(redactTranscript('Card: 4111 1111 1111 1111').includes('[REDACTED-CARD]'), true);
  assert.equal(redactTranscript('Card: 4111-1111-1111-1111').includes('[REDACTED-CARD]'), true);
  assert.equal(redactTranscript('Card: 4111111111111111').includes('[REDACTED-CARD]'), true);
});

test('does not redact a short policy-number-like sequence (under 13 digits)', () => {
  const out = redactTranscript('Policy number is POL-2024-00193847.');
  assert.ok(!out.includes('[REDACTED-CARD]'));
  assert.ok(out.includes('00193847'));
});

test('does not redact ordinary dollar amounts or short numbers', () => {
  const out = redactTranscript('The premium is $1,234.56 per year, effective in 30 days.');
  assert.equal(out, 'The premium is $1,234.56 per year, effective in 30 days.');
});

test('leaves ordinary conversational text completely unchanged', () => {
  const text = 'Hi, thanks for calling. Let me check on your auto policy renewal.';
  assert.equal(redactTranscript(text), text);
});

test('handles null/empty input without throwing', () => {
  assert.equal(redactTranscript(null), null);
  assert.equal(redactTranscript(''), '');
});

test('redacts multiple distinct PII types in the same transcript', () => {
  const out = redactTranscript('SSN 123-45-6789, phone 555-123-4567, email a@b.com, card 4111222233334444.');
  assert.ok(out.includes('[REDACTED-SSN]'));
  assert.ok(out.includes('[REDACTED-PHONE]'));
  assert.ok(out.includes('[REDACTED-EMAIL]'));
  assert.ok(out.includes('[REDACTED-CARD]'));
});
