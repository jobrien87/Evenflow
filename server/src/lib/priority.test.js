// Pure-function tests for scoreLead — no DB needed, matches this file's
// own "deterministic, no I/O" character.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreLead, typeRankBonus, DEFAULT_TYPE_RANK, DEFAULT_STATUS_RULES } = require('./priority');

const NOW = new Date('2026-01-15T12:00:00Z');

function baseLead(overrides = {}) {
  return {
    status: 'CONTACTED',
    receivedAt: new Date('2026-01-01T00:00:00Z'),
    firstAttemptAt: new Date('2026-01-02T00:00:00Z'),
    updatedAt: new Date('2026-01-10T00:00:00Z'),
    leadType: 'MANUAL',
    ...overrides,
  };
}

test('typeRankBonus gives a bigger bonus the earlier the type ranks', () => {
  const rank = ['TRANSFER', 'PAID_AD', 'MANUAL'];
  assert.ok(typeRankBonus('TRANSFER', rank) > typeRankBonus('PAID_AD', rank));
  assert.ok(typeRankBonus('PAID_AD', rank) > typeRankBonus('MANUAL', rank));
});

test('typeRankBonus returns 0 for a type not present in the rank list', () => {
  assert.equal(typeRankBonus('CROSS_SELL', ['TRANSFER', 'MANUAL']), 0);
});

test('scoreLead: a TRANSFER lead outranks a MANUAL lead, all else equal', () => {
  const transfer = scoreLead(baseLead({ leadType: 'TRANSFER' }), null, NOW);
  const manual = scoreLead(baseLead({ leadType: 'MANUAL' }), null, NOW);
  assert.ok(transfer.priorityScore > manual.priorityScore);
});

test('scoreLead: default statusRules drop a SOLD lead to the very bottom', () => {
  const sold = scoreLead(baseLead({ status: 'SOLD', leadType: 'TRANSFER' }), null, NOW);
  const contacted = scoreLead(baseLead({ status: 'CONTACTED', leadType: 'MANUAL' }), null, NOW);
  assert.ok(sold.priorityScore < contacted.priorityScore);
  assert.match(sold.priorityReason, /deprioritized/);
});

test('scoreLead: default statusRules bump a QUOTED lead up only after 3 days', () => {
  const justQuoted = scoreLead(
    baseLead({ status: 'QUOTED', updatedAt: new Date('2026-01-15T11:00:00Z') }),
    null,
    NOW
  );
  const staleQuoted = scoreLead(
    baseLead({ status: 'QUOTED', updatedAt: new Date('2026-01-10T00:00:00Z') }),
    null,
    NOW
  );
  assert.ok(staleQuoted.priorityScore > justQuoted.priorityScore);
  assert.match(staleQuoted.priorityReason, /bumped up/);
});

test('scoreLead: default statusRules bump a LEFT_VM lead up after 2 days', () => {
  const fresh = scoreLead(baseLead({ status: 'LEFT_VM', updatedAt: new Date('2026-01-15T11:00:00Z') }), null, NOW);
  const stale = scoreLead(baseLead({ status: 'LEFT_VM', updatedAt: new Date('2026-01-12T00:00:00Z') }), null, NOW);
  assert.ok(stale.priorityScore > fresh.priorityScore);
});

test('scoreLead: a custom priorityRules.statusRules BUMP_DOWN action lowers the score', () => {
  const rules = { statusRules: { FOLLOW_UP: { afterDays: 1, action: 'BUMP_DOWN' } } };
  const withRule = scoreLead(baseLead({ status: 'FOLLOW_UP', updatedAt: new Date('2026-01-10T00:00:00Z') }), rules, NOW);
  const withoutRule = scoreLead(baseLead({ status: 'FOLLOW_UP', updatedAt: new Date('2026-01-10T00:00:00Z') }), null, NOW);
  assert.ok(withRule.priorityScore < withoutRule.priorityScore);
  assert.match(withRule.priorityReason, /bumped down/);
});

test('scoreLead: a custom priorityRules.typeRank changes relative ordering', () => {
  const rules = { typeRank: ['WINBACK', 'CROSS_SELL', 'MANUAL', 'TRANSFER'] };
  const winback = scoreLead(baseLead({ leadType: 'WINBACK' }), rules, NOW);
  const transfer = scoreLead(baseLead({ leadType: 'TRANSFER' }), rules, NOW);
  assert.ok(winback.priorityScore > transfer.priorityScore);
});

test('scoreLead: falls back to the seeded defaults when priorityRules is null/undefined', () => {
  const withNull = scoreLead(baseLead({ status: 'SOLD' }), null, NOW);
  const withUndefined = scoreLead(baseLead({ status: 'SOLD' }), undefined, NOW);
  assert.equal(withNull.priorityScore, withUndefined.priorityScore);
  assert.deepEqual(DEFAULT_STATUS_RULES.SOLD, { afterDays: 0, action: 'DROP_OFF' });
  assert.ok(DEFAULT_TYPE_RANK.includes('TRANSFER'));
});
