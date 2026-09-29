// Periodically refreshes the stored Lead.priorityScore/priorityReason (and
// Opportunity.priorityScore) so the real SQL `orderBy: priorityScore` that
// GET /leads uses stays reasonably fresh. scoreLead() is otherwise only
// invoked at creation and on disposition (see routes/leads.js,
// routes/vendorApi.js) — a lead that just sits there would never re-rank
// as it ages or after an agency changes its priorityRules in Settings.
// Runs as a periodic in-process check (registered from index.js via
// setInterval), same "no separate job queue" tradeoff
// lib/staleLeadReminders.js already makes at this app's scale.

const { prisma } = require('./db');
const { scoreLead, typeRankBonus, DEFAULT_TYPE_RANK } = require('./priority');

const TERMINAL_LEAD_STATUSES = ['SOLD', 'LOST', 'NOT_INTERESTED', 'BAD_CONTACT', 'DUPLICATE', 'DO_NOT_CONTACT', 'INELIGIBLE', 'ARCHIVED'];
const TERMINAL_OPPORTUNITY_STATUSES = ['WON', 'DECLINED'];
// The same flat base every Opportunity gets at creation
// (lib/opportunityEvents.js) — this layers the configured type-rank bonus
// on top, never replaces that base signal.
const OPPORTUNITY_BASE_SCORE = 40;

async function recomputeAgencyLeadPriority(agencyId, priorityRules, now = new Date()) {
  const leads = await prisma.lead.findMany({
    where: { agencyId, archivedAt: null, status: { notIn: TERMINAL_LEAD_STATUSES } },
  });
  for (const lead of leads) {
    const { priorityScore, priorityReason } = scoreLead(lead, priorityRules, now);
    if (priorityScore !== lead.priorityScore || priorityReason !== lead.priorityReason) {
      await prisma.lead.update({ where: { id: lead.id }, data: { priorityScore, priorityReason } });
    }
  }
  return leads.length;
}

async function recomputeAgencyOpportunityPriority(agencyId, priorityRules) {
  const typeRank = Array.isArray(priorityRules?.typeRank) && priorityRules.typeRank.length > 0
    ? priorityRules.typeRank
    : DEFAULT_TYPE_RANK;
  const opportunities = await prisma.opportunity.findMany({
    where: { agencyId, status: { notIn: TERMINAL_OPPORTUNITY_STATUSES } },
  });
  for (const opp of opportunities) {
    const priorityScore = OPPORTUNITY_BASE_SCORE + typeRankBonus(opp.type, typeRank);
    if (priorityScore !== opp.priorityScore) {
      await prisma.opportunity.update({ where: { id: opp.id }, data: { priorityScore } });
    }
  }
  return opportunities.length;
}

async function recomputeAllLeadPriorities() {
  const agencies = await prisma.agency.findMany({ where: { archivedAt: null }, select: { id: true, priorityRules: true } });
  const now = new Date();
  let leadsChecked = 0;
  let opportunitiesChecked = 0;
  for (const agency of agencies) {
    leadsChecked += await recomputeAgencyLeadPriority(agency.id, agency.priorityRules, now);
    opportunitiesChecked += await recomputeAgencyOpportunityPriority(agency.id, agency.priorityRules);
  }
  return { agencies: agencies.length, leadsChecked, opportunitiesChecked };
}

module.exports = { recomputeAllLeadPriorities, recomputeAgencyLeadPriority, recomputeAgencyOpportunityPriority };
