// Platform-Owner-only "Create Demo Agency" tool — a reusable way to spin
// up a fully active, instantly-usable demo/sales-walkthrough account:
// owner + roster created directly ACTIVE with a chosen password (no email
// invite round-trip at all, unlike every other account-creation path in
// this app — see routes/agencies.js's own POST / for the normal invite
// flow this deliberately bypasses), optionally seeded with clearly-
// fabricated demo leads/sales so the dashboard isn't empty on first look.
// Never reads or copies any real agency's real data — every demo customer
// name/lead/sale here is invented fresh, every time.
const bcrypt = require('bcryptjs');
const { prisma } = require('./db');
const { recordAudit } = require('./audit');
const { createSaleRecord } = require('./saleRecords');
const { PRODUCTS } = require('./products');

const DEMO_LAST_NAMES = ['Alvarez', 'Baxter', 'Chen', 'Delgado', 'Esposito', 'Franklin', 'Gutierrez', 'Harmon', 'Ibrahim', 'Jorgensen', 'Kowalski', 'Lindqvist'];
const LEAD_STATUSES = ['NEW', 'CONTACTED', 'LEFT_VM', 'APPOINTMENT', 'QUOTED', 'QUOTED_HOT', 'FOLLOW_UP', 'SOLD', 'LOST', 'NOT_INTERESTED'];
const LEAD_TYPES = ['TRANSFER', 'REFERRAL', 'PAID_AD', 'META_AD', 'GOOGLE_AD', 'INTERNET', 'DIRECT_MAIL', 'MANUAL', 'WINBACK', 'CROSS_SELL', 'AI_APPOINTMENT'];
const CARRIERS = ['Allstate', 'Progressive', 'State Farm', 'Nationwide', 'Travelers'];
const ZIPS = ['30301', '60601', '75201', '85001', '94102', '10001'];

function pick(arr, i) {
  return arr[i % arr.length];
}

function daysAgo(maxDays) {
  const d = new Date();
  d.setDate(d.getDate() - Math.floor(Math.random() * maxDays));
  return d;
}

// Creates clearly-fabricated leads/sales/vendors so a fresh demo agency
// isn't an empty shell — every customer name is an invented "Demo <Last>"
// pairing, never anything resembling a real person. Requires at least one
// producer to assign production to; a demo agency with zero producers
// (Josh adds them later) simply gets no seeded data, nothing to assign it to.
async function seedDemoAgencyData(agencyId, ownerId, producers) {
  const vendorA = await prisma.vendor.create({
    data: { agencyId, name: 'Demo Lead Source A', email: `demo-vendor-a+${agencyId}@example.test`, product: 'AUTO', category: 'INTERNET', costPerLeadCents: 1200, status: 'LIVE' },
  });
  const vendorB = await prisma.vendor.create({
    data: { agencyId, name: 'Demo Lead Source B', email: `demo-vendor-b+${agencyId}@example.test`, product: 'HOME', category: 'DIRECT_MAIL', costPerLeadCents: 900, status: 'LIVE' },
  });

  const LEAD_COUNT = 28;
  for (let i = 0; i < LEAD_COUNT; i++) {
    const customer = await prisma.customer.create({
      data: { firstName: 'Demo', lastName: `${pick(DEMO_LAST_NAMES, i)} ${i + 1}`, zip: pick(ZIPS, i), state: 'GA' },
    });
    const vendorId = i % 2 === 0 ? vendorA.id : vendorB.id;
    await prisma.lead.create({
      data: {
        agencyId,
        customerId: customer.id,
        source: i % 2 === 0 ? 'vendor' : 'manual',
        vendorId,
        product: pick(PRODUCTS, i),
        status: pick(LEAD_STATUSES, i),
        leadType: pick(LEAD_TYPES, i),
        assignedToId: pick(producers, i).id,
        createdById: ownerId,
        receivedAt: daysAgo(60),
        zip: pick(ZIPS, i),
        state: 'GA',
      },
    });
  }

  const SALE_COUNT = 10;
  for (let i = 0; i < SALE_COUNT; i++) {
    const customer = await prisma.customer.create({
      data: { firstName: 'Demo', lastName: `${pick(DEMO_LAST_NAMES, i + 6)} Sale${i + 1}` },
    });
    await createSaleRecord({
      agencyId,
      customerId: customer.id,
      firstName: customer.firstName,
      lastName: customer.lastName,
      saleDate: daysAgo(150),
      carrier: pick(CARRIERS, i),
      policyType: 'Standard',
      productFamily: pick(PRODUCTS, i),
      premiumCents: 40000 + i * 7500,
      items: 1 + (i % 3),
      vendorId: i % 2 === 0 ? vendorA.id : vendorB.id,
      assignedToId: pick(producers, i).id,
      createdById: ownerId,
      clientRequestId: `demo-sale-${agencyId}-${i}`,
      actorId: ownerId,
      actorRole: 'AGENCY_OWNER',
      auditAction: 'sale.created',
    });
  }

  return { leadCount: LEAD_COUNT, saleCount: SALE_COUNT, vendorCount: 2 };
}

// { agencyName, owner: {firstName,lastName,email}, producers: [{firstName,lastName,email}],
//   telemarketers: [...], password, seedDemoData, createdById } -> result
async function createDemoAgency({ agencyName, owner, producers = [], telemarketers = [], password, seedDemoData = true, createdById }) {
  const allEmails = [owner, ...producers, ...telemarketers].map((u) => u.email.trim().toLowerCase());
  const uniqueEmails = new Set(allEmails);
  if (uniqueEmails.size !== allEmails.length) {
    return { success: false, errorCode: 'DUPLICATE_EMAIL_IN_REQUEST', message: 'Two roster members can\'t share the same email.' };
  }
  const existing = await prisma.user.findMany({ where: { email: { in: allEmails } }, select: { email: true } });
  if (existing.length > 0) {
    return { success: false, errorCode: 'EMAIL_IN_USE', emails: existing.map((e) => e.email) };
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

    return { agency, ownerUser, producerUsers, telemarketerUsers, subscription };
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

  let seeded = null;
  if (seedDemoData && created.producerUsers.length > 0) {
    seeded = await seedDemoAgencyData(created.agency.id, created.ownerUser.id, created.producerUsers);
  }

  return {
    success: true,
    agency: created.agency,
    owner: created.ownerUser,
    producers: created.producerUsers,
    telemarketers: created.telemarketerUsers,
    seeded,
  };
}

module.exports = { createDemoAgency, seedDemoAgencyData };
