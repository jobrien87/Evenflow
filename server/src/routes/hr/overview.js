// HR Overview — real org-structure aggregates only. Deliberately excludes
// live clock/attendance numbers (that's Part B's HrAttendanceLivePage,
// which reads TimeClockEntry directly) — this route never touches the
// time clock at all.
const express = require('express');
const { prisma } = require('../../lib/db');
const { requireHrRole } = require('../../middleware/hrAuth');

const router = express.Router();

router.get('/', requireHrRole('HR_ADMIN', 'HR_AUDITOR'), async (req, res, next) => {
  try {
    const agencyId = req.hrAgencyId;
    const [activeEmployeeCount, departmentCounts, pendingOnboardingCount, pendingOffboardingCount, totalDepartments] = await Promise.all([
      prisma.hrEmployeeProfile.count({ where: { agencyId, user: { status: 'ACTIVE' } } }),
      prisma.hrEmployeeProfile.groupBy({
        by: ['departmentId'],
        where: { agencyId, user: { status: 'ACTIVE' } },
        _count: { _all: true },
      }),
      prisma.hrEmployeeProfile.count({ where: { agencyId, onboardingStatus: { not: 'COMPLETE' } } }),
      prisma.hrEmployeeProfile.count({ where: { agencyId, offboardingStatus: { notIn: ['NOT_STARTED'] } } }),
      prisma.hrDepartment.count({ where: { agencyId, isActive: true } }),
    ]);

    const departmentIds = departmentCounts.map((row) => row.departmentId).filter(Boolean);
    const departments = departmentIds.length
      ? await prisma.hrDepartment.findMany({ where: { id: { in: departmentIds } }, select: { id: true, name: true } })
      : [];
    const departmentNameById = new Map(departments.map((d) => [d.id, d.name]));
    const byDepartment = departmentCounts.map((row) => ({
      departmentId: row.departmentId,
      departmentName: row.departmentId ? (departmentNameById.get(row.departmentId) || 'Unknown') : 'Unassigned',
      count: row._count._all,
    }));

    return res.json({
      success: true,
      overview: {
        activeEmployeeCount,
        totalDepartments,
        pendingOnboardingCount,
        pendingOffboardingCount,
        byDepartment,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
