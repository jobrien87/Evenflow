// Read-only report, never run automatically. Before the vendorId source
// gate was added to firstAttemptSlaAlerts.js's checkFirstAttemptSla(),
// the candidate query had no filter on lead origin, so bulk-upload/
// manual/telemarketer-sourced leads (never real vendor-API intake) could
// get marked firstAttemptSlaAlertSentAt — a false "speed-to-lead SLA
// breached" alert for a lead this SLA was never meant to apply to.
//
// Under the new gate, these rows are already permanently inert: the
// candidate query's own `firstAttemptSlaAlertSentAt: null` clause means a
// row with this flag already set can never fire again, gate or no gate.
// This script exists purely to show the real count/sample for review —
// it changes nothing. Clearing the flag on these rows would be cosmetic
// (audit/reporting clarity only, since it can no longer functionally
// matter) — do that only if asked, via a separate, explicitly-confirmed
// script, never automatically from this report.
//
// Usage: node scripts/report-stale-sla-alerted-non-vendor-leads.js
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const where = { vendorId: null, firstAttemptSlaAlertSentAt: { not: null } };

  const count = await prisma.lead.count({ where });
  console.log(`[report] ${count} Lead row(s) have firstAttemptSlaAlertSentAt set despite vendorId being null (non-vendor-API intake).`);

  if (count === 0) return;

  const byAgency = await prisma.lead.groupBy({
    by: ['agencyId', 'source'],
    where,
    _count: { _all: true },
    orderBy: { _count: { id: 'desc' } },
  });
  console.log('\nBreakdown by agency + source:');
  for (const row of byAgency) {
    console.log(`  agencyId=${row.agencyId} source=${row.source || '(none)'} count=${row._count._all}`);
  }

  const sample = await prisma.lead.findMany({
    where,
    select: { id: true, agencyId: true, source: true, assignedAt: true, firstAttemptSlaAlertSentAt: true },
    take: 10,
    orderBy: { assignedAt: 'asc' },
  });
  console.log('\nSample (up to 10 rows):');
  for (const row of sample) {
    console.log(`  id=${row.id} agencyId=${row.agencyId} source=${row.source} assignedAt=${row.assignedAt?.toISOString()} alertedAt=${row.firstAttemptSlaAlertSentAt?.toISOString()}`);
  }
}

main()
  .catch((err) => {
    console.error('[report-stale-sla-alerted-non-vendor-leads] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
