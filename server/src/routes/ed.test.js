const { test } = require('node:test');
const assert = require('node:assert/strict');
const edRouter = require('./ed');
const { buildSystemPrompt, buildBriefingPrompt, HUMOR_GUIDANCE } = require('../lib/edPersonality');

const { deterministicSummary, deterministicBriefing } = edRouter;

test('deterministicSummary templates a PRODUCER context with an active goal', () => {
  const summary = deterministicSummary({
    role: 'PRODUCER',
    pace: { actual: 3, expectedByNow: 5, goal: 10 },
    openLeads: 4,
    openTasks: 2,
  });
  assert.match(summary, /pace of 5/);
  assert.match(summary, /4 open leads/);
  assert.match(summary, /2 open tasks/);
});

test('deterministicSummary templates a PRODUCER context with no goal set (never fabricates a pace)', () => {
  const summary = deterministicSummary({ role: 'PRODUCER', pace: null, openLeads: 1, openTasks: 0 });
  assert.match(summary, /No sales goal is set/);
});

test('deterministicSummary templates an AGENCY_OWNER context', () => {
  const summary = deterministicSummary({
    role: 'AGENCY_OWNER',
    openLeads: 10,
    overdueLeads: 2,
    transfersAccepted: 4,
    transfersThisMonth: 6,
    transferAcceptanceRate: 66.7,
    monthRevenue: 1200,
    monthCost: 300,
  });
  assert.match(summary, /10 open leads/);
  assert.match(summary, /4\/6 transfers accepted/);
  assert.match(summary, /66\.7%/);
});

test('deterministicSummary templates a PLATFORM_OWNER context', () => {
  const summary = deterministicSummary({
    role: 'PLATFORM_OWNER',
    activeAgencies: 3,
    totalAgencies: 5,
    activeTMs: 2,
    totalTMs: 4,
    missedTransfers: 1,
    transfersThisMonth: 20,
    monthRevenue: 5000,
    monthCost: 1000,
    openSupportTickets: 2,
  });
  assert.match(summary, /3\/5 agencies active/);
  assert.match(summary, /2 open support tickets/);
});

test('deterministicSummary returns an honest placeholder for an unrecognized role (never fabricates)', () => {
  const summary = deterministicSummary({ role: 'TELEMARKETER' });
  assert.match(summary, /No summary available/);
});

test('deterministicBriefing reports a real Flow Score delta for a PRODUCER, never a guessed one', () => {
  const briefing = deterministicBriefing({
    role: 'PRODUCER',
    newLeads: 2,
    newSales: 1,
    flowScoreNow: 82,
    flowScoreDelta: 5,
    goalPace: { target: 10, actual: 4 },
  });
  assert.match(briefing, /2 new lead\(s\), 1 sale\(s\)/);
  assert.match(briefing, /\+5 to 82/);
  assert.match(briefing, /4\/10/);
});

test('deterministicBriefing omits the score line when there is no prior snapshot to compare (never fabricates a delta)', () => {
  const briefing = deterministicBriefing({
    role: 'PRODUCER',
    newLeads: 0,
    newSales: 0,
    flowScoreNow: null,
    flowScoreDelta: null,
    goalPace: null,
  });
  assert.doesNotMatch(briefing, /Flow Score/);
  assert.doesNotMatch(briefing, /sales goal/);
});

test('deterministicBriefing templates an AGENCY_OWNER context', () => {
  const briefing = deterministicBriefing({
    role: 'AGENCY_OWNER',
    newLeads: 5,
    newTransfers: 3,
    newSales: 2,
    flowScoreNow: 70,
    flowScoreDelta: -4,
  });
  assert.match(briefing, /5 new lead\(s\), 3 new transfer\(s\), 2 sale\(s\)/);
  assert.match(briefing, /-4 to 70/);
});

test('deterministicBriefing templates a PLATFORM_OWNER context', () => {
  const briefing = deterministicBriefing({ role: 'PLATFORM_OWNER', newAgencies: 1, newTransfers: 12, missedTransfers: 2 });
  assert.match(briefing, /1 new agency/);
  assert.match(briefing, /12 new transfer\(s\)/);
});

test('buildSystemPrompt embeds the real per-level humor guidance, one distinct line per level', () => {
  const low = buildSystemPrompt({ context: { role: 'PRODUCER' }, humorLevel: 'LOW' });
  const spicy = buildSystemPrompt({ context: { role: 'PRODUCER' }, humorLevel: 'SPICY' });
  assert.ok(low.includes(HUMOR_GUIDANCE.LOW));
  assert.ok(spicy.includes(HUMOR_GUIDANCE.SPICY));
  assert.notEqual(low, spicy);
});

test('buildSystemPrompt falls back to NORMAL guidance for an unrecognized humor level', () => {
  const prompt = buildSystemPrompt({ context: { role: 'PRODUCER' }, humorLevel: 'NOT_A_REAL_LEVEL' });
  assert.ok(prompt.includes(HUMOR_GUIDANCE.NORMAL));
});

test('buildBriefingPrompt embeds the real context data and the matching humor guidance', () => {
  const context = { role: 'PRODUCER', newLeads: 3 };
  const prompt = buildBriefingPrompt({ context, humorLevel: 'SPICY' });
  assert.ok(prompt.includes(HUMOR_GUIDANCE.SPICY));
  assert.ok(prompt.includes(JSON.stringify(context, null, 2)));
});
