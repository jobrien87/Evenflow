// Shared "who counts as production-eligible roster" definition for
// financials.js's /by-agent and billboard.js's activeProducersQuery — an
// active AGENCY_MANAGER who actually sells (e.g. a manager who also
// carries her own book of business) must retain her own production
// credit, not just plain PRODUCERs. Deliberately NOT reused by
// leadDistribution.js's role filters, which are each asymmetric on
// purpose (some pools are producer-only by design, some include managers
// only for Alpha-seat routing) — folding those in here would risk the
// exact kind of accidental cross-contamination this file exists to
// prevent.
const ELIGIBLE_PRODUCTION_ROLES = ['PRODUCER', 'AGENCY_MANAGER'];

function eligibleProducersWhere(agencyId, extra = {}) {
  return { agencyId, role: { in: ELIGIBLE_PRODUCTION_ROLES }, status: 'ACTIVE', ...extra };
}

module.exports = { ELIGIBLE_PRODUCTION_ROLES, eligibleProducersWhere };
