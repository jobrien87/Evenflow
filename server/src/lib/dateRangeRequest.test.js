// Real-database test for the shared report date-range resolver —
//   DATABASE_URL=postgresql://... node --test src/lib/dateRangeRequest.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { resolveAgencyDateRange } = require('./dateRangeRequest');

const suffix = Date.now();
let agencyId;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Date Range Request Test Agency ${suffix}`, timezone: 'America/New_York' } });
  agencyId = agency.id;
});

after(async () => {
  await prisma.agency.delete({ where: { id: agencyId } });
});

test('resolveAgencyDateRange: a client-sent from on the 1st of an Eastern month resolves to exact UTC midnight of that day, not a few hours later', async () => {
  // Simulates the exact browser-local-midnight bug: a US-timezone browser
  // sends local midnight on Feb 1, which as a raw UTC instant lands a few
  // hours into Feb 1 UTC — still the same calendar day in Eastern time,
  // so it must resolve back to exact 2026-02-01T00:00:00.000Z, matching
  // how saleDate/recordDate are always stored.
  const req = { query: { from: '2026-02-01T05:00:00.000Z', to: '2026-02-28T23:59:59.999Z' } };
  const { from, to } = await resolveAgencyDateRange(req, agencyId);
  assert.equal(from.toISOString(), '2026-02-01T00:00:00.000Z');
  // Exclusive upper bound — the instant March 1 begins, so Feb 28 is fully included.
  assert.equal(to.toISOString(), '2026-03-01T00:00:00.000Z');
});

test('resolveAgencyDateRange: no query params defaults to the 1st of the agency\'s current Eastern month through now', async () => {
  const req = { query: {} };
  const { from, to } = await resolveAgencyDateRange(req, agencyId);
  const now = new Date();
  assert.equal(from.getUTCDate(), 1);
  assert.equal(from.getUTCHours(), 0);
  assert.ok(to.getTime() > now.getTime(), 'to is exclusive — the day after "now" falls, so it is always after the current instant');
});

test('resolveAgencyDateRange: a falsy agencyId (e.g. a Telemarketer with no agency) falls back to the default timezone', async () => {
  const req = { query: { from: '2026-02-01T05:00:00.000Z', to: '2026-02-01T05:00:00.000Z' } };
  const { from, timeZone } = await resolveAgencyDateRange(req, undefined);
  assert.equal(timeZone, 'America/New_York');
  assert.equal(from.toISOString(), '2026-02-01T00:00:00.000Z');
});
