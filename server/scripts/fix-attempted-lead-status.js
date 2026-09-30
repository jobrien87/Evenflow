// One-time data fixup, run automatically before `prisma db push` on every
// deploy (see render.yaml's startCommand). The ATTEMPTED disposition was
// removed from the LeadStatus enum — any real Lead rows still sitting at
// that status need to move off it BEFORE the schema push tries to drop the
// enum value, or Postgres rejects the ALTER TYPE outright ("invalid input
// value for enum... ATTEMPTED" — exactly the failure this script exists to
// prevent). LEFT_VM is the migration target because it's the same rank-1
// "outbound touch, no live contact" tier ATTEMPTED used to occupy (see
// server/src/lib/leadStatusAuto.js's STATUS_RANK).
//
// Idempotent and safe to run on every deploy indefinitely: it checks
// whether the database's LeadStatus enum still even has an ATTEMPTED
// value before touching anything, so once the schema push has dropped it
// (this run or any future one), every later run is a harmless no-op.
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const stillHasAttempted = await prisma.$queryRawUnsafe(`
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'LeadStatus' AND e.enumlabel = 'ATTEMPTED'
    LIMIT 1
  `);

  if (!stillHasAttempted || stillHasAttempted.length === 0) {
    console.log('[fix-attempted-lead-status] LeadStatus enum has no ATTEMPTED value — nothing to migrate.');
    return;
  }

  const result = await prisma.$executeRawUnsafe(`
    UPDATE "Lead" SET status = 'LEFT_VM' WHERE status = 'ATTEMPTED'
  `);
  console.log(`[fix-attempted-lead-status] Migrated ${result} Lead row(s) from ATTEMPTED to LEFT_VM.`);
}

main()
  .catch((err) => {
    console.error('[fix-attempted-lead-status] failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
