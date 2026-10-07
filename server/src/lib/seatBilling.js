// Keeps a self-serve Stripe subscription's billed seat count in sync with
// real ACTIVE User rows on the agency — called inline wherever a user's
// status flips to/from ACTIVE (accept-invitation, deactivate). No job
// queue exists in this app, so this must run synchronously in-request;
// wrapped so a Stripe hiccup never fails the user-management action that
// triggered it.
const { prisma } = require('./db');
const stripeLib = require('./stripe');

// Billable seat = every ACTIVE User row on the agency (confirmed
// definition — Telemarketers are excluded automatically since they have
// agencyId: null on their own User row).
async function countActiveSeats(agencyId) {
  return prisma.user.count({ where: { agencyId, status: 'ACTIVE' } });
}

// Seats already spoken for, including a still-pending invite (an INVITED
// user will become ACTIVE the moment they accept, so it must count against
// the cap now — otherwise an owner could send far more invites than seats
// they're paying for, all racing to accept).
async function countOccupiedSeats(agencyId) {
  return prisma.user.count({ where: { agencyId, status: { in: ['ACTIVE', 'INVITED'] } } });
}

// The agency's current self-serve, per-seat Stripe subscription, if any —
// null for an agency on a manually-assigned flat Platform Owner plan (or
// with no billing at all), which is never seat-capped by this mechanism.
async function findActiveSeatSubscription(agencyId) {
  return prisma.agencySubscription.findFirst({
    where: { agencyId, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] }, stripeSubscriptionId: { not: null } },
    orderBy: { createdAt: 'desc' },
  });
}

async function syncSeatCountForAgency(agencyId) {
  try {
    const subscription = await prisma.agencySubscription.findFirst({
      where: { agencyId, status: { in: ['ACTIVE', 'PAST_DUE'] }, stripeSubscriptionId: { not: null } },
    });
    if (!subscription) return;

    const seatCount = await countActiveSeats(agencyId);
    if (subscription.seatCount === seatCount) return;

    await prisma.agencySubscription.update({ where: { id: subscription.id }, data: { seatCount } });

    if (stripeLib.isConfigured()) {
      await stripeLib.updateSubscriptionSeats(subscription.stripeSubscriptionId, seatCount);
    }
  } catch (err) {
    console.error(`[seatBilling] failed to sync seats for agency=${agencyId}`, err.message);
  }
}

module.exports = { countActiveSeats, countOccupiedSeats, findActiveSeatSubscription, syncSeatCountForAgency };
