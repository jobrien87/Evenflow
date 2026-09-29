const express = require('express');
const { z } = require('zod');
const { prisma } = require('../lib/db');
const { requireAuth, requireRole, scopeAgencyId } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Resolves which agency a clock action applies to, the same "never trust a
// client-supplied agencyId blindly" rule leads.js/tasks.js already use for
// a Telemarketer (who has no agencyId of their own — cross-agency via
// TelemarketerAssignment).
async function resolveAgencyId(req, requestedAgencyId) {
  if (req.user.role === 'TELEMARKETER') {
    if (!requestedAgencyId) return { error: 'AGENCY_REQUIRED' };
    const assignment = await prisma.telemarketerAssignment.findFirst({
      where: { telemarketerId: req.user.id, agencyId: requestedAgencyId, status: 'ACTIVE' },
    });
    if (!assignment) return { error: 'FORBIDDEN' };
    return { agencyId: requestedAgencyId };
  }
  return { agencyId: req.user.agencyId };
}

function openEntryWhere(userId) {
  return { userId, clockOutAt: null };
}

function stateOf(entry) {
  if (!entry || entry.clockOutAt) return 'CLOCKED_OUT';
  if (entry.lunchStartAt && !entry.lunchEndAt) return 'ON_LUNCH';
  return 'CLOCKED_IN';
}

// Only Producers and Telemarketers clock in/out at all — everyone else
// (Agency Owner/Manager, Platform Owner) is exempt from this feature
// entirely, per the user's explicit instruction.
router.use(['/clock-in', '/clock-out', '/lunch-start', '/lunch-end', '/me'], requireRole('PRODUCER', 'TELEMARKETER'));

router.get('/me', async (req, res, next) => {
  try {
    const entry = await prisma.timeClockEntry.findFirst({
      where: openEntryWhere(req.user.id),
      orderBy: { clockInAt: 'desc' },
    });
    return res.json({ success: true, entry, state: stateOf(entry) });
  } catch (err) {
    next(err);
  }
});

const clockInSchema = z.object({ agencyId: z.string().uuid().optional() });

router.post('/clock-in', async (req, res, next) => {
  try {
    const parsed = clockInSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'VALIDATION', fieldErrors: parsed.error.flatten() });
    }
    const existing = await prisma.timeClockEntry.findFirst({ where: openEntryWhere(req.user.id) });
    if (existing) {
      return res.status(409).json({ success: false, error: 'ALREADY_CLOCKED_IN' });
    }
    const resolved = await resolveAgencyId(req, parsed.data.agencyId);
    if (resolved.error) return res.status(resolved.error === 'FORBIDDEN' ? 403 : 400).json({ success: false, error: resolved.error });
    if (!resolved.agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const entry = await prisma.timeClockEntry.create({
      data: { userId: req.user.id, agencyId: resolved.agencyId },
    });
    return res.status(201).json({ success: true, entry, state: stateOf(entry) });
  } catch (err) {
    next(err);
  }
});

router.post('/clock-out', async (req, res, next) => {
  try {
    const entry = await prisma.timeClockEntry.findFirst({ where: openEntryWhere(req.user.id) });
    if (!entry) return res.status(409).json({ success: false, error: 'NOT_CLOCKED_IN' });
    if (entry.lunchStartAt && !entry.lunchEndAt) {
      return res.status(409).json({ success: false, error: 'ON_LUNCH', message: 'End your lunch before clocking out.' });
    }
    const updated = await prisma.timeClockEntry.update({ where: { id: entry.id }, data: { clockOutAt: new Date() } });
    return res.json({ success: true, entry: updated, state: stateOf(updated) });
  } catch (err) {
    next(err);
  }
});

router.post('/lunch-start', async (req, res, next) => {
  try {
    const entry = await prisma.timeClockEntry.findFirst({ where: openEntryWhere(req.user.id) });
    if (!entry) return res.status(409).json({ success: false, error: 'NOT_CLOCKED_IN' });
    if (entry.lunchStartAt) {
      return res.status(409).json({ success: false, error: 'LUNCH_ALREADY_USED', message: 'Lunch already started for this shift.' });
    }
    const updated = await prisma.timeClockEntry.update({ where: { id: entry.id }, data: { lunchStartAt: new Date() } });
    return res.json({ success: true, entry: updated, state: stateOf(updated) });
  } catch (err) {
    next(err);
  }
});

