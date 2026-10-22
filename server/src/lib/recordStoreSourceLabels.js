// Translates a raw lead-exchange source code (e.g. "Fidadto") into the
// EvenFlow-branded display name shown to any user ("EvenFlow A") — the
// raw code must never reach a screen directly (it names a real upstream
// partner, the same "never pass that name to a user" rule
// lib/boberdoo.js's own user-facing error messages follow).
//
// The cadence (A, B, C, ...) comes from RecordStoreSourceLabel's own
// insertion-order id, not a hand-maintained map, so a brand-new source
// code gets the next letter automatically the first time EvenFlow ever
// sees it (e.g. in a delivery payload or a getVendorsAndSources response)
// — see prisma/seed.js for how the first 3 (confirmed-real) codes got
// A/B/C.
const { prisma } = require('./db');

// 1 -> A, 2 -> B, ..., 26 -> Z, 27 -> AA, 28 -> AB, ... — standard
// bijective base-26 letters, 1-indexed so id 1 is "A" not "B".
function idToLetters(id) {
  let n = id;
  let letters = '';
  while (n > 0) {
    n -= 1;
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26);
  }
  return letters;
}

function idToLabel(id) {
  return `EvenFlow ${idToLetters(id)}`;
}

// Looks up this source code's label, assigning (and persisting) the next
// one in the cadence the first time this exact code is ever seen. Safe
// under concurrency: a lost create race (two deliveries reporting the
// same brand-new code at once) just means the loser re-reads the
// winner's row rather than erroring.
async function getOrCreateSourceLabel(sourceCode) {
  const existing = await prisma.recordStoreSourceLabel.findUnique({ where: { sourceCode } });
  if (existing) return idToLabel(existing.id);

  try {
    const created = await prisma.recordStoreSourceLabel.create({ data: { sourceCode } });
    return idToLabel(created.id);
  } catch (err) {
    if (err.code === 'P2002') {
      const row = await prisma.recordStoreSourceLabel.findUnique({ where: { sourceCode } });
      if (row) return idToLabel(row.id);
    }
    throw err;
  }
}

// [rawCode, ...] -> [{ value: rawCode, label: 'EvenFlow A' }, ...] — the
// shape every sources-facing API response/UI list uses: value is what
// gets sent back (and what Boberdoo's own Accepted_Sources needs), label
// is the only thing ever rendered.
async function labelSources(sourceCodes) {
  return Promise.all(sourceCodes.map(async (value) => ({ value, label: await getOrCreateSourceLabel(value) })));
}

// Decodes a comma-separated Accepted_Sources string (as stored in a real
// Boberdoo filter set / customConfigurationJson) into display labels, for
// any screen that shows a subscription's own currently-accepted sources
// back to a user.
async function decodeAcceptedSources(csv) {
  if (!csv) return [];
  const codes = String(csv).split(',').map((c) => c.trim()).filter(Boolean);
  const labeled = await labelSources(codes);
  return labeled.map((l) => l.label);
}

module.exports = { getOrCreateSourceLabel, labelSources, decodeAcceptedSources, idToLabel };
