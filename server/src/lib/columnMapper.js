// Shared spreadsheet-header-matching helpers for both bulk importers
// (leadBulkImport.js, historicalDataImport.js) — deduplicates the
// normalizeHeader/buildHeaderMap logic the two files used to each define
// separately, adds a lossless full-row capture so no column from a source
// file is ever silently dropped, and adds an optional one-shot AI fallback
// for whatever the deterministic synonym match can't place.
//
// The AI step is a pure best-effort assist on top of the deterministic
// pass, which always runs first and handles the common case for free. It
// follows this app's one established AI contract (lib/aiProvider.js):
// never thrown to the caller, degrades honestly (aiSkippedReason) whenever
// unconfigured, the call fails, or the response doesn't validate, and only
// ever applies 'high'-confidence suggestions.

const { z } = require('zod');
const { callMultiTurn, isConfigured } = require('./aiProvider');

function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// `HEADER_SYNONYMS`: { fieldName: ['synonym1', 'synonym2', ...] } — synonyms
// are already-normalized (normalizeHeader'd) strings. First header to match
// a field's synonym list wins; a field already mapped is never overwritten.
function buildHeaderMap(headerRow, HEADER_SYNONYMS) {
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

// The full original row, keyed by its own literal header text (trimmed) —
// every column, recognized or not, so nothing from the source file is ever
// silently dropped regardless of whether a column matched a known field,
// whether the AI step ran, or whether it was configured at all. Empty
// cells are omitted rather than stored as ''.
function buildRawRowCapture(headerRow, row) {
  const capture = {};
  headerRow.forEach((raw, idx) => {
    const key = String(raw || '').trim();
    if (!key) return;
    const cell = row[idx];
    // A real Excel date cell (read with raw:true + cellDates:true) arrives
    // here as a Date instance — stringify it as a plain date, not
    // Date.prototype.toString()'s locale/timezone-dependent format.
    const value = cell instanceof Date
      ? (Number.isNaN(cell.getTime()) ? '' : cell.toISOString().slice(0, 10))
      : String(cell ?? '').trim();
    if (value === '') return;
    capture[key] = value;
  });
  return capture;
}

const aiSuggestionSchema = z.array(
  z.object({
    header: z.string(),
    suggestedField: z.string().nullable(),
    confidence: z.enum(['high', 'low']),
  })
);

function buildPrompt({ unmappedHeaders, rows, headerRow, fieldDescriptions }) {
  const sampleFor = (headerIndex) =>
    rows
      .slice(0, 3)
      .map((r) => String(r[headerIndex] ?? '').trim())
      .filter((v) => v !== '');

  const headerSamples = unmappedHeaders
    .map((h) => {
      const idx = headerRow.indexOf(h);
      const samples = idx >= 0 ? sampleFor(idx) : [];
      return `- "${h}"${samples.length ? ` (sample values: ${samples.map((s) => `"${s}"`).join(', ')})` : ''}`;
    })
    .join('\n');

  const fieldList = Object.entries(fieldDescriptions)
    .map(([field, meaning]) => `- ${field}: ${meaning}`)
    .join('\n');

  return `You match spreadsheet column headers to a fixed set of known data fields for a bulk import.

Unmapped columns from the uploaded file, with sample values from the first few rows:
${headerSamples}

The only valid target fields (never invent one outside this list):
${fieldList}

Respond with ONLY a JSON array, no markdown fences, no preamble, one entry per unmapped column above, in this exact shape:
[{"header": "<the exact header text as given above>", "suggestedField": "<one of the field names above, or null if none fit>", "confidence": "high" or "low"}]

Use "high" confidence only when you are genuinely confident the column is that field (not merely plausible). Use "low" for anything else you can't rule out but aren't sure of. Use null + "low" when nothing fits. Never guess a field name outside the list given.`;
}

// Runs the deterministic pass first (always free); for any target field in
// `knownFields` still unmapped afterward, makes ONE batched AI call asking
// about every still-unmapped header. Only 'high'-confidence suggestions are
// ever applied, first-match-wins against fields the deterministic pass
// didn't already claim. Never throws — every failure mode (not configured,
// network/HTTP error, non-JSON, schema-invalid) is caught and reported as
// `aiSkippedReason`, with the deterministic-only headerMap still returned.
async function resolveHeaderMapWithAiFallback({ headerRow, rows, HEADER_SYNONYMS, knownFields, fieldDescriptions, headerMap: initialHeaderMap }) {
  const headerMap = { ...(initialHeaderMap || buildHeaderMap(headerRow, HEADER_SYNONYMS)) };
  const mappedIndexes = new Set(Object.values(headerMap));
  const unmappedFields = knownFields.filter((f) => headerMap[f] === undefined);
  const unmappedHeaders = headerRow.filter((h, idx) => normalizeHeader(h) && !mappedIndexes.has(idx));

  if (unmappedFields.length === 0 || unmappedHeaders.length === 0) {
    return { headerMap, aiUsed: false, aiSkippedReason: 'nothing_unmapped', aiSuggestions: [], unmappedHeaders };
  }
  if (!isConfigured()) {
    return { headerMap, aiUsed: false, aiSkippedReason: 'not_configured', aiSuggestions: [], unmappedHeaders };
  }

  const prompt = buildPrompt({
    unmappedHeaders,
    rows,
    headerRow,
    fieldDescriptions: Object.fromEntries(unmappedFields.map((f) => [f, fieldDescriptions[f] || f])),
  });

  let result;
  try {
    result = await callMultiTurn({ systemPrompt: prompt, messages: [{ role: 'user', content: 'Map these columns.' }], maxTokens: 800 });
  } catch {
    return { headerMap, aiUsed: false, aiSkippedReason: 'error', aiSuggestions: [], unmappedHeaders };
  }
  if (!result.available) {
    return { headerMap, aiUsed: false, aiSkippedReason: 'not_configured', aiSuggestions: [], unmappedHeaders };
  }

  let parsed;
  try {
    const cleaned = result.text.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return { headerMap, aiUsed: false, aiSkippedReason: 'invalid_response', aiSuggestions: [], unmappedHeaders };
  }
  const validated = aiSuggestionSchema.safeParse(parsed);
  if (!validated.success) {
    return { headerMap, aiUsed: false, aiSkippedReason: 'invalid_response', aiSuggestions: [], unmappedHeaders };
  }
  const aiSuggestions = validated.data.filter((s) => s.suggestedField === null || unmappedFields.includes(s.suggestedField));

  const claimedFields = new Set();
  const stillUnmapped = new Set(unmappedHeaders);
  for (const s of aiSuggestions) {
    if (s.confidence !== 'high' || !s.suggestedField) continue;
    if (claimedFields.has(s.suggestedField)) continue;
    const idx = headerRow.indexOf(s.header);
    if (idx < 0 || headerMap[s.suggestedField] !== undefined) continue;
    headerMap[s.suggestedField] = idx;
    claimedFields.add(s.suggestedField);
    stillUnmapped.delete(s.header);
  }

  return { headerMap, aiUsed: true, aiSkippedReason: null, aiSuggestions, unmappedHeaders: [...stillUnmapped] };
}

module.exports = { normalizeHeader, buildHeaderMap, buildRawRowCapture, resolveHeaderMapWithAiFallback };
