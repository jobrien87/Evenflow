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
      const token = crypto.randomBytes(24).toString('hex');
      await prisma.invitation.create({
        data: {
          email,
          role: 'PLATFORM_OWNER',
          token,
          invitedById: user.id, // self-bootstrapped
          userId: user.id,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
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
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
