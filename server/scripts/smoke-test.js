// Real end-to-end smoke walk over live HTTP against a running server + a
// reachable Postgres. Mirrors the README's own "pre-launch smoke test"
// checklist (Platform -> Agency & team -> Telemarketer -> Yield Transfers
// lead -> Team chat -> Sale -> Money), but scripted and asserted at every
// step instead of eyeballed. Yield Transfers rebuild: a Telemarketer's
// submission is now a real Lead (source: 'telemarketer'), instantly visible
// to the whole agency — no accept/reject/routing gate, matching the Inferno
// Connect reference the user asked to match.
//
// Requirements:
//   - The server is running and reachable at BASE_URL (default http://localhost:4000).
//   - DATABASE_URL points `psql` at the same database the server is using —
//     used only to read back invitation tokens, exactly like a human would
//     read them from the server log when RESEND_API_KEY is unset.
//   - `npm run seed` has been run at least once against that database
//     (creates josh@yield-marketing.com as a Platform Owner).
//
// Usage: node scripts/smoke-test.js
//   BASE_URL=https://your-server.onrender.com DATABASE_URL=... node scripts/smoke-test.js
const { execSync } = require('child_process');

const BASE = (process.env.BASE_URL || 'http://localhost:4000') + '/api';
const DB_URL = process.env.DATABASE_URL;
// Unique per invocation so re-running never collides with a prior run's test
// fixtures — email/phone dedup and cross-sell duplicate-prevention are real
// app behavior, not something to work around with hardcoded fixtures.
const RUN = String(Date.now()).slice(-7);
const PASSWORD = 'SuperSecret123!';

function latestInvitationToken(email) {
  if (!DB_URL) {
    throw new Error('DATABASE_URL is required to read back invitation tokens (no email adapter is assumed configured).');
  }
  return execSync(
    `psql "${DB_URL}" -t -A -c "select token from \\"Invitation\\" where email='${email}' order by \\"createdAt\\" desc limit 1;"`
  ).toString().trim();
}

function makeClient() {
  const cookies = {};
  return {
    async call(method, path, body) {
      const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(BASE + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const sc of setCookie) {
        const [pair] = sc.split(';');
        const idx = pair.indexOf('=');
        cookies[pair.slice(0, idx)] = pair.slice(idx + 1);
      }
      let data = null;
      try { data = await res.json(); } catch { /* no body */ }
      return { status: res.status, data };
    },
  };
}

let stepNum = 0;
function step(name) {
  stepNum += 1;
  console.log(`\n[${stepNum}] ${name}`);
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`  OK: ${msg} (${JSON.stringify(actual)})`);
}
function assertTruthy(actual, msg) {
  if (!actual) throw new Error(`ASSERTION FAILED: ${msg} — got ${JSON.stringify(actual)}`);
  console.log(`  OK: ${msg}`);
}

