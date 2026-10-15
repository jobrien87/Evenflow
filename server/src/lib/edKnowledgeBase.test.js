const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildKnowledgeBaseForRole, ENTRIES } = require('./edKnowledgeBase');

test('buildKnowledgeBaseForRole returns the same full knowledge base regardless of role', () => {
  const producer = buildKnowledgeBaseForRole('PRODUCER');
  const owner = buildKnowledgeBaseForRole('AGENCY_OWNER');
  const platformOwner = buildKnowledgeBaseForRole('PLATFORM_OWNER');
  const telemarketer = buildKnowledgeBaseForRole('TELEMARKETER');
  assert.equal(producer, owner);
  assert.equal(owner, platformOwner);
  assert.equal(platformOwner, telemarketer);
});

test('the knowledge base includes real, specific feature content, not just titles', () => {
  const text = buildKnowledgeBaseForRole('PRODUCER');
  // A Producer must be able to learn how an Owner invites someone, even
  // though they can't do it themselves — this is the exact gap that made
  // ED refuse ordinary "how do I..." questions before this fix.
  assert.match(text, /\+ INVITE/);
  assert.match(text, /Roster Settings/);
  assert.match(text, /\$35/);
  assert.match(text, /\$950/);
  assert.match(text, /Alpha Split/);
});

test('every entry has a non-empty title and body', () => {
  for (const entry of ENTRIES) {
    assert.ok(entry.title && entry.title.length > 0, `entry ${entry.id} missing a title`);
    assert.ok(entry.body && entry.body.length > 0, `entry ${entry.id} missing a body`);
  }
});

test('no entry body contains markdown syntax that would leak as literal characters in the chat UI', () => {
  for (const entry of ENTRIES) {
    assert.doesNotMatch(entry.body, /\*\*/, `entry ${entry.id} contains markdown bold`);
    assert.doesNotMatch(entry.body, /^#/, `entry ${entry.id} contains a markdown header`);
  }
});
