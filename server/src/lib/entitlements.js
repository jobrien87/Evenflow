const { prisma } = require('./db');

// Checks a real Agency boolean (crmEnabled / transfersEnabled / coachingEnabled)
// before allowing access to a module's routes. Platform Owner always passes
// (platform-level access). This is server-side enforcement, not just hiding
// a tab in the UI — never trust the client to have hidden something the
// server should also refuse.
function requireModuleEnabled(fieldName) {
  return async (req, res, next) => {
    try {
      if (req.user.role === 'PLATFORM_OWNER') return next();
      if (!req.user.agencyId) {
        return res.status(403).json({ success: false, error: 'NO_AGENCY', message: 'This account is not attached to an agency.' });
      }
      const agency = await prisma.agency.findUnique({ where: { id: req.user.agencyId }, select: { [fieldName]: true, name: true } });
      if (!agency) {
        return res.status(403).json({ success: false, error: 'AGENCY_NOT_FOUND' });
      }
      if (!agency[fieldName]) {
        return res.status(403).json({
          success: false,
          error: 'MODULE_NOT_ENTITLED',
          message: `${agency.name} does not currently have this module enabled on its plan.`,
        });
      }
      return next();
    } catch (err) {
      next(err);
    }
  };
}

// Sales Studio (Drills + Call Scoring + Call Coaching) uses the same real
// coachingEnabled unlock as requireModuleEnabled('coachingEnabled') always
// has, but adds one more check: Agency.salesStudioGateEnabled, a per-agency
// compliance-buffer switch. Off = Sales Studio is fully open regardless of
// unlock status; on (the default) = behaves exactly like
// requireModuleEnabled('coachingEnabled') always has.
async function requireSalesStudioAccess(req, res, next) {
  try {
    if (req.user.role === 'PLATFORM_OWNER') return next();
    if (!req.user.agencyId) {
      return res.status(403).json({ success: false, error: 'NO_AGENCY', message: 'This account is not attached to an agency.' });
    }
    const agency = await prisma.agency.findUnique({
      where: { id: req.user.agencyId },
      select: { coachingEnabled: true, salesStudioGateEnabled: true, name: true },
    });
    if (!agency) {
      return res.status(403).json({ success: false, error: 'AGENCY_NOT_FOUND' });
    }
    if (agency.salesStudioGateEnabled === false) return next();
    if (!agency.coachingEnabled) {
      return res.status(403).json({
        success: false,
        error: 'MODULE_NOT_ENTITLED',
        message: `${agency.name} does not currently have Sales Studio unlocked on its plan.`,
      });
    }
    return next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireModuleEnabled, requireSalesStudioAccess };
