const { prisma } = require('./db');

// Given a qualified transfer (product/state), find the single best eligible
// agency to offer it to, based on:
//   - agency is ACTIVE (not paused/archived)
//   - transfersEnabled
//   - not manually paused
//   - the telemarketer is currently assigned to that agency (ACTIVE assignment)
//   - agency accepts the product (empty products[] = accepts all)
//   - agency accepts the state (empty transferStates[] = accepts all)
//   - daily cap not exceeded
//
// Returns { agencyId, reason } or { agencyId: null, reason } if none eligible.
// CRITICAL: if nothing is eligible, we still return a definite reason and the
// caller records NO_ELIGIBLE_DESTINATION — the transfer is never silently dropped.
async function findEligibleAgency({ telemarketerId, product, state }) {
  const assignments = await prisma.telemarketerAssignment.findMany({
    where: { telemarketerId, status: 'ACTIVE' },
    include: { agency: true },
  });

  if (assignments.length === 0) {
    return { agencyId: null, reason: 'Telemarketer has no active agency assignments.' };
  }

  const candidates = [];

  for (const a of assignments) {
    const agency = a.agency;
    if (agency.status !== 'ACTIVE') {
      candidates.push({ agencyId: agency.id, eligible: false, reason: `Agency status is ${agency.status}` });
      continue;
    }
    if (!agency.transfersEnabled) {
      candidates.push({ agencyId: agency.id, eligible: false, reason: 'Agency has not enabled Yield Transfers' });
      continue;
    }
    if (agency.transferPaused) {
      candidates.push({ agencyId: agency.id, eligible: false, reason: 'Agency has paused transfers' });
      continue;
    }
    if (agency.products.length > 0 && product && !agency.products.includes(product)) {
      candidates.push({ agencyId: agency.id, eligible: false, reason: `Agency does not accept product ${product}` });
      continue;
    }
    if (agency.transferStates.length > 0 && state && !agency.transferStates.includes(state)) {
      candidates.push({ agencyId: agency.id, eligible: false, reason: `Agency does not accept state ${state}` });
      continue;
    }
    if (agency.transferDailyCap) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const acceptedToday = await prisma.transfer.count({
        where: {
          agencyId: agency.id,
          status: { in: ['ACCEPTED', 'CONNECTED', 'COMPLETED', 'DISPOSITIONED'] },
          respondedAt: { gte: startOfDay },
        },
      });
      if (acceptedToday >= agency.transferDailyCap) {
        candidates.push({ agencyId: agency.id, eligible: false, reason: 'Agency daily transfer cap reached' });
        continue;
      }
    }

    candidates.push({ agencyId: agency.id, eligible: true, reason: 'Eligible: active assignment, product/state match, under cap' });
  }

  const eligible = candidates.find((c) => c.eligible);
  if (eligible) {
    return { agencyId: eligible.agencyId, reason: eligible.reason, allCandidates: candidates };
  }

  const reasonSummary = candidates.map((c) => c.reason).join('; ') || 'No assigned agencies found.';
  return { agencyId: null, reason: `NO_ELIGIBLE_DESTINATION: ${reasonSummary}`, allCandidates: candidates };
}

module.exports = { findEligibleAgency };
