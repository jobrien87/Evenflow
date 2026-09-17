// Deterministic priority engine for the Work Queue.
// Per spec: "ED should use deterministic database calculations for priority" —
// this is plain arithmetic, no LLM call, so it's fast, free, and explainable.

function scoreLead(lead, now = new Date()) {
  let score = 0;
  const reasons = [];

  const ageMinutes = (now - new Date(lead.receivedAt)) / 60000;

  if (lead.status === 'NEW' || lead.status === 'ASSIGNED') {
    if (ageMinutes < 15) {
      score += 50;
      reasons.push('Received in the last 15 minutes');
    } else if (ageMinutes < 60) {
      score += 30;
      reasons.push('Received in the last hour');
    } else {
      score += 10;
    }
  }

  if (!lead.firstAttemptAt && (lead.status === 'NEW' || lead.status === 'ASSIGNED')) {
    score += 20;
    reasons.push('No contact attempt yet');
  }

  if (lead.status === 'FOLLOW_UP') {
    score += 25;
    reasons.push('Scheduled follow-up');
  }

  if (lead.status === 'QUOTE_STARTED' || lead.status === 'QUOTED') {
    score += 15;
    reasons.push('Active quote in progress');
  }

  let band = 'NORMAL';
  if (score >= 60) band = 'HIGH';
  else if (score >= 30) band = 'MEDIUM';

  return {
    priorityScore: score,
    priorityBand: band,
    priorityReason: reasons.join('. ') || 'Standard queue position',
  };
}

module.exports = { scoreLead };
