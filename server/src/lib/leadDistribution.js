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
    const offices = await tx.office.findMany({
      where: { agencyId: vendor.agencyId },
      include: { users: { where: { role: 'PRODUCER', status: 'ACTIVE' }, select: { id: true }, orderBy: { id: 'asc' } } },
      orderBy: { id: 'asc' },
    });
    const officesWithAgents = offices.filter((o) => o.users.length > 0);
    if (officesWithAgents.length === 0) {
      return { assignedToId: null, mode: 'MOSHPIT', reason: 'No offices with active producers — sent to the Moshpit' };
    }
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

  let candidateIds;
  if (vendor.distributionMode === 'SELECTED_AGENTS') {
    if (!vendor.selectedAgentIds || vendor.selectedAgentIds.length === 0) {
      return { assignedToId: null, mode: 'MOSHPIT', reason: 'No agents selected for this vendor — sent to the Moshpit' };
    }
    const activeSelected = await tx.user.findMany({
      where: {
        id: { in: vendor.selectedAgentIds },
        role: 'PRODUCER',
        status: 'ACTIVE',
        agencyId: vendor.agencyId,
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    candidateIds = activeSelected.map((u) => u.id);
  } else {
    const activeProducers = await tx.user.findMany({
      where: { agencyId: vendor.agencyId, role: 'PRODUCER', status: 'ACTIVE' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    candidateIds = activeProducers.map((u) => u.id);
  }

  if (candidateIds.length === 0) {
    return { assignedToId: null, mode: 'MOSHPIT', reason: 'No eligible producers available — sent to the Moshpit' };
  }

  if (vendor.distributionMode === 'ALPHA_SPLIT') {
    const index = alphaSplitIndex(context.lastName, candidateIds.length);
    return { assignedToId: candidateIds[index], mode: 'ALPHA_SPLIT', reason: null };
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

  const index = pickAgentIndex(updatedVendor.roundRobinCursor, candidateIds.length);
  return { assignedToId: candidateIds[index], mode: vendor.distributionMode, reason: null };
}

module.exports = { pickAgentIndex, alphaSplitIndex, resolveVendorAssignment };
