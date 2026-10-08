// Backstage HR authorization — additive on top of the app's real Role
// system, never a second one. PLATFORM_OWNER and AGENCY_OWNER always
// have full HR_ADMIN authority for their own agency with no grant row
// required (matching how AGENCY_OWNER already implicitly outranks
// AGENCY_MANAGER via auth.js's ROLE_RANK elsewhere) — everyone else
// needs an active (unrevoked) HrRoleGrant for the specific role and
// agency. See docs/hr-suite/IMPLEMENTATION_STATUS.md's "Decisions made"
// for why this is a separate grant table rather than new top-level Role
// enum values.
const { prisma } = require('../lib/db');

// HR_ADMIN authority also satisfies an HR_AUDITOR check — admin implies
// read access, never the reverse.
async function hasHrRole(user, agencyId, hrRole) {
  if (user.role === 'PLATFORM_OWNER') return true;
  if (user.role === 'AGENCY_OWNER' && user.agencyId === agencyId) return true;
  if (!agencyId) return false;

  const roles = hrRole === 'HR_AUDITOR' ? ['HR_ADMIN', 'HR_AUDITOR'] : [hrRole];
  const grant = await prisma.hrRoleGrant.findFirst({
    where: { userId: user.id, agencyId, hrRole: { in: roles }, revokedAt: null },
    select: { id: true },
  });
  return !!grant;
}

// requireHrRole(...hrRoles) — passes if the caller holds ANY of the
// listed roles for the target agency. The target agency is resolved the
// same way every other HR route resolves it: PLATFORM_OWNER may specify
// one via query/param/body, everyone else is locked to their own
// req.user.agencyId. Sets req.hrAgencyId so route handlers never have to
// re-derive it.
function requireHrRole(...hrRoles) {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, error: 'UNAUTHENTICATED', correlationId: req.correlationId });
      }
      const agencyId = req.user.role === 'PLATFORM_OWNER'
        ? (req.query.agencyId || req.params.agencyId || req.body.agencyId || null)
        : req.user.agencyId;
      if (!agencyId) {
        return res.status(400).json({ success: false, error: 'AGENCY_REQUIRED', correlationId: req.correlationId });
      }
      for (const hrRole of hrRoles) {
        // eslint-disable-next-line no-await-in-loop
        if (await hasHrRole(req.user, agencyId, hrRole)) {
          req.hrAgencyId = agencyId;
          return next();
        }
      }
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
        message: 'You do not have the required HR permission for this agency.',
        correlationId: req.correlationId,
      });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireHrRole, hasHrRole };