router.post('/lunch-end', async (req, res, next) => {
  try {
    const entry = await prisma.timeClockEntry.findFirst({ where: openEntryWhere(req.user.id) });
    if (!entry) return res.status(409).json({ success: false, error: 'NOT_CLOCKED_IN' });
    if (!entry.lunchStartAt || entry.lunchEndAt) {
      return res.status(409).json({ success: false, error: 'NOT_ON_LUNCH' });
    }
    const updated = await prisma.timeClockEntry.update({ where: { id: entry.id }, data: { lunchEndAt: new Date() } });
    return res.json({ success: true, entry: updated, state: stateOf(updated) });
  } catch (err) {
    next(err);
  }
});

// Live team roster status for the Main Stage box — every agency-scoped
// role can see it (not just Owner/Manager), matching this app's existing
// "status boxes are visible to the whole team" convention (e.g. the team
// chat unread indicator). Only the historical /report below is
// Owner/Manager-only, per the user's explicit decision.
router.get('/status', async (req, res, next) => {
  try {
    const agencyId = scopeAgencyId(req);
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    const [roster, openEntries] = await Promise.all([
      prisma.user.findMany({
        where: { agencyId, role: { in: ['PRODUCER'] }, status: 'ACTIVE' },
        select: { id: true, firstName: true, lastName: true },
      }),
      prisma.timeClockEntry.findMany({
        where: { agencyId, clockOutAt: null },
        include: { user: { select: { id: true, firstName: true, lastName: true, role: true } } },
      }),
    ]);
    const tmAssignments = await prisma.telemarketerAssignment.findMany({
      where: { agencyId, status: 'ACTIVE' },
      include: { telemarketer: { select: { id: true, firstName: true, lastName: true, status: true } } },
    });
    const tmRoster = tmAssignments
      .map((a) => a.telemarketer)
      .filter((u) => u && u.status === 'ACTIVE');

    const allTeam = [...roster, ...tmRoster];
    const openByUserId = new Map(openEntries.map((e) => [e.userId, e]));

    const clockedIn = [];
    const onLunch = [];
    const notClockedIn = [];
    for (const member of allTeam) {
      const entry = openByUserId.get(member.id);
      const bucket = stateOf(entry) === 'ON_LUNCH' ? onLunch : entry ? clockedIn : notClockedIn;
      bucket.push({ id: member.id, firstName: member.firstName, lastName: member.lastName, since: entry ? (entry.lunchStartAt && !entry.lunchEndAt ? entry.lunchStartAt : entry.clockInAt) : null });
    }

    return res.json({ success: true, clockedIn, onLunch, notClockedIn });
  } catch (err) {
    next(err);
  }
});

router.get('/report', requireRole('AGENCY_OWNER', 'AGENCY_MANAGER'), async (req, res, next) => {
  try {
    const agencyId = scopeAgencyId(req);
    if (!agencyId) return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED' });

    // A date-only ?to= (e.g. "2026-09-29", what the client's <input
    // type="date"> sends) parses as that day's UTC midnight — extend it to
    // the end of that day, or shifts logged later that same day silently
    // fall outside the range.
    const to = req.query.to ? new Date(req.query.to) : new Date();
    if (req.query.to) to.setUTCHours(23, 59, 59, 999);
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getFullYear(), to.getMonth(), 1);

    const entries = await prisma.timeClockEntry.findMany({
      where: { agencyId, clockInAt: { gte: from, lte: to }, clockOutAt: { not: null } },
      include: { user: { select: { id: true, firstName: true, lastName: true, role: true } } },
      orderBy: { clockInAt: 'asc' },
    });

    const rows = entries.map((e) => {
      const lunchMinutes = e.lunchStartAt && e.lunchEndAt
        ? Math.round((e.lunchEndAt.getTime() - e.lunchStartAt.getTime()) / 60000)
        : 0;
      const grossMinutes = Math.round((e.clockOutAt.getTime() - e.clockInAt.getTime()) / 60000);
      return {
        id: e.id,
        userId: e.userId,
        firstName: e.user.firstName,
        lastName: e.user.lastName,
        role: e.user.role,
        date: e.clockInAt.toISOString().slice(0, 10),
        clockInAt: e.clockInAt,
        clockOutAt: e.clockOutAt,
        lunchMinutes,
        workedMinutes: Math.max(0, grossMinutes - lunchMinutes),
      };
    });

    return res.json({ success: true, period: { from: from.toISOString(), to: to.toISOString() }, entries: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
