const { v4: uuidv4 } = require('uuid');
const { getSessionUser, SESSION_COOKIE } = require('../lib/auth');
const { IMPERSONATION_COOKIE, resolveImpersonation } = require('../lib/impersonation');

function correlationId(req, res, next) {
  req.correlationId = req.headers['x-correlation-id'] || uuidv4();
  res.setHeader('x-correlation-id', req.correlationId);
  next();
}

// Attaches the REAL, authenticated session user as req.realUser always.
// If a valid impersonation is active (Platform-Owner-only, tied to the real
// session — see lib/impersonation.js), req.user becomes the target being
// viewed as, while req.realUser still refers to the actual logged-in
// Platform Owner. Every other route in the app just reads req.user and
// behaves correctly without knowing impersonation exists — including
// staying correctly LOCKED OUT of Platform-Owner-only routes while
// impersonating a non-platform-owner, since req.user.role reflects the
// target, not the real identity.
async function attachUser(req, res, next) {
  try {
    const rawToken = req.cookies ? req.cookies[SESSION_COOKIE] : null;
    const realUser = await getSessionUser(rawToken);
    req.realUser = realUser || null;
    req.user = realUser || null;
    req.isImpersonating = false;
    req.impersonationLogId = null;

    if (realUser) {
      const impersonationLogId = req.cookies ? req.cookies[IMPERSONATION_COOKIE] : null;
      if (impersonationLogId) {
        const resolved = await resolveImpersonation(realUser, impersonationLogId);
        if (resolved) {
          req.user = resolved.targetUser;
          req.isImpersonating = true;
          req.impersonationLogId = resolved.log.id;
        }
      }
    }

    next();
  } catch (err) {
    next(err);
  }
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'UNAUTHENTICATED',
      message: 'You must be logged in.',
      correlationId: req.correlationId,
    });
  }
  next();
}

// Restrict to specific roles.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'UNAUTHENTICATED', correlationId: req.correlationId });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
        message: 'You do not have permission to do this.',
        correlationId: req.correlationId,
      });
    }
    next();
  };
}

// Enforce that a non-platform-owner user can only touch their OWN agency's data.
// This is the tenant-isolation backstop: never trust agencyId from the client alone.
function scopeAgencyId(req) {
  if (req.user.role === 'PLATFORM_OWNER') {
    // Platform owner may specify an agencyId via query/param/body; otherwise null = all.
    return req.query.agencyId || req.params.agencyId || req.body.agencyId || null;
  }
  // Every other role is hard-locked to their own agency, no matter what the client sends.
  return req.user.agencyId;
}

// Seniority for one account acting ON another (password reset, deactivate,
// role changes, etc.) — agency-membership alone (scopeAgencyId) is never
// enough for these, since it doesn't stop an AGENCY_MANAGER from targeting
// their own AGENCY_OWNER. Strictly senior only: a manager can act on a
// producer/TM, an owner can act on a manager or below, but nobody can act
// on a peer or superior — only PLATFORM_OWNER is unconditionally allowed.
const ROLE_RANK = { PLATFORM_OWNER: 3, AGENCY_OWNER: 2, AGENCY_MANAGER: 1, PRODUCER: 0, TELEMARKETER: 0 };

function canActOnUser(actorRole, targetRole) {
  if (actorRole === 'PLATFORM_OWNER') return true;
  return (ROLE_RANK[actorRole] ?? -1) > (ROLE_RANK[targetRole] ?? -1);
}

module.exports = { correlationId, attachUser, requireAuth, requireRole, scopeAgencyId, canActOnUser };
