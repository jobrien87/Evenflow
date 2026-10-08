# Backstage HR — Implementation Status

> Durable cross-session tracker. Read this file (and run `git status` /
> `git log`) at the start of any future session before resuming this
> work — do not assume prior conversational context is sufficient, per
> the directive's own Part 29.

**Branch**: `hr-suite/phase-1-foundation` (off `claude/check-this-out-o9xogs`
@ `2b13d59`). Not merged to the main development branch. No production
deployment has occurred or is authorized by this work.

**Baseline** (recorded before any HR code changed): server `npm test`
350/350 passing, client `npm run build` clean.

## Phases

- [x] **Phase 0 — Discovery**: existing-system audit, branch, baseline,
  this tracker. See `docs/hr-suite/EXISTING_SYSTEM_AUDIT.md`.
- [ ] **Phase 1 — Foundation, Time & Attendance, Scheduling, Leave**
  (in progress — see below)
- [ ] **Payroll** (directive's Phase 4) — not started. Blocked on a
  payroll provider sandbox/credentials from the user.
- [ ] **Employee lifecycle** (directive's Phase 5) — not started. Blocked
  on an e-signature provider choice/credentials.
- [ ] **People management** (directive's Phase 6) — not started. Includes
  the deferred full protected-leave *case* workflow and finer-grained
  `HrRole` values (e.g. `PAYROLL_ADMIN`) that confidential HR cases need.
- [ ] **Complete-suite features** (directive's Phase 7) — not started.
  Benefits administration blocked on a carrier/provider choice.
- [ ] **Hardening & validation** (directive's Phase 8) — not started.

## Phase 1 — detailed status

### Part A — Foundation
- [ ] Schema: `HrDepartment`, `HrPosition`, `HrLegalEmployer`,
  `HrEmployeeProfile`, `HrEmploymentHistoryEvent`, `HrRole` enum,
  `HrRoleGrant`
- [ ] Backend: `hrAuth.js` (`requireHrRole`), employees/departments/
  positions/legalEmployers/roleGrants/overview routes
- [ ] Client: Backstage HR nav, Overview/Employees/Departments/Settings
  pages, minimal My HR entry
- [ ] Tests: cross-tenant denial, HR_AUDITOR read-only, grant revoke,
  AGENCY_OWNER implicit access, employment-history-event correctness

### Part B — Time & Attendance (read-only consumer of TimeClockEntry)
- [ ] Schema: `HrTimesheet`, `HrTimesheetSegment`, `HrAttendanceException`
- [ ] Backend: `hrTimesheetBuilder.js`, `hrAttendanceDetection.js` job,
  `timeAttendance.js` routes
- [ ] Client: live status, timesheets, exceptions review, My Time
- [ ] Tests: timesheet-builder edge cases, zero writes to
  `TimeClockEntry` (regression guard), NCNS requires human review

### Part C — Scheduling & Leave
- [ ] Schema: `HrShiftTemplate`, `HrShiftAssignment`, `HrShiftSwapRequest`,
  `HrLeaveType`, `HrLeavePolicy`, `HrLeavePolicyAssignment`,
  `HrLeaveLedgerEntry`, `HrLeaveRequest`
- [ ] Backend: `scheduling.js` routes, `hrLeaveAccrual.js` job,
  `leave.js` routes
- [ ] Client: schedule calendar, shift templates, leave policies/calendar,
  My Schedule, My Time Off
- [ ] Tests: accrual math/idempotency, concurrent-approval safety,
  protected-leave exclusion, calendar redaction, swap-approval gate

### Final verification (all of Phase 1)
- [ ] `npm test` / `npm run build` — 0 regressions against the 350-test
  baseline
- [ ] Real time-clock walkthrough — Break Room/clock behavior unchanged
- [ ] Real PTO request/approval walkthrough
- [ ] Real-browser Playwright pass
- [ ] Commit and push to `hr-suite/phase-1-foundation`

## Known defects

None yet — nothing has been built.

## External integration blockers (affecting future phases only)

- Payroll provider (Gusto/ADP/other): no sandbox/credentials.
- E-signature provider: no choice made, no credentials.
- Benefits carrier: no choice made, no credentials.

## Decisions made (documented defaults, confirmed with the user)

- Phase 1 scope = Foundation + Time & Attendance + Scheduling + Leave
  (the directive's own Phase 1-3), confirmed with the user over the
  smaller "Foundation only" default.
- HR authorization = additive `HrRoleGrant` layer (`HR_ADMIN`,
  `HR_AUDITOR`) on top of existing roles, not new top-level `Role` enum
  values — confirmed with the user.
- Jurisdiction scope for Phase 1 = U.S.-only; the legal-employer model
  stores a generic country/region so nothing has to be reworked later if
  a Philippines-based workforce becomes real — confirmed with the user.
- `SUPPORT_ADMIN`/`READ_ONLY` (existing, unused `Role` enum values) are
  vestigial, not reserved for HR — confirmed with the user; the new
  `HrRoleGrant` system is independent of them.
- `HrEmployeeProfile` is a 1:1 extension of `User` (keyed by
  `userId @unique`), never a second identity system.
- Protected-leave *case* workflow (eligibility review, documentation,
  intermittent tracking, accommodation coordination) is deferred to the
  People-management phase alongside HR Cases, sharing that
  confidentiality infrastructure — Phase 1's leave module only flags a
  leave type `isProtected` and excludes it from balance-denial/exposes it
  only to `HR_ADMIN`.
- Scheduling's shift-swap flow is a simple request+manager-approval
  workflow in Phase 1, not a self-serve open-marketplace of pickup offers.
- The schedule calendar uses click-to-assign in Phase 1 (fully
  keyboard-accessible); true drag-and-drop is a later polish pass, not a
  Phase-1 blocker.
- Overtime handling in Phase 1 is a simple configurable weekly-minutes
  threshold used only as a scheduling heads-up — explicitly not a
  jurisdiction-aware payroll overtime calculation (that's the Payroll
  phase, after legal/payroll review).

## Next required action

Begin Phase 1 Part A: schema migration (`HrDepartment` through
`HrRoleGrant`), then backend, client, tests, in that order — per the
plan at `/root/.claude/plans/root-claude-uploads-f963d8da-f76a-598c-adaptive-shore.md`.
