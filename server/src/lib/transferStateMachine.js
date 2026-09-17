// Valid transitions. Every transition is recorded as a TransferEvent — history
// is never overwritten, only appended to.
const TRANSITIONS = {
  LEAD_CAPTURED: ['QUALIFYING', 'CANCELLED'],
  QUALIFYING: ['QUALIFIED', 'NOT_QUALIFIED', 'CANCELLED'],
  QUALIFIED: ['ROUTING', 'CANCELLED'],
  NOT_QUALIFIED: [],
  ROUTING: ['OFFERED', 'NO_ELIGIBLE_DESTINATION', 'CANCELLED'],
  NO_ELIGIBLE_DESTINATION: ['ROUTING', 'CANCELLED'], // allow re-routing retry
  OFFERED: ['ACCEPTED', 'REJECTED', 'MISSED', 'EXPIRED'],
  ACCEPTED: ['CONNECTED', 'FAILED'],
  REJECTED: ['ROUTING', 'CANCELLED'], // overflow to next candidate
  MISSED: ['ROUTING', 'CANCELLED'],
  EXPIRED: ['ROUTING', 'CANCELLED'],
  CONNECTED: ['COMPLETED', 'FAILED'],
  COMPLETED: ['DISPOSITIONED'],
  DISPOSITIONED: ['CREDIT_REQUESTED'],
  CREDIT_REQUESTED: ['CREDIT_APPROVED', 'CREDIT_DENIED'],
  CREDIT_APPROVED: [],
  CREDIT_DENIED: ['CREDIT_REQUESTED'],
  FAILED: [],
  CANCELLED: [],
};

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

module.exports = { TRANSITIONS, canTransition };
