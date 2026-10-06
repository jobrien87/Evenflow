// Per-vendor lead distribution: an agency owner picks, per vendor, whether
// inbound leads round-robin across every active producer, round-robin
// across a hand-picked subset, split across the agency's offices (by real
// geography when configured, with an explicit alpha-split or round-robin
// producer rule per office), or land unassigned in the Moshpit for any
// eligible producer to claim.

// Pure and independently testable: given how many times this vendor has
// ever assigned a lead (a monotonically increasing cursor) and how many
// candidates are eligible right now, which candidate is next.
function pickAgentIndex(cursor, candidateCount) {
  if (!Number.isInteger(candidateCount) || candidateCount <= 0) return null;
  const normalizedCursor = ((cursor % candidateCount) + candidateCount) % candidateCount;
  return normalizedCursor;
}

// Offices that currently have at least one ACTIVE producer — shared by
// every OFFICE_SPLIT caller (vendor-sourced and manual/bulk-import alike)
// as the legacy cross-office fallback when no office's geography rules
// match a given lead, in the same sorted-id candidate order every other
// mode uses.
async function fetchOfficesWithActiveAgents(tx, agencyId) {
  const offices = await tx.office.findMany({
    where: { agencyId },
    include: { users: { where: { role: 'PRODUCER', status: 'ACTIVE' }, select: { id: true }, orderBy: { id: 'asc' } } },
    orderBy: { id: 'asc' },
  });
  return offices.filter((o) => o.users.length > 0);
}

