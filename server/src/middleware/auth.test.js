const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canActOnUser } = require('./auth');

test('canActOnUser: PLATFORM_OWNER is unconditionally allowed, any target role', () => {
  for (const role of ['PLATFORM_OWNER', 'AGENCY_OWNER', 'AGENCY_MANAGER', 'PRODUCER', 'TELEMARKETER']) {
    assert.equal(canActOnUser('PLATFORM_OWNER', role), true, role);
  }
});

test('canActOnUser: AGENCY_OWNER may act on a manager, producer, or telemarketer, never a peer or a platform owner', () => {
  assert.equal(canActOnUser('AGENCY_OWNER', 'AGENCY_MANAGER'), true);
  assert.equal(canActOnUser('AGENCY_OWNER', 'PRODUCER'), true);
  assert.equal(canActOnUser('AGENCY_OWNER', 'TELEMARKETER'), true);
  assert.equal(canActOnUser('AGENCY_OWNER', 'AGENCY_OWNER'), false);
  assert.equal(canActOnUser('AGENCY_OWNER', 'PLATFORM_OWNER'), false);
});

test('canActOnUser: AGENCY_MANAGER may act on a producer or telemarketer, never a manager or an owner', () => {
  assert.equal(canActOnUser('AGENCY_MANAGER', 'PRODUCER'), true);
  assert.equal(canActOnUser('AGENCY_MANAGER', 'TELEMARKETER'), true);
  assert.equal(canActOnUser('AGENCY_MANAGER', 'AGENCY_MANAGER'), false);
  assert.equal(canActOnUser('AGENCY_MANAGER', 'AGENCY_OWNER'), false, 'the confirmed real bug this fixes: a manager must never be able to act on their own owner');
});

test('canActOnUser: PRODUCER/TELEMARKETER can never act on anyone through this policy', () => {
  for (const actor of ['PRODUCER', 'TELEMARKETER']) {
    for (const target of ['PRODUCER', 'TELEMARKETER', 'AGENCY_MANAGER', 'AGENCY_OWNER', 'PLATFORM_OWNER']) {
      assert.equal(canActOnUser(actor, target), false, `${actor} -> ${target}`);
    }
  }
});
