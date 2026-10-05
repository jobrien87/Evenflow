// Break Room — the one centralized gate every route/game touches. Never
// duplicate this check inline in a route; always go through
// canAccessBreakRoom(req) so there is exactly one place that decides
// "is this person actually on break right now."

const { prisma } = require('./db');
const { openEntryWhere, stateOf } = require('./timeClockState');

const DEFAULT_SETTINGS = {
  games: { CONGO_LINE: true, BUCKETS: true, FULL_SEND: true, PILL_POP: true },
  pickMeUpEnabled: true,
  lunchEligible: false,
  soundsEnabled: true,
  achievementsEnabled: true,
  leaderboardScope: { office: true, agency: true },
};

// Merges a (possibly null, possibly partial) Agency.breakRoomSettings
// Json blob over the seeded default — an agency that has never touched
// this never gets a broken/missing config, just the default.
function resolveSettings(raw) {
  if (!raw || typeof raw !== 'object') return structuredClone(DEFAULT_SETTINGS);
  return {
    games: { ...DEFAULT_SETTINGS.games, ...(raw.games || {}) },
    pickMeUpEnabled: raw.pickMeUpEnabled ?? DEFAULT_SETTINGS.pickMeUpEnabled,
    lunchEligible: raw.lunchEligible ?? DEFAULT_SETTINGS.lunchEligible,
    soundsEnabled: raw.soundsEnabled ?? DEFAULT_SETTINGS.soundsEnabled,
    achievementsEnabled: raw.achievementsEnabled ?? DEFAULT_SETTINGS.achievementsEnabled,
    leaderboardScope: { ...DEFAULT_SETTINGS.leaderboardScope, ...(raw.leaderboardScope || {}) },
  };
}

const GAME_TYPES = ['CONGO_LINE', 'BUCKETS', 'FULL_SEND', 'PILL_POP'];

// Resolves which agency a Break Room action applies to for the calling
// user — identical "TM has no agencyId of its own" reasoning
// timeClock.js's resolveAgencyId already uses, but read-only here (a
// Telemarketer's open TimeClockEntry already recorded which agency they
// clocked in under, so we trust THAT, never a client-supplied id).
async function findOpenEntry(userId) {
  return prisma.timeClockEntry.findFirst({ where: openEntryWhere(userId), orderBy: { clockInAt: 'desc' } });
}

// The one real gate. Returns:
//   { allowed, reason, state, entry, agencyId, settings, user }
// reason (when !allowed) is one of:
//   NOT_ELIGIBLE_ROLE | NOT_CLOCKED_IN | WRONG_STATE | MODULE_DISABLED
async function canAccessBreakRoom(user) {
  if (!user || !['PRODUCER', 'TELEMARKETER'].includes(user.role)) {
    return { allowed: false, reason: 'NOT_ELIGIBLE_ROLE', state: null, agencyId: null, settings: null };
  }

  const entry = await findOpenEntry(user.id);
  const state = stateOf(entry);
  const agencyId = entry ? entry.agencyId : user.agencyId;

  if (!agencyId) {
    return { allowed: false, reason: 'NOT_CLOCKED_IN', state, agencyId: null, settings: null, entry };
  }

  const agency = await prisma.agency.findUnique({
    where: { id: agencyId },
    select: { breakRoomEnabled: true, breakRoomSettings: true, name: true },
  });
  const settings = resolveSettings(agency ? agency.breakRoomSettings : null);

  if (!agency || !agency.breakRoomEnabled) {
    return { allowed: false, reason: 'MODULE_DISABLED', state, agencyId, settings, entry };
  }

  if (!entry) {
    return { allowed: false, reason: 'NOT_CLOCKED_IN', state, agencyId, settings, entry };
  }

  const eligible = state === 'ON_BREAK' || (state === 'ON_LUNCH' && settings.lunchEligible);
  if (!eligible) {
    return { allowed: false, reason: 'WRONG_STATE', state, agencyId, settings, entry };
  }

  return { allowed: true, reason: null, state, agencyId, settings, entry };
}

// Human-readable line for the lock screen — never exposes internals,
// just enough for the employee to know what to do next.
const REASON_MESSAGES = {
  NOT_ELIGIBLE_ROLE: 'Break Room is for Producers and Telemarketers on a scheduled break.',
  NOT_CLOCKED_IN: "You're not clocked in right now.",
  MODULE_DISABLED: "Break Room isn't turned on for your agency right now.",
  WRONG_STATE: 'Clock into Break to unlock the arcade.',
};

function reasonMessage(reason) {
  return REASON_MESSAGES[reason] || 'Break Room is unavailable right now.';
}

// Achievement catalog — the full, static definition list. Server is the
// single source of truth (client never hardcodes these); unlock checks
// live in routes/breakRoom.js next to the score-submit handler, reading
// this same catalog so a key can never silently drift from its label.
const ACHIEVEMENTS = {
  CONGO_LINE: [
    { key: 'OFFICE_PARTY', label: 'Office Party', description: 'Grow a 10-dancer conga line.' },
    { key: 'FIRE_MARSHAL_CALLED', label: 'Fire Marshal Called', description: 'Grow a 25-dancer conga line.' },
    { key: 'BIGGER_OFFICE', label: 'We Need A Bigger Office', description: 'Grow a 50-dancer conga line.' },
  ],
  BUCKETS: [
    { key: 'HEATING_UP', label: 'Heating Up', description: 'Make 5 shots in a row.' },
    { key: 'CALL_THE_LEAGUE', label: 'Call The League', description: 'Make 10 shots in a row.' },
    { key: 'CANT_MISS', label: "Can't Miss", description: 'Make 20 shots in a row.' },
  ],
  FULL_SEND: [
    { key: 'SEND_IT', label: 'Send It', description: 'Land your first trick.' },
    { key: 'HR_WOULD_HATE_THIS', label: 'HR Would Hate This', description: 'Land a 5-trick combo in one run.' },
    { key: 'INSURANCE_CLAIM', label: 'Insurance Claim', description: 'Crash spectacularly.' },
  ],
  PILL_POP: [
    { key: 'CLEAN_DESK', label: 'Clean Desk', description: 'Clear your first board.' },
    { key: 'CRM_EXTERMINATOR', label: 'CRM Exterminator', description: 'Clear 100 bugs total.' },
    { key: 'MONDAY_KILLER', label: 'Monday Killer', description: 'Reach level 10.' },
  ],
};

module.exports = {
  GAME_TYPES,
  DEFAULT_SETTINGS,
  resolveSettings,
  canAccessBreakRoom,
  reasonMessage,
  ACHIEVEMENTS,
};