// The eligible-producer candidate pool for SELECTED_AGENTS (restricted to
// a hand-picked subset) or ROUND_ROBIN (every active producer in the
// agency) — shared by every mode that round-robins across a flat
// candidate list rather than an office hierarchy.
async function fetchCandidateIds(tx, { agencyId, mode, selectedAgentIds }) {
  if (mode === 'SELECTED_AGENTS') {
    if (!selectedAgentIds || selectedAgentIds.length === 0) return [];
    const activeSelected = await tx.user.findMany({
      where: { id: { in: selectedAgentIds }, role: 'PRODUCER', status: 'ACTIVE', agencyId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return activeSelected.map((u) => u.id);
  }
  const activeProducers = await tx.user.findMany({
    where: { agencyId, role: 'PRODUCER', status: 'ACTIVE' },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return activeProducers.map((u) => u.id);
}

// Zero-pads a zip (or zip-like value) to a 5-digit string so range
// comparison is a safe plain string comparison regardless of leading
// zeros. Returns null for anything that isn't at least one digit.
function normalizeZip(zip) {
  const digits = String(zip || '').trim().replace(/[^0-9]/g, '');
  if (!digits) return null;
  return digits.slice(0, 5).padStart(5, '0');
}

function normalizeCity(city) {
  return String(city || '').trim().toUpperCase();
}

// Stage 1 of office-aware distribution: which Office should handle a lead,
// given its city/zip. Checked in order: an exact zip-range match, then an
// exact city-name match, then whichever office has isDefaultOffice:true.
// Returns { office, useLegacyFallback, reason }:
//   - office set, useLegacyFallback:false — a real geography/default match.
//   - office null, useLegacyFallback:true — no geography/default match;
//     caller should fall back to today's existing
//     fetchOfficesWithActiveAgents round-robin-across-offices behavior.
//   - office null, useLegacyFallback:false, reason set — the agency has no
//     offices at all; go straight to the Moshpit.
async function resolveOfficeForLead(tx, { agencyId, city, zip }) {
  const offices = await tx.office.findMany({ where: { agencyId }, include: { alphaAssignments: true } });
  if (offices.length === 0) {
    return { office: null, useLegacyFallback: false, reason: 'This agency has no offices configured — sent to the Moshpit' };
  }

  const normalizedZip = normalizeZip(zip);
  if (normalizedZip) {
    for (const office of offices) {
      let ranges = [];
      try {
        ranges = Array.isArray(office.routingZipRanges) ? office.routingZipRanges : JSON.parse(office.routingZipRanges || '[]');
      } catch {
        ranges = [];
      }
      const matches = ranges.some((r) => r && r.start && r.end && normalizedZip >= r.start && normalizedZip <= r.end);
      if (matches) return { office, useLegacyFallback: false, reason: null };
    }
  }

  const normalizedCity = normalizeCity(city);
  if (normalizedCity) {
    for (const office of offices) {
      if ((office.routingCities || []).includes(normalizedCity)) {
        return { office, useLegacyFallback: false, reason: null };
      }
    }
  }

  const defaultOffice = offices.find((o) => o.isDefaultOffice);
  if (defaultOffice) {
    return { office: defaultOffice, useLegacyFallback: false, reason: null };
  }

  return { office: null, useLegacyFallback: true, reason: null };
}

// Stage 2 for an office whose routingMode is ALPHA_SPLIT: match the lead's
// last name's first letter against the office's non-fallback
// OfficeAlphaAssignment rows (filtered to ACTIVE producers still actually
// assigned to this office — a claim never silently follows a producer who
// left or moved), else the one isFallback:true row, else null with an
// honest reason — never a silent/hidden fallback.
async function officeAlphaAssignee(tx, { office, lastName }) {
  const A = 'A'.charCodeAt(0);
  const Z = 'Z'.charCodeAt(0);
  const firstChar = (lastName || '').trim().toUpperCase().charCodeAt(0) || A;
  const letter = String.fromCharCode(Math.min(Math.max(firstChar, A), Z));

  const assignments = office.alphaAssignments || (await tx.officeAlphaAssignment.findMany({ where: { officeId: office.id } }));
  if (assignments.length === 0) {
    return { assignedToId: null, reason: `Alpha-split not configured for ${office.name} — sent to the Moshpit` };
  }

  const eligibleUserIds = new Set(
    (await tx.user.findMany({
      where: { id: { in: assignments.map((a) => a.userId) }, role: 'PRODUCER', status: 'ACTIVE', officeId: office.id },
      select: { id: true },
    })).map((u) => u.id)
  );

  const claim = assignments.find((a) => !a.isFallback && eligibleUserIds.has(a.userId) && a.letters.includes(letter));
  if (claim) return { assignedToId: claim.userId, reason: null };

  const fallback = assignments.find((a) => a.isFallback && eligibleUserIds.has(a.userId));
  if (fallback) return { assignedToId: fallback.userId, reason: null };

  return { assignedToId: null, reason: `No active producer claims letter "${letter}" at ${office.name}, and its fallback producer is unavailable — sent to the Moshpit` };
}

// Stage 2 for an office whose routingMode is ROUND_ROBIN: plain round robin
// over that office's own ACTIVE producers, keyed to the office's own
// cursor (not derived from any vendor).
async function officeRoundRobinAssignee(tx, { office }) {
  const activeProducers = await tx.user.findMany({
    where: { officeId: office.id, role: 'PRODUCER', status: 'ACTIVE' },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  if (activeProducers.length === 0) {
    return { assignedToId: null, reason: `No active producers at ${office.name} — sent to the Moshpit` };
  }
  const updatedOffice = await tx.office.update({
    where: { id: office.id },
    data: { roundRobinCursor: { increment: 1 } },
    select: { roundRobinCursor: true },
  });
  const index = pickAgentIndex(updatedOffice.roundRobinCursor, activeProducers.length);
  return { assignedToId: activeProducers[index].id, reason: null };
}

// Shared by resolveVendorAssignment/resolveManualAssignment's OFFICE_SPLIT/
// ALPHA_SPLIT branches: resolve stage 1 (which office), falling back to the
// legacy cross-office round robin when geography doesn't match, then
// dispatch stage 2 by THAT OFFICE'S OWN routingMode — never the vendor's
// own mode, since a telemarketer-sourced lead (handled entirely outside
// this module — see Part 3's notes elsewhere) has no Vendor row at all to
// read a mode from, and a vendor whose leads span two offices may
// legitimately want each office routed differently.
async function resolveOfficeAwareAssignment(tx, { agencyId, city, zip, lastName }) {
  const stage1 = await resolveOfficeForLead(tx, { agencyId, city, zip });

  let office = stage1.office;
  if (!office && stage1.useLegacyFallback) {
    const officesWithAgents = await fetchOfficesWithActiveAgents(tx, agencyId);
    if (officesWithAgents.length === 0) {
      return { assignedToId: null, mode: 'MOSHPIT', reason: 'No offices with active producers — sent to the Moshpit' };
    }
    // No geography/default configured for this agency yet — round-robin
    // across offices using each office's own cursor as a "least recently
    // used" signal (the same cursor officeRoundRobinAssignee below
    // increments for a ROUND_ROBIN office), rather than inventing a
    // second shared counter just for this transitional fallback path.
    office = officesWithAgents.reduce((least, o) => (o.roundRobinCursor < least.roundRobinCursor ? o : least));
  }

  if (!office) {
    return { assignedToId: null, mode: 'MOSHPIT', reason: stage1.reason || 'No office could be resolved for this lead — sent to the Moshpit' };
  }

  if (office.routingMode === 'ALPHA_SPLIT') {
    const result = await officeAlphaAssignee(tx, { office, lastName });
    if (!result.assignedToId) return { assignedToId: null, mode: 'MOSHPIT', reason: result.reason };
    return { assignedToId: result.assignedToId, mode: 'OFFICE_SPLIT', reason: null };
  }

  const result = await officeRoundRobinAssignee(tx, { office });
  if (!result.assignedToId) return { assignedToId: null, mode: 'MOSHPIT', reason: result.reason };
  return { assignedToId: result.assignedToId, mode: 'OFFICE_SPLIT', reason: null };
}

// Resolves who a vendor's newly-created lead should be assigned to, per
// that vendor's configured distributionMode. Must run inside the same
// $transaction as the Lead create so the cursor increment and the lead
// row are atomic together. Returns { assignedToId, mode, reason } —
// assignedToId is null for MOSHPIT (by choice) or when no eligible
// producer exists (a real fallback, not a silent drop — reason explains
// why so it can be logged/notified honestly).
// `context.lastName`/`context.city`/`context.zip` are read only by
// OFFICE_SPLIT/ALPHA_SPLIT — every other mode ignores them.
async function resolveVendorAssignment(tx, vendor, context = {}) {
  if (vendor.distributionMode === 'MOSHPIT') {
    return { assignedToId: null, mode: 'MOSHPIT', reason: null };
  }

  if (vendor.distributionMode === 'OFFICE_SPLIT' || vendor.distributionMode === 'ALPHA_SPLIT') {
    return resolveOfficeAwareAssignment(tx, { agencyId: vendor.agencyId, city: context.city, zip: context.zip, lastName: context.lastName });
  }

  const candidateIds = await fetchCandidateIds(tx, { agencyId: vendor.agencyId, mode: vendor.distributionMode, selectedAgentIds: vendor.selectedAgentIds });
  if (candidateIds.length === 0) {
    const reason = vendor.distributionMode === 'SELECTED_AGENTS'
      ? 'No agents selected for this vendor — sent to the Moshpit'
      : 'No eligible producers available — sent to the Moshpit';
    return { assignedToId: null, mode: 'MOSHPIT', reason };
  }

  const updatedVendor = await tx.vendor.update({
    where: { id: vendor.id },
    data: { roundRobinCursor: { increment: 1 } },
    select: { roundRobinCursor: true },
  });
  const index = pickAgentIndex(updatedVendor.roundRobinCursor, candidateIds.length);
  return { assignedToId: candidateIds[index], mode: vendor.distributionMode, reason: null };
}

// Same modes/vocabulary as resolveVendorAssignment, for a context with no
// Vendor row to hold a persisted cursor — a bulk CSV/XLS import, where an
// Agency Owner/Manager picks one distributionMode for the whole batch at
// upload time. Safe to use a plain in-memory cursor for ROUND_ROBIN/
// SELECTED_AGENTS (not an atomic DB increment) because one bulk-import
// request processes its rows sequentially, in a single process — unlike
// vendor webhook POSTs, which can race each other, nothing else is
// concurrently advancing this same cursor. The caller owns that cursor's
// lifetime (pass 0 for the first row of a batch, then feed each result's
// nextCursor into the next call) — nothing here persists it.
// OFFICE_SPLIT/ALPHA_SPLIT ignore `cursor` entirely — their stage-2
// producer cursor lives on the Office row itself, same as the vendor path.
async function resolveManualAssignment(tx, { agencyId, mode, selectedAgentIds, cursor = 0, lastName, city, zip } = {}) {
  if (mode === 'MOSHPIT') {
    return { assignedToId: null, mode: 'MOSHPIT', reason: null, nextCursor: cursor };
  }

  if (mode === 'OFFICE_SPLIT' || mode === 'ALPHA_SPLIT') {
    const result = await resolveOfficeAwareAssignment(tx, { agencyId, city, zip, lastName });
    return { ...result, nextCursor: cursor };
  }

  const candidateIds = await fetchCandidateIds(tx, { agencyId, mode, selectedAgentIds });
  if (candidateIds.length === 0) {
    const reason = mode === 'SELECTED_AGENTS'
      ? 'No producers selected for this import — sent to the Moshpit'
      : 'No eligible producers available — sent to the Moshpit';
    return { assignedToId: null, mode: 'MOSHPIT', reason, nextCursor: cursor };
  }

  const nextCursor = cursor + 1;
  const index = pickAgentIndex(nextCursor, candidateIds.length);
  return { assignedToId: candidateIds[index], mode, reason: null, nextCursor };
}

module.exports = {
  pickAgentIndex,
  normalizeZip,
  normalizeCity,
  resolveOfficeForLead,
  officeAlphaAssignee,
  officeRoundRobinAssignee,
  resolveVendorAssignment,
  resolveManualAssignment,
};
