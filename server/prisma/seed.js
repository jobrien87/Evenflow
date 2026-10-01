// Bootstraps the two Platform Owner accounts (Josh, Tom).
// This does NOT set a password. It creates the account + a real invitation
// token, and prints the accept-invitation link so whoever runs this can
// deliver it securely (or rely on the real email adapter if configured).
// This avoids ever having a hardcoded/default admin password.

const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');

const prisma = new PrismaClient();

const OWNERS = [
  { email: 'josh@yield-marketing.com', firstName: 'Josh', lastName: 'Owner' },
  { email: 'tom@yield-marketing.com', firstName: 'Tom', lastName: 'Owner' },
];

async function main() {
  const appUrl = process.env.APP_URL || 'http://localhost:5173';

  for (const owner of OWNERS) {
    const email = owner.email.toLowerCase();
    let user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          firstName: owner.firstName,
          lastName: owner.lastName,
          role: 'PLATFORM_OWNER',
          status: 'INVITED',
        },
      });
      console.log(`Created Platform Owner user: ${email}`);
    } else {
      console.log(`Platform Owner already exists: ${email}`);
    }

    const existingInvite = await prisma.invitation.findFirst({
      where: { userId: user.id, acceptedAt: null, expiresAt: { gt: new Date() } },
    });

    if (!existingInvite && user.status !== 'ACTIVE') {
      // userId is @unique on Invitation — a prior unaccepted invite for
      // this same self-bootstrapped user can still exist as a row even
      // after it expired (the query above only finds a currently-VALID
      // one). upsert (keyed on that unique userId) renews it with a fresh
      // token/expiry instead of colliding on create().
      const token = crypto.randomBytes(24).toString('hex');
      await prisma.invitation.upsert({
        where: { userId: user.id },
        create: {
          email,
          role: 'PLATFORM_OWNER',
          token,
          invitedById: user.id, // self-bootstrapped
          userId: user.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
        update: {
          token,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          acceptedAt: null,
        },
      });
      console.log(`Activation link for ${email}:`);
      console.log(`  ${appUrl}/accept-invitation?token=${token}`);
    }
  }

  // Seed a few default plans so Platform Owner has something to assign to
  // agencies immediately, rather than an empty Billing tab on first login.
  const defaultPlans = [
    { name: 'CRM Only', priceCents: 0, crmEnabled: true, transfersEnabled: false, coachingEnabled: false },
    { name: 'CRM + Yield Transfers', priceCents: 29900, crmEnabled: true, transfersEnabled: true, coachingEnabled: false },
    { name: 'Full Platform', priceCents: 59900, crmEnabled: true, transfersEnabled: true, coachingEnabled: true },
  ];
  for (const p of defaultPlans) {
    const existing = await prisma.plan.findFirst({ where: { name: p.name } });
    if (!existing) {
      await prisma.plan.create({ data: p });
      console.log(`Created default plan: ${p.name}`);
    }
  }

  // Seed the Record Store's initial 5 product templates so the storefront
  // isn't empty on first login — prices and real Boberdoo IDs are left
  // null until a Super Admin configures them (routes/recordStore.js
  // refuses to let an Agency Owner order an unpriced template), matching
  // this app's "never fabricate a number/ID" rule.
  const recordStoreTemplates = [
    { slug: 'HOME_BASIC', displayName: 'Home Basic', description: 'Real-time home insurance leads at wholesale pricing.', productCategory: 'HOME', leadType: 'INTERNET', sortOrder: 1 },
    { slug: 'AUTO_BASIC', displayName: 'Auto Basic', description: 'Real-time auto insurance leads at wholesale pricing.', productCategory: 'AUTO', leadType: 'INTERNET', sortOrder: 2 },
    { slug: 'HOME_PREFERRED', displayName: 'Home Preferred', description: 'Our higher-quality home insurance lead tier.', productCategory: 'HOME', leadType: 'INTERNET', sortOrder: 3 },
    { slug: 'AUTO_PREFERRED', displayName: 'Auto Preferred', description: 'Our higher-quality auto insurance lead tier.', productCategory: 'AUTO', leadType: 'INTERNET', sortOrder: 4 },
    { slug: 'LIVE_CALL_SETUP', displayName: 'Live Call Setup', description: 'Real-time inbound phone transfers — a live caller on the line, ready to talk.', productCategory: 'AUTO', leadType: 'LIVE_CALL', filterSetType: 'IPR', isIpr: true, sortOrder: 5, minimumDailyVolume: 1, maximumDailyVolume: 50, defaultDailyVolume: 5 },
  ];
  for (const t of recordStoreTemplates) {
    const existing = await prisma.recordStoreTemplate.findUnique({ where: { slug: t.slug } });
    if (!existing) {
      await prisma.recordStoreTemplate.create({ data: t });
      console.log(`Created Record Store template: ${t.slug}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
