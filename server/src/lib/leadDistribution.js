// Per-vendor lead distribution: an agency owner picks, per vendor, whether
// inbound leads round-robin across every active producer, round-robin
// across a hand-picked subset, split alphabetically by the customer's last
// name, split across the agency's offices (then round-robin within
// whichever office is picked), or land unassigned in the Moshpit for any
// eligible producer to claim.

// Pure and independently testable: given how many times this vendor has
// ever assigned a lead (a monotonically increasing cursor) and how many
// candidates are eligible right now, which candidate is next.
function pickAgentIndex(cursor, candidateCount) {
  if (!Number.isInteger(candidateCount) || candidateCount <= 0) return null;
  const normalizedCursor = ((cursor % candidateCount) + candidateCount) % candidateCount;
  return normalizedCursor;
}

// Partitions A-Z into `candidateCount` contiguous ranges (in sorted-id
// order, matching every other mode's candidate ordering) and returns
// which range this last name's first letter falls into. Non-letter/empty
// names clamp to the A range rather than being dropped — every lead still
// gets a deterministic home.
function alphaSplitIndex(lastName, candidateCount) {
  if (!Number.isInteger(candidateCount) || candidateCount <= 0) return null;
  const A = 'A'.charCodeAt(0);
  const Z = 'Z'.charCodeAt(0);
  const firstChar = (lastName || '').trim().toUpperCase().charCodeAt(0) || A;
  const clamped = Math.min(Math.max(firstChar, A), Z);
  const position = clamped - A; // 0-25
  const bucketSize = 26 / candidateCount;
  return Math.min(candidateCount - 1, Math.floor(position / bucketSize));
}

// Offices that currently have at least one ACTIVE producer — shared by
// every OFFICE_SPLIT caller (vendor-sourced and manual/bulk-import alike),
// in the same sorted-id candidate order every other mode uses.
async function fetchOfficesWithActiveAgents(tx, agencyId) {
  const offices = await tx.office.findMany({
    where: { agencyId },
    include: { users: { where: { role: 'PRODUCER', status: 'ACTIVE' }, select: { id: true }, orderBy: { id: 'asc' } } },
    orderBy: { id: 'asc' },
  });
  return offices.filter((o) => o.users.length > 0);
}

// The eligible-producer candidate pool for SELECTED_AGENTS (restricted to
// a hand-picked subset) or ROUND_ROBIN/ALPHA_SPLIT (every active producer
// in the agency) — shared by every mode that round-robins/splits across a
// flat candidate list rather than an office hierarchy.
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

