// Real-DB tests for the EvenFlow-branded source-label cadence — "Fidadto"
// -> "EvenFlow A", a brand-new code gets the next letter the first time
// it's ever seen, and the cadence never renumbers once assigned.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prisma } = require('./db');
const { getOrCreateSourceLabel, labelSources, decodeAcceptedSources, idToLabel } = require('./recordStoreSourceLabels');

const suffix = Date.now();
const createdCodes = [];

after(async () => {
  await prisma.recordStoreSourceLabel.deleteMany({ where: { sourceCode: { in: createdCodes } } });
  await prisma.$disconnect();
});

test('idToLabel follows the A, B, ... Z, AA, AB cadence', () => {
  assert.equal(idToLabel(1), 'EvenFlow A');
  assert.equal(idToLabel(2), 'EvenFlow B');
  assert.equal(idToLabel(26), 'EvenFlow Z');
  assert.equal(idToLabel(27), 'EvenFlow AA');
  assert.equal(idToLabel(28), 'EvenFlow AB');
});

test('a brand-new source code is assigned the next label in sequence and never reassigned on re-lookup', async () => {
  const code = `test-source-${suffix}-first`;
  createdCodes.push(code);

  const first = await getOrCreateSourceLabel(code);
  assert.ok(/^EvenFlow [A-Z]+$/.test(first));

  const second = await getOrCreateSourceLabel(code);
  assert.equal(second, first, 're-looking up the same code must return the exact same label, never a new one');
});

test('labelSources returns { value, label } pairs preserving the raw code as value', async () => {
  const codeA = `test-source-${suffix}-a`;
  const codeB = `test-source-${suffix}-b`;
  createdCodes.push(codeA, codeB);

  const results = await labelSources([codeA, codeB]);
  assert.equal(results.length, 2);
  assert.equal(results[0].value, codeA);
  assert.equal(results[1].value, codeB);
  assert.notEqual(results[0].label, results[1].label, 'two distinct new codes must get two distinct labels');
  assert.ok(results.every((r) => r.label.startsWith('EvenFlow ')));
});

test('decodeAcceptedSources turns a comma-separated Accepted_Sources string into display labels', async () => {
  const codeA = `test-source-${suffix}-csv-a`;
  const codeB = `test-source-${suffix}-csv-b`;
  createdCodes.push(codeA, codeB);

  const labelA = await getOrCreateSourceLabel(codeA);
  const labelB = await getOrCreateSourceLabel(codeB);

  const decoded = await decodeAcceptedSources(`${codeA},${codeB}`);
  assert.deepEqual(decoded, [labelA, labelB]);

  assert.deepEqual(await decodeAcceptedSources(''), []);
  assert.deepEqual(await decodeAcceptedSources(null), []);
});

test('the 3 seeded production source codes already have real labels (seed.js)', async () => {
  const rows = await prisma.recordStoreSourceLabel.findMany({
    where: { sourceCode: { in: ['Fidadto', 'Quoting_Fast', 'Visiqua'] } },
    orderBy: { id: 'asc' },
  });
  assert.equal(rows.length, 3, 'prisma/seed.js should have seeded all 3 confirmed-real source codes');
});
