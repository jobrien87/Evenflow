// Deterministic priority engine for the Work Queue.
// Per spec: "ED should use deterministic database calculations for priority" —
// this is plain arithmetic, no LLM call, so it's fast, free, and explainable.
//
// Configurable via Agency.priorityRules ({ typeRank, statusRules }) — see
// schema.prisma. Callers pass whatever that agency's row currently holds
// (or null); this file stays pure/DB-free and falls back to the defaults
// below when unset, so an agency that's never touched Settings still gets
// sensible ordering.

const DEFAULT_TYPE_RANK = ['TRANSFER', 'REFERRAL', 'PAID_AD', 'META_AD', 'INTERNET', 'DIRECT_MAIL', 'MANUAL', 'WINBACK', 'CROSS_SELL'];

const DEFAULT_STATUS_RULES = {
  SOLD: { afterDays: 0, action: 'DROP_OFF' },
  QUOTED: { afterDays: 3, action: 'BUMP_UP' },
  LEFT_VM: { afterDays: 2, action: 'BUMP_UP' },
};

const TYPE_RANK_BONUS_STEP = 8;
const TIME_RULE_BUMP = 25;
const TIME_RULE_PENALTY = 25;
// Not a literal exclusion (archivedAt is what actually hides a lead from
// lists) — just forces a dropped-off lead to sort dead last.
const DROP_OFF_SCORE = -1000;

// Earlier in the ranked list = bigger bonus. Shared with Opportunity
// (Winback/Cross-Sell) scoring in leadPriorityRecompute.js, since both
// domains rank against the same one configured typeRank list.
function typeRankBonus(type, typeRank) {
  const idx = typeRank.indexOf(type);
  return idx === -1 ? 0 : (typeRank.length - idx) * TYPE_RANK_BONUS_STEP;
}

function scoreLead(lead, priorityRules, now = new Date()) {
  const rules = priorityRules || {};
  const typeRank = Array.isArray(rules.typeRank) && rules.typeRank.length > 0 ? rules.typeRank : DEFAULT_TYPE_RANK;
  const statusRules = rules.statusRules || DEFAULT_STATUS_RULES;

  let score = 0;
  const reasons = [];

  const ageMinutes = (now - new Date(lead.receivedAt)) / 60000;

  if (lead.status === 'NEW') {
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

  if (!lead.firstAttemptAt && lead.status === 'NEW') {
    score += 20;
    reasons.push('No contact attempt yet');
  }

  if (lead.status === 'FOLLOW_UP') {
    score += 25;
    reasons.push('Scheduled follow-up');
  }

  if (['QUOTED', 'QUOTED_HOT'].includes(lead.status)) {
    score += 15;
    reasons.push('Active quote in progress');
  }

  if (lead.leadType) {
    const bonus = typeRankBonus(lead.leadType, typeRank);
    if (bonus > 0) {
      score += bonus;
      reasons.push(`${lead.leadType.replace(/_/g, ' ')} lead type`);
    }
  }

  const rule = statusRules[lead.status];
  if (rule) {
    const referenceAt = lead.updatedAt ? new Date(lead.updatedAt) : new Date(lead.receivedAt);
    const daysSince = (now - referenceAt) / 86400000;
    if (daysSince >= (rule.afterDays ?? 0)) {
      const days = Math.floor(daysSince);
      const statusLabel = lead.status.replace(/_/g, ' ');
      if (rule.action === 'DROP_OFF') {
        score = DROP_OFF_SCORE;
        reasons.push(`${statusLabel} — deprioritized`);
      } else if (rule.action === 'BUMP_UP') {
        score += TIME_RULE_BUMP;
        reasons.push(`${statusLabel} for ${days}+ day(s) — bumped up`);
      } else if (rule.action === 'BUMP_DOWN') {
        score -= TIME_RULE_PENALTY;
        reasons.push(`${statusLabel} for ${days}+ day(s) — bumped down`);
      }
    }
  }

  let band = 'NORMAL';
  if (score >= 60) band = 'HIGH';
  else if (score >= 30) band = 'MEDIUM';
  else if (score <= 0) band = 'LOW';

  return {
    priorityScore: score,
    priorityBand: band,
    priorityReason: reasons.join('. ') || 'Standard queue position',
  };
}

module.exports = { scoreLead, typeRankBonus, DEFAULT_TYPE_RANK, DEFAULT_STATUS_RULES };
