const { PrismaClient } = require('@prisma/client');

// Explicitly require TLS for the production DB connection — defense in
// depth rather than relying solely on the provider's own default. Never
// applied outside production: local/CI Postgres instances commonly have
// no TLS listener at all, and forcing sslmode=require there would just
// break every local/CI run. A connection string that already specifies
// its own sslmode (e.g. a provider requiring a specific mode) is left
// untouched rather than overridden.
function resolveDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw || process.env.NODE_ENV !== 'production' || /[?&]sslmode=/.test(raw)) {
    return raw;
  }
  return `${raw}${raw.includes('?') ? '&' : '?'}sslmode=require`;
}

const prisma = new PrismaClient({
  datasources: { db: { url: resolveDatabaseUrl() } },
});

module.exports = { prisma };
