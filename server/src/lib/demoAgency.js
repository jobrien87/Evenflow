// Platform-Owner-only "Create Demo Agency" tool — a reusable way to spin
// up a fully active, instantly-usable demo/sales-walkthrough account:
// owner + roster created directly ACTIVE with a chosen password (no email
// invite round-trip at all, unlike every other account-creation path in
// this app — see routes/agencies.js's own POST / for the normal invite
// flow this deliberately bypasses), seeded with a full 6-month realistic
// data profile (see demoDataSeeder.js) so the dashboard — Billboard,
// Financials, Goals, HR, Break Room, the whole thing — looks like a real,
// busy agency rather than an empty shell. Never reads or copies any real
// agency's real data — every demo customer name/lead/sale here is
// invented fresh, every time.
const bcrypt = require('bcryptjs');
const { prisma } = require('./db');
const { recordAudit } = require('./audit');
const { seedRealisticDemoData } = require('./demoDataSeeder');

// The fast, transactional half of "Create Demo Agency" — everything that
// has to finish before a caller can be told the agency exists, with no
// seeding. Split out from createDemoAgency (below) so the HTTP route can
// respond as soon as this resolves and run the slow, full-scale seed
// afterward in the background, instead of blocking the request on it (a
// full 6-month/300-leads-day seed can run long enough to cross an
// external proxy timeout, making a real success look like a failure).
// { agencyName, owner: {firstName,lastName,email}, producers: [{firstName,lastName,email}],
//   telemarketers: [...], password, createdById } -> result (no `seeded` field)
async function createDemoAgencyShell({ agencyName, owner, producers = [], telemarketers = [], password, createdById }) {
  const allEmails = [owner, ...producers, ...telemarketers].map((u) => u.email.trim().toLowerCase());
  const uniqueEmails = new Set(allEmails);
  if (uniqueEmails.size !== allEmails.length) {
    return { success: false, errorCode: 'DUPLICATE_EMAIL_IN_REQUEST', message: 'Two roster members can\'t share the same email.' };
  }
  const existing = await prisma.user.findMany({ where: { email: { in: allEmails } }, select: { email: true } });
  if (existing.length > 0) {
    const conflictingEmails = existing.map((e) => e.email);
    return {
      success: false,
      errorCode: 'EMAIL_IN_USE',
      emails: conflictingEmails,
      message: `Already registered: ${conflictingEmails.join(', ')}`,
    };
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const created = await prisma.$transaction(async (tx) => {
    const agency = await tx.agency.create({
      data: { name: agencyName, status: 'ACTIVE', isDemo: true },
    });

    const ownerUser = await tx.user.create({
      data: {
        email: owner.email.trim().toLowerCase(), firstName: owner.firstName, lastName: owner.lastName,
        role: 'AGENCY_OWNER', status: 'ACTIVE', agencyId: agency.id, passwordHash,
      },
    });

    const producerUsers = [];
    for (const p of producers) {
      const u = await tx.user.create({
        data: {
          email: p.email.trim().toLowerCase(), firstName: p.firstName, lastName: p.lastName,
          role: 'PRODUCER', status: 'ACTIVE', agencyId: agency.id, passwordHash,
        },
      });
      producerUsers.push(u);
    }

    const telemarketerUsers = [];
    for (const t of telemarketers) {
      const u = await tx.user.create({
        data: {
          email: t.email.trim().toLowerCase(), firstName: t.firstName, lastName: t.lastName,
          role: 'TELEMARKETER', status: 'ACTIVE', passwordHash,
        },
      });
      await tx.telemarketerProfile.create({ data: { userId: u.id, status: 'ACTIVE' } });
      await tx.telemarketerAssignment.create({
        data: { telemarketerId: u.id, agencyId: agency.id, assignedById: createdById, status: 'ACTIVE' },
      });
      telemarketerUsers.push(u);
    }

    // Same find-or-create-by-name pattern POST /agencies already uses for
    // its own "Comped" plan — "Full Platform" is seeded by prisma/seed.js,
    // so the find branch is the expected real path; create is a
    // defensive fallback only.
    const plan = (await tx.plan.findFirst({ where: { name: 'Full Platform' } }))
      || (await tx.plan.create({ data: { name: 'Full Platform', priceCents: 59900, isActive: true, crmEnabled: true, transfersEnabled: true, coachingEnabled: true } }));
    const subscription = await tx.agencySubscription.create({
      data: { agencyId: agency.id, planId: plan.id, status: 'ACTIVE', assignedById: createdById },
    });

    // The subscription alone is cosmetic — entitlements.js's
    // requireModuleEnabled/requireSalesStudioAccess read these three
    // booleans straight off the Agency row, not off any subscription/plan,
    // so without this sync a demo agency's plan would be "Full Platform"
    // on paper but 403 on Sales Studio, Transfers, Calls, and Training.
    // Same sync routes/billing.js and routes/agencies.js already do for a
    // real agency's plan change.
    const updatedAgency = await tx.agency.update({
      where: { id: agency.id },
      data: { crmEnabled: plan.crmEnabled, transfersEnabled: plan.transfersEnabled, coachingEnabled: plan.coachingEnabled },
    });

    return { agency: updatedAgency, ownerUser, producerUsers, telemarketerUsers, subscription };
  }, { timeout: 30000 });

  await recordAudit({
    actorId: createdById,
    actorRole: 'PLATFORM_OWNER',
    agencyId: created.agency.id,
    action: 'agency.demoCreated',
    entityType: 'Agency',
    entityId: created.agency.id,
    after: { ownerEmail: created.ownerUser.email, producerCount: created.producerUsers.length, telemarketerCount: created.telemarketerUsers.length },
  });

  return {
    success: true,
    agency: created.agency,
    owner: created.ownerUser,
    producers: created.producerUsers,
    telemarketers: created.telemarketerUsers,
  };
}

// Full create-and-seed flow, synchronous end to end — kept for every
// existing caller that wants one awaitable result with real seed counts
// (e.g. demoAgency.test.js). The HTTP route itself no longer uses this
// directly; see routes/agencies.js, which calls createDemoAgencyShell and
// backgrounds the seed instead.
// { ...createDemoAgencyShell's args, seedDemoData, seedOptions } -> result
async function createDemoAgency({ seedDemoData = true, seedOptions = {}, ...shellArgs }) {
  const shell = await createDemoAgencyShell(shellArgs);
  if (!shell.success) return shell;

  let seeded = null;
  if (seedDemoData && shell.producers.length > 0) {
    seeded = await seedRealisticDemoData(shell.agency.id, seedOptions);
  }

  return { ...shell, seeded };
}

module.exports = { createDemoAgency, createDemoAgencyShell };
