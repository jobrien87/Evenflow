// Parser + validator for the "paste ZIP ranges" bulk-entry box on
// OfficesPanel.jsx. Pure functions, no API calls — the caller owns
// merging the result into the office's own `zipRanges` state and the
// existing save flow. Mirrors server/src/routes/offices.js's own
// zipRangeSchema (5-digit, start<=end) and findGeographyConflict's
// overlap predicate exactly, since the server never checks a submitted
// list against itself — this is the only place that ever will.

// Same defensive parsing OfficesPanel.jsx's load() already applies to the
// current office's own routingZipRanges — exported so sibling offices get
// identical treatment for the cross-office overlap check.
export function normalizeStoredZipRanges(value) {
  try {
    return Array.isArray(value) ? value : JSON.parse(value || '[]');
  } catch {
    return [];
  }
}

function normalizeZipToken(tok) {
  const t = String(tok || '').trim();
  if (!/^[0-9]{1,5}$/.test(t)) return null;
  return t.padStart(5, '0');
}

function normalizeRangeRow(startRaw, endRaw, lineNo, raw) {
  const startBlank = !String(startRaw || '').trim();
  const endBlank = !String(endRaw || '').trim();
  if (startBlank && endBlank) return {};
  const start = normalizeZipToken(startRaw);
  if (!start) return { error: { lineNo, raw, message: `Line ${lineNo}: "${startRaw}" is not a 5-digit zip.` } };
  const end = endBlank ? start : normalizeZipToken(endRaw);
  if (!end) return { error: { lineNo, raw, message: `Line ${lineNo}: "${endRaw}" is not a 5-digit zip.` } };
  if (start > end) return { error: { lineNo, raw, message: `Line ${lineNo}: start ${start} is after end ${end}.` } };
  return { range: { start, end } };
}

// Single-line quote-aware CSV cell splitter (mirrors downloadCsv.js's
// csvEscape in reverse). Scoped to single-line quoted fields — no
// embedded-newline-inside-a-cell support, which real zip/office exports
// never need.
function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

// parseZipRangePaste(rawText) -> {
//   format: 'empty' | 'csv' | 'lines',
//   ranges: Array<{start, end}>,       // valid rows only, in source order, not deduped
//   rowErrors: Array<{lineNo, raw, message}>,
//   officeNamesSeen: string[],          // distinct non-blank values from a CSV "Office" column, if present
// }
export function parseZipRangePaste(rawText) {
  const text = String(rawText || '').replace(/\r\n?/g, '\n');
  const allLines = text.split('\n');
  const firstNonBlankIdx = allLines.findIndex((l) => l.trim());
  if (firstNonBlankIdx === -1) {
    return { format: 'empty', ranges: [], rowErrors: [], officeNamesSeen: [] };
  }

  const headerCells = splitCsvLine(allLines[firstNonBlankIdx]);
  const startIdx = headerCells.findIndex((c) => /^start[\s_]*zip/i.test(c));
  const endIdx = headerCells.findIndex((c) => /^end[\s_]*zip/i.test(c));
  const isCsv = startIdx !== -1 && endIdx !== -1;

  const ranges = [];
  const rowErrors = [];
  const officeNamesSeen = new Set();

  if (isCsv) {
    const officeIdx = headerCells.findIndex((c) => /^office/i.test(c));
    for (let i = firstNonBlankIdx + 1; i < allLines.length; i++) {
      const raw = allLines[i];
      const lineNo = i + 1;
      if (!raw.trim()) continue;
      const cells = splitCsvLine(raw);
      if (officeIdx !== -1 && cells[officeIdx] && cells[officeIdx].trim()) {
        officeNamesSeen.add(cells[officeIdx].trim());
      }
      const result = normalizeRangeRow(cells[startIdx], cells[endIdx], lineNo, raw);
      if (result.error) rowErrors.push(result.error);
      else if (result.range) ranges.push(result.range);
    }
    return { format: 'csv', ranges, rowErrors, officeNamesSeen: [...officeNamesSeen] };
  }

  for (let i = firstNonBlankIdx; i < allLines.length; i++) {
    const raw = allLines[i];
    const lineNo = i + 1;
    const line = raw.trim();
    if (!line) continue;

    // ZIP+4 (e.g. "32008-1234") — must be special-cased before the
    // generic range-separator split below, or it misparses as a range
    // from 32008 to 01234 and fails with a confusing start>end error.
    const zipPlus4 = /^(\d{5})-\d{4}$/.exec(line);
    if (zipPlus4) {
      ranges.push({ start: zipPlus4[1], end: zipPlus4[1] });
      continue;
    }

    const rangeMatch = /^(.+?)\s*(?:-|–|—|\bto\b)\s*(.+)$/i.exec(line);
    const [startRaw, endRaw] = rangeMatch ? [rangeMatch[1], rangeMatch[2]] : [line, line];
    const result = normalizeRangeRow(startRaw, endRaw, lineNo, raw);
    if (result.error) rowErrors.push(result.error);
    else if (result.range) ranges.push(result.range);
  }
  return { format: 'lines', ranges, rowErrors, officeNamesSeen: [] };
}

function rangesOverlap(a, b) {
  return a.start <= b.end && b.start <= a.end;
}

// validateZipRangeBatch({parsedRanges, existingRanges, siblingOffices}) -> {
//   toAdd, duplicatesInPaste, duplicatesOfExisting,
//   overlapsWithinPaste, overlapsWithExisting, overlapsWithOtherOffices,
//   resultingCount, capExceeded, isValid,
// }
export function validateZipRangeBatch({ parsedRanges, existingRanges, siblingOffices }) {
  const toAdd = [];
  const duplicatesInPaste = [];
  const duplicatesOfExisting = [];
  const overlapsWithinPaste = [];
  const overlapsWithExisting = [];
  const overlapsWithOtherOffices = [];

  const siblingRanges = (siblingOffices || []).map((o) => ({
    id: o.id,
    name: o.name,
    ranges: normalizeStoredZipRanges(o.routingZipRanges),
  }));

  for (const r of parsedRanges) {
    const dupExisting = existingRanges.find((e) => e.start === r.start && e.end === r.end);
    if (dupExisting) {
      duplicatesOfExisting.push(r);
      continue;
    }
    const dupInBatch = toAdd.find((e) => e.start === r.start && e.end === r.end);
    if (dupInBatch) {
      duplicatesInPaste.push(r);
      continue;
    }

    for (const e of toAdd) {
      if (rangesOverlap(r, e)) overlapsWithinPaste.push({ a: e, b: r });
    }
    for (const e of existingRanges) {
      if (rangesOverlap(r, e)) overlapsWithExisting.push({ pasted: r, existing: e });
    }
    for (const sib of siblingRanges) {
      for (const theirRange of sib.ranges) {
        if (theirRange && theirRange.start && theirRange.end && rangesOverlap(r, theirRange)) {
          overlapsWithOtherOffices.push({ pasted: r, office: { id: sib.id, name: sib.name }, theirRange });
        }
      }
    }

    toAdd.push(r);
  }

  const resultingCount = existingRanges.length + toAdd.length;
  const capExceeded = resultingCount > 50;
  const isValid =
    overlapsWithinPaste.length === 0 &&
    overlapsWithExisting.length === 0 &&
    overlapsWithOtherOffices.length === 0 &&
    !capExceeded &&
    toAdd.length > 0;

  return {
    toAdd,
    duplicatesInPaste,
    duplicatesOfExisting,
    overlapsWithinPaste,
    overlapsWithExisting,
    overlapsWithOtherOffices,
    resultingCount,
    capExceeded,
    isValid,
  };
}
