const { test } = require('node:test');
const assert = require('node:assert/strict');
const leadsRouter = require('./leads');

const { authorizeLeadAccess } = leadsRouter;

const AGENCY_A = 'agency-a';
const AGENCY_B = 'agency-b';
const PRODUCER_ID = 'producer-1';
const OTHER_PRODUCER_ID = 'producer-2';

function req(role, overrides = {}) {
  return { user: { id: PRODUCER_ID, role, agencyId: AGENCY_A, ...overrides } };
}

function lead(overrides = {}) {
  return { agencyId: AGENCY_A, assignedToId: null, isLiveTransfer: false, vendor: null, ...overrides };
}

test('authorizeLeadAccess: missing lead is 404, regardless of role', () => {
  const result = authorizeLeadAccess(req('AGENCY_OWNER'), null, { write: false });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.error, 'NOT_FOUND');
});

test('authorizeLeadAccess: a non-platform-owner can never touch another agency\'s lead', () => {
  const l = lead({ agencyId: AGENCY_B });
  for (const role of ['AGENCY_OWNER', 'AGENCY_MANAGER', 'PRODUCER', 'TELEMARKETER']) {
    const readResult = authorizeLeadAccess(req(role), l, { write: false });
    assert.equal(readResult.ok, false, `${role} read`);
    assert.equal(readResult.status, 403, `${role} read status`);
    const writeResult = authorizeLeadAccess(req(role), l, { write: true });
    assert.equal(writeResult.ok, false, `${role} write`);
  }
});

test('authorizeLeadAccess: PLATFORM_OWNER is unrestricted across agencies', () => {
  const l = lead({ agencyId: AGENCY_B, assignedToId: OTHER_PRODUCER_ID });
  const result = authorizeLeadAccess(req('PLATFORM_OWNER', { agencyId: null }), l, { write: true });
  assert.equal(result.ok, true);
});

test('authorizeLeadAccess: AGENCY_OWNER/AGENCY_MANAGER/TELEMARKETER are agency-scoped only, not ownership-scoped', () => {
  const l = lead({ assignedToId: OTHER_PRODUCER_ID });
  for (const role of ['AGENCY_OWNER', 'AGENCY_MANAGER', 'TELEMARKETER']) {
    const result = authorizeLeadAccess(req(role), l, { write: true });
    assert.equal(result.ok, true, role);
  }
});

test('authorizeLeadAccess: a PRODUCER can read and write a lead actually assigned to them', () => {
  const l = lead({ assignedToId: PRODUCER_ID });
  assert.equal(authorizeLeadAccess(req('PRODUCER'), l, { write: false }).ok, true);
  assert.equal(authorizeLeadAccess(req('PRODUCER'), l, { write: true }).ok, true);
});

test('authorizeLeadAccess: a PRODUCER is forbidden from a lead assigned to a different producer', () => {
  const l = lead({ assignedToId: OTHER_PRODUCER_ID });
  const readResult = authorizeLeadAccess(req('PRODUCER'), l, { write: false });
  assert.equal(readResult.ok, false);
  assert.equal(readResult.status, 403);
  const writeResult = authorizeLeadAccess(req('PRODUCER'), l, { write: true });
  assert.equal(writeResult.ok, false);
  assert.equal(writeResult.status, 403);
});

test('authorizeLeadAccess: a PRODUCER may READ an unclaimed live-transfer lead (Moshpit preview), but never WRITE it', () => {
  const l = lead({ assignedToId: null, isLiveTransfer: true });
  assert.equal(authorizeLeadAccess(req('PRODUCER'), l, { write: false }).ok, true);
  const writeResult = authorizeLeadAccess(req('PRODUCER'), l, { write: true });
  assert.equal(writeResult.ok, false);
  assert.equal(writeResult.status, 403);
});

test('authorizeLeadAccess: a PRODUCER may READ an unclaimed Moshpit-vendor lead, but never WRITE it', () => {
  const l = lead({ assignedToId: null, vendor: { distributionMode: 'MOSHPIT' } });
  assert.equal(authorizeLeadAccess(req('PRODUCER'), l, { write: false }).ok, true);
  const writeResult = authorizeLeadAccess(req('PRODUCER'), l, { write: true });
  assert.equal(writeResult.ok, false);
});

test('authorizeLeadAccess: a PRODUCER cannot even READ an unclaimed, non-Moshpit-eligible lead', () => {
  const l = lead({ assignedToId: null, isLiveTransfer: false, vendor: { distributionMode: 'ROUND_ROBIN' } });
  const result = authorizeLeadAccess(req('PRODUCER'), l, { write: false });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('authorizeLeadAccess: a PRODUCER cannot READ an unclaimed lead with no vendor at all', () => {
  const l = lead({ assignedToId: null, isLiveTransfer: false, vendor: null });
  const result = authorizeLeadAccess(req('PRODUCER'), l, { write: false });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('authorizeLeadAccess: a PRODUCER cannot WRITE a lead assigned to someone else even if it is also Moshpit-eligible-looking data', () => {
  const l = lead({ assignedToId: OTHER_PRODUCER_ID, isLiveTransfer: true });
  const result = authorizeLeadAccess(req('PRODUCER'), l, { write: true });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});
