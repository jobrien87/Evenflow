// One-time data fixup, run automatically before `prisma db push` on every
// deploy (see render.yaml's startCommand) — same pattern as
// fix-attempted-lead-status.js. ASSIGNED and QUOTE_STARTED were removed
// from the LeadStatus enum — any real Lead rows still sitting at either
// status need to move off it BEFORE the schema push tries to drop the enum
// values, or Postgres rejects the ALTER TYPE outright ("invalid input value
// for enum... ASSIGNED"). NEW and APPOINTMENT are the migration targets
// because they're the same rank-0/rank-3 tiers ASSIGNED/QUOTE_STARTED used
// to share (see server/src/lib/leadStatusAuto.js's STATUS_RANK).
//
// Idempotent and safe to run on every deploy indefinitely: it checks
// whether the database's LeadStatus enum still even has each value before
// touching anything, so once the schema push has dropped them, every later
// run is a harmless no-op.
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const MIGRATIONS = [
  { from: 'ASSIGNED', to: 'NEW' },
  { from: 'QUOTE_STARTED', to: 'APPOINTMENT' },
];

async function enumStillHasValue(value) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'LeadStatus' AND e.enumlabel = $1
    LIMIT 1
  `, value);
  return rows && rows.length > 0;
}

async function main() {
  for (const { from, to } of MIGRATIONS) {
    if (!(await enumStillHasValue(from))) {
      console.log(`[fix-removed-lead-statuses] LeadStatus enum has no ${from} value — nothing to migrate.`);
      continue;
    }
    const result = await prisma.$executeRawUnsafe(
      `UPDATE "Lead" SET status = $1::"LeadStatus" WHERE status = $2::"LeadStatus"`,
      to, from
    );
    console.log(`[fix-removed-lead-statuses] Migrated ${result} Lead row(s) from ${from} to ${to}.`);
  }
}

main()
  .catch((err) => {
    console.error('[fix-removed-lead-statuses] failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
