// Fires N concurrent connections at a realistic mix of authenticated read
// endpoints against a running server + a reachable Postgres, using two
// pre-authenticated sessions (a Platform Owner and an Agency Owner).
//
// Requires the `autocannon` package: npm install --no-save autocannon
//
// Usage:
//   PLATFORM_OWNER_EMAIL=... PLATFORM_OWNER_PASSWORD=... \
//   AGENCY_OWNER_EMAIL=... AGENCY_OWNER_PASSWORD=... \
//   node scripts/load-test.js
//
// Optional: BASE_URL (default http://localhost:4000), CONNECTIONS (default
// 500), DURATION seconds (default 20).
let autocannon;
try {
  autocannon = require('autocannon');
} catch {
  console.error('Missing dependency. Run: npm install --no-save autocannon');
  process.exit(1);
}

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const CONNECTIONS = Number(process.env.CONNECTIONS || 500);
const DURATION = Number(process.env.DURATION || 20);

async function login(email, password) {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`Login failed for ${email}: ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookie = setCookie.map((sc) => sc.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`No session cookie returned for ${email}`);
  return cookie;
}

async function main() {
  const platformEmail = process.env.PLATFORM_OWNER_EMAIL;
  const platformPassword = process.env.PLATFORM_OWNER_PASSWORD;
  const agencyEmail = process.env.AGENCY_OWNER_EMAIL;
  const agencyPassword = process.env.AGENCY_OWNER_PASSWORD;
  if (!platformEmail || !platformPassword || !agencyEmail || !agencyPassword) {
    console.error('Set PLATFORM_OWNER_EMAIL/PASSWORD and AGENCY_OWNER_EMAIL/PASSWORD env vars (real, already-activated accounts).');
    process.exit(1);
  }

  console.log('Logging in once each — auth/login is rate-limited by design, so this test authenticates twice total and fans load out across those two sessions, not 500 separate logins.');
  const platformCookie = await login(platformEmail, platformPassword);
  const agencyCookie = await login(agencyEmail, agencyPassword);

  const requests = [
    { method: 'GET', path: '/api/health' },
    { method: 'GET', path: '/api/work-queue', headers: { cookie: agencyCookie } },
    { method: 'GET', path: '/api/leads', headers: { cookie: agencyCookie } },
    { method: 'GET', path: '/api/financials/summary', headers: { cookie: agencyCookie } },
    { method: 'GET', path: '/api/agencies', headers: { cookie: platformCookie } },
    { method: 'GET', path: '/api/users', headers: { cookie: platformCookie } },
  ];

  console.log(`Running ${CONNECTIONS} concurrent connections for ${DURATION}s against ${BASE} ...`);
  autocannon({ url: BASE, connections: CONNECTIONS, duration: DURATION, requests }, (err, result) => {
    if (err) {
      console.error('LOAD TEST ERROR:', err);
      process.exit(1);
    }
    console.log(autocannon.printResult(result));
    console.log(JSON.stringify({
      totalRequests: result.requests.total,
      latencyP50: result.latency.p50,
      latencyP99: result.latency.p99,
      errors: result.errors,
      timeouts: result.timeouts,
      non2xx: result.non2xx,
      statusCodeStats: result.statusCodeStats,
    }, null, 2));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
