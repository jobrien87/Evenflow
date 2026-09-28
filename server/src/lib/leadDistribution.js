// Per-vendor lead distribution: an agency owner picks, per vendor, whether
// inbound leads round-robin across every active producer, round-robin
// across a hand-picked subset, or land unassigned in the Moshpit for any
// eligible producer to claim.

// Pure and independently testable: given how many times this vendor has
// ever assigned a lead (a monotonically increasing cursor) and how many
// candidates are eligible right now, which candidate is next.
function pickAgentIndex(cursor, candidateCount) {
  if (!Number.isInteger(candidateCount) || candidateCount <= 0) return null;
  const normalizedCursor = ((cursor % candidateCount) + candidateCount) % candidateCount;
  return normalizedCursor;
}

// Resolves who a vendor's newly-created lead should be assigned to, per
// that vendor's configured distributionMode. Must run inside the same
// $transaction as the Lead create so the cursor increment and the lead
// row are atomic together. Returns { assignedToId, mode, reason } —
// assignedToId is null for MOSHPIT (by choice) or when no eligible
// producer exists (a real fallback, not a silent drop — reason explains
// why so it can be logged/notified honestly).
async function resolveVendorAssignment(tx, vendor) {
  if (vendor.distributionMode === 'MOSHPIT') {
    return { assignedToId: null, mode: 'MOSHPIT', reason: null };
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

module.exports = { pickAgentIndex, resolveVendorAssignment };