// Resolves who a vendor's newly-created lead should be assigned to, per
// that vendor's configured distributionMode. Must run inside the same
// $transaction as the Lead create so the cursor increment and the lead
// row are atomic together. Returns { assignedToId, mode, reason } —
// assignedToId is null for MOSHPIT (by choice) or when no eligible
// producer exists (a real fallback, not a silent drop — reason explains
// why so it can be logged/notified honestly).
// `context.lastName` is required for ALPHA_SPLIT (the lead's customer's
// last name) — every other mode ignores it.
async function resolveVendorAssignment(tx, vendor, context = {}) {
  if (vendor.distributionMode === 'MOSHPIT') {
    return { assignedToId: null, mode: 'MOSHPIT', reason: null };
  }

  if (vendor.distributionMode === 'OFFICE_SPLIT') {
    const officesWithAgents = await fetchOfficesWithActiveAgents(tx, vendor.agencyId);
    if (officesWithAgents.length === 0) {
      return { assignedToId: null, mode: 'MOSHPIT', reason: 'No offices with active producers — sent to the Moshpit' };
    }
    // A single atomic UPDATE ... SET cursor = cursor + 1 RETURNING cursor —
    // under concurrent vendor webhook POSTs this is what keeps two
    // simultaneous requests from both computing the same "next" agent
    // (a naive read-then-write of the cursor would race here).
    const updatedVendor = await tx.vendor.update({
      where: { id: vendor.id },
      data: { roundRobinCursor: { increment: 1 } },
      select: { roundRobinCursor: true },
    });
    const officeIndex = pickAgentIndex(updatedVendor.roundRobinCursor, officesWithAgents.length);
    const office = officesWithAgents[officeIndex];
    const agentCursor = Math.floor(updatedVendor.roundRobinCursor / officesWithAgents.length);
    const agentIndex = pickAgentIndex(agentCursor, office.users.length);
    return { assignedToId: office.users[agentIndex].id, mode: 'OFFICE_SPLIT', reason: null };
  }

  const candidateIds = await fetchCandidateIds(tx, { agencyId: vendor.agencyId, mode: vendor.distributionMode, selectedAgentIds: vendor.selectedAgentIds });
  if (candidateIds.length === 0) {
    const reason = vendor.distributionMode === 'SELECTED_AGENTS'
      ? 'No agents selected for this vendor — sent to the Moshpit'
      : 'No eligible producers available — sent to the Moshpit';
    return { assignedToId: null, mode: 'MOSHPIT', reason };
  }

  if (vendor.distributionMode === 'ALPHA_SPLIT') {
    const index = alphaSplitIndex(context.lastName, candidateIds.length);
    return { assignedToId: candidateIds[index], mode: 'ALPHA_SPLIT', reason: null };
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
// upload time. Safe to use a plain in-memory cursor (not an atomic DB
// increment) because one bulk-import request processes its rows
// sequentially, in a single process — unlike vendor webhook POSTs, which
// can race each other, nothing else is concurrently advancing this same
// cursor. The caller owns the cursor's lifetime (pass 0 for the first row
// of a batch, then feed each result's nextCursor into the next call) —
// nothing here persists it.
async function resolveManualAssignment(tx, { agencyId, mode, selectedAgentIds, cursor = 0, lastName } = {}) {
  if (mode === 'MOSHPIT') {
    return { assignedToId: null, mode: 'MOSHPIT', reason: null, nextCursor: cursor };
  }

  if (mode === 'OFFICE_SPLIT') {
    const officesWithAgents = await fetchOfficesWithActiveAgents(tx, agencyId);
    if (officesWithAgents.length === 0) {
      return { assignedToId: null, mode: 'MOSHPIT', reason: 'No offices with active producers — sent to the Moshpit', nextCursor: cursor };
    }
    const nextCursor = cursor + 1;
    const officeIndex = pickAgentIndex(nextCursor, officesWithAgents.length);
    const office = officesWithAgents[officeIndex];
    const agentCursor = Math.floor(nextCursor / officesWithAgents.length);
    const agentIndex = pickAgentIndex(agentCursor, office.users.length);
    return { assignedToId: office.users[agentIndex].id, mode: 'OFFICE_SPLIT', reason: null, nextCursor };
  }

  const candidateIds = await fetchCandidateIds(tx, { agencyId, mode, selectedAgentIds });
  if (candidateIds.length === 0) {
    const reason = mode === 'SELECTED_AGENTS'
      ? 'No producers selected for this import — sent to the Moshpit'
      : 'No eligible producers available — sent to the Moshpit';
    return { assignedToId: null, mode: 'MOSHPIT', reason, nextCursor: cursor };
  }

  if (mode === 'ALPHA_SPLIT') {
    const index = alphaSplitIndex(lastName, candidateIds.length);
    return { assignedToId: candidateIds[index], mode: 'ALPHA_SPLIT', reason: null, nextCursor: cursor };
  }

  const nextCursor = cursor + 1;
  const index = pickAgentIndex(nextCursor, candidateIds.length);
  return { assignedToId: candidateIds[index], mode, reason: null, nextCursor };
}

module.exports = { pickAgentIndex, alphaSplitIndex, resolveVendorAssignment, resolveManualAssignment };