async function main() {
  const josh = makeClient();

  step('Health check reports the database as HEALTHY');
  {
    const r = await josh.call('GET', '/health');
    assertEq(r.status, 200, 'GET /health status');
    assertEq(r.data.checks.database, 'HEALTHY', 'database check');
  }

  step('Josh (seeded Platform Owner) activates his account (idempotent — may already be done from a prior run)');
  {
    const token = latestInvitationToken('josh@yield-marketing.com');
    assertTruthy(token, 'josh invitation token found (did you run `npm run seed`?)');
    const r = await josh.call('POST', '/auth/accept-invitation', { token, password: PASSWORD });
    if (r.status !== 200 && r.data && r.data.error === 'INVITATION_ALREADY_USED') {
      console.log('  OK: already activated in a prior run, continuing');
    } else {
      assertEq(r.status, 200, 'accept-invitation status');
    }
  }

  step('Josh logs in');
  {
    const r = await josh.call('POST', '/auth/login', { email: 'josh@yield-marketing.com', password: PASSWORD });
    assertEq(r.status, 200, 'login status');
    assertEq(r.data.user.role, 'PLATFORM_OWNER', 'logged-in role');
  }

  step('Josh invites a test agency');
  let agencyId, agencyOwnerToken;
  const adaEmail = `ada${RUN}.owner@smoketest.local`;
  {
    const r = await josh.call('POST', '/agencies', {
      name: 'Smoke Test Agency',
      ownerFirstName: 'Ada',
      ownerLastName: 'Owner',
      ownerEmail: adaEmail,
      products: [],
    });
    assertEq(r.status, 201, 'create agency status');
    agencyId = r.data.agency.id;
    assertTruthy(agencyId, 'agency id returned');
    agencyOwnerToken = latestInvitationToken(adaEmail);
    assertTruthy(agencyOwnerToken, 'agency owner invitation token found');
  }

  const ada = makeClient();
  step('Agency Owner (Ada) activates and logs in');
  {
    let r = await ada.call('POST', '/auth/accept-invitation', { token: agencyOwnerToken, password: PASSWORD });
    assertEq(r.status, 200, 'ada accept-invitation status');
    r = await ada.call('POST', '/auth/login', { email: adaEmail, password: PASSWORD });
    assertEq(r.status, 200, 'ada login status');
  }

  step('Josh assigns the "CRM + Yield Transfers" plan to the agency (syncs transfersEnabled)');
  {
    const plans = await josh.call('GET', '/billing/plans');
    const plan = plans.data.plans.find((p) => p.name === 'CRM + Yield Transfers');
    assertTruthy(plan, 'CRM + Yield Transfers plan exists (from seed)');
    const r = await josh.call('POST', `/billing/agencies/${agencyId}/subscription`, { planId: plan.id });
    assertEq(r.status, 201, 'assign subscription status');
    assertEq(r.data.agency.transfersEnabled, true, 'agency.transfersEnabled synced true');
  }

  step('Josh invites a Telemarketer and assigns them to the agency');
  let tmId, tmToken;
  const tinaEmail = `tina${RUN}.tm@smoketest.local`;
  {
    let r = await josh.call('POST', '/telemarketers/invite', { email: tinaEmail, firstName: 'Tina', lastName: 'TM' });
    assertEq(r.status, 201, 'invite TM status');
    tmId = r.data.telemarketer.id;
    tmToken = latestInvitationToken(tinaEmail);
    assertTruthy(tmToken, 'TM invitation token found');
    r = await josh.call('POST', '/telemarketers/assign', { telemarketerId: tmId, agencyId });
    assertEq(r.status, 201, 'assign TM to agency status');
  }

  const tina = makeClient();
  step('Telemarketer (Tina) activates, logs in, confirms her assignment is visible');
  {
    let r = await tina.call('POST', '/auth/accept-invitation', { token: tmToken, password: PASSWORD });
    assertEq(r.status, 200, 'tina accept-invitation status');
    r = await tina.call('POST', '/auth/login', { email: tinaEmail, password: PASSWORD });
    assertEq(r.status, 200, 'tina login status');
    r = await tina.call('GET', '/telemarketers/me/assignments');
    assertEq(r.data.assignments.length, 1, 'tina has exactly one active assignment');
  }

  let leadId;
  step('Tina submits a rich lead (full Inferno-style intake) — instantly a real Lead, no accept/reject gate');
  {
    const r = await tina.call('POST', '/leads', {
      agencyId,
      product: 'Auto',
      firstName: 'Cathy',
      lastName: 'Customer',
      phone: '555' + RUN.padStart(7, '0'),
      email: `cathy${RUN}.customer@smoketest.local`,
      dob: '1990-05-20T00:00:00.000Z',
      address: '456 Oak Ave',
      city: 'Sacramento',
      state: 'CA',
      zip: '95814',
      vehicleYear: '2019',
      vehicleMake: 'Toyota',
      vehicleModel: 'Camry',
      currentInsurance: 'Geico',
      currentPremium: '110',
      callbackTime: 'Today 4pm',
      tmNotes: 'Ready to switch, price shopping',
    });
    assertEq(r.status, 201, 'create lead status');
    assertEq(r.data.lead.status, 'NEW', 'lead lands as NEW, no accept/reject step');
    assertEq(r.data.lead.source, 'telemarketer', 'source is authoritatively telemarketer, server-set');
    leadId = r.data.lead.id;
  }

  step('Ada sees the lead land instantly on Yield Transfers with every intake field intact');
  {
    const r = await ada.call('GET', '/leads?source=telemarketer');
    assertEq(r.status, 200, 'leads?source=telemarketer status');
    const lead = r.data.leads.find((l) => l.id === leadId);
    assertTruthy(lead, 'the just-submitted lead is visible to the Agency Owner');
    assertEq(lead.vehicleMake, 'Toyota', 'vehicle intake field made it through');
    assertEq(lead.currentInsurance, 'Geico', 'current-carrier intake field made it through');
    assertEq(lead.tmNotes, 'Ready to switch, price shopping', 'TM notes field made it through');
  }

  step('Agency-wide team chat: Ada and Tina land in the same room and exchange real messages');
  let agencyConvoId;
  {
    let r = await ada.call('GET', `/chat/conversations/entity/AGENCY/${agencyId}`);
    assertEq(r.status, 200, 'ada fetches AGENCY conversation');
    agencyConvoId = r.data.conversation.id;
    r = await tina.call('GET', `/chat/conversations/entity/AGENCY/${agencyId}`);
    assertEq(r.data.conversation.id, agencyConvoId, 'tina lands in the same agency-wide room');

    r = await ada.call('POST', `/chat/conversations/${agencyConvoId}/messages`, { content: 'Nice work on the Cathy Customer lead!' });
    assertEq(r.status, 201, 'ada posts to team chat');
    r = await tina.call('POST', `/chat/conversations/${agencyConvoId}/messages`, { content: 'Thanks — follow up today at 4pm.' });
    assertEq(r.status, 201, 'tina replies in team chat');

    r = await ada.call('GET', `/chat/conversations/${agencyConvoId}/messages`);
    assertEq(r.data.messages.length, 2, 'both team chat messages persisted');
    assertEq(r.data.messages[1].author.firstName, 'Tina', "tina's reply is correctly attributed");
  }

  step('Per-lead DISCUSS thread is independent of the team room');
  {
    const r = await ada.call('GET', `/chat/conversations/entity/LEAD/${leadId}`);
    assertEq(r.status, 200, 'ada fetches per-lead DISCUSS conversation');
    assertTruthy(r.data.conversation.id !== agencyConvoId, 'the DISCUSS thread is a separate room from the team chat');
  }

  step('Ada dispositions SOLD with a $1,200 premium — must land in the real Financial Ledger');
  {
    const r = await ada.call('POST', `/leads/${leadId}/disposition`, {
      status: 'SOLD',
      saleProduct: 'Auto',
      salePremiumCents: 120000,
    });
    assertEq(r.status, 200, 'disposition status');
    assertEq(r.data.lead.status, 'SOLD', 'lead status SOLD');
  }

  step('Financials summary reflects the real sale premium');
  {
    const r = await ada.call('GET', '/financials/summary');
    assertEq(r.status, 200, 'financials summary status');
    // computeProfitability (lib/financialCalc.js) returns `revenue` in
    // display dollars, not cents — Yield Transfers no longer charges an
    // acceptance fee (that whole gate was retired), so revenue is just the
    // $1,200 sale premium.
    assertTruthy(r.data.revenue > 0, `revenue is real and positive (got $${r.data.revenue})`);
    assertEq(r.data.revenue, 1200, 'revenue equals the $1200 sale premium');
    assertEq(r.data.salesRecorded, 1, 'exactly 1 sale recorded');
  }

  step("Telemarketer's and the Agency's Flow Score both update off the real Lead outcome");
  {
    let r = await tina.call('GET', '/flow-score/me');
    assertEq(r.status, 200, 'tina flow score status');
    assertTruthy(r.data.snapshot && r.data.snapshot.score !== null, 'tina has a real Flow Score after her first Lead outcome');
    r = await ada.call('GET', `/flow-score/agency/${agencyId}`);
    assertEq(r.status, 200, 'agency flow score status');
    assertTruthy(r.data.snapshot && r.data.snapshot.score !== null, 'agency has a real Flow Score after the sale');
  }

  step('Cross-sell opportunity appears (customer now has Auto, no Home/Life)');
  {
    const r = await ada.call('GET', '/opportunities');
    assertEq(r.status, 200, 'opportunities status');
    assertTruthy(r.data.opportunities.length >= 1, `at least one cross-sell opportunity created (got ${r.data.opportunities.length})`);
  }

  console.log('\n=== SMOKE WALK COMPLETE: ALL ASSERTIONS PASSED ===');
}

main().catch((err) => {
  console.error('\n=== SMOKE WALK FAILED ===');
  console.error(err);
  process.exit(1);
});
