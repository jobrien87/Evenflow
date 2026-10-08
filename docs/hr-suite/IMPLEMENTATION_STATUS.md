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

### Part A — Foundation — COMPLETE, verified, committed
- [x] Schema: `HrDepartment`, `HrPosition`, `HrLegalEmployer`,
  `HrEmployeeProfile`, `HrEmploymentHistoryEvent`, `HrRole` enum,
  `HrRoleGrant`. Additive-only; `npx prisma db push` succeeded clean.
- [x] Backend: `server/src/middleware/hrAuth.js` (`requireHrRole`,
  `hasHrRole`); `server/src/routes/hr/{departments,positions,
  legalEmployers,roleGrants,employees,overview}.js` + `hr/index.js`
  composer (mounts `requireAuth` + `requireModuleEnabled('hrEnabled')`
  once); mounted at `/api/hr` in `app.js`. `GET /hr/employees/me` is a
  self-service, no-HR-role-required route for the My HR page.
- [x] Client: `Backstage HR` nav item (Agency Owner/Manager, secondary
  section) → `client/src/pages/hr/HrDashboardPage.jsx` (tabbed Overview/
  Employees/Departments/Settings[Legal Employers + Role Grants], at
  `/agency/hr`); Platform Owner reaches the same page per-agency via a
  "BACKSTAGE HR →" link on `AgencyDetailPage.jsx` → `/platform/agencies/
  :agencyId/hr`; `My HR` nav item (Producer/Telemarketer) →
  `client/src/pages/hr/HrMyProfilePage.jsx` (self-service, honest
  "hasn't been set up yet" empty state) at `/producer/my-hr` and
  `/telemarketer/my-hr`. `client/src/lib/api.js` has the full `hr*`
  wrapper-function set.
- [x] Tests: `server/src/routes/hrFoundation.test.js` (real-DB/HTTP, 8
  cases) — `Agency.hrEnabled` module gate, AGENCY_OWNER implicit access
  with no grant row, HR_AUDITOR read-only + immediate loss of access on
  revoke, only AGENCY_OWNER/PLATFORM_OWNER can mint a grant (not even an
  HR_ADMIN grant-holder can), cross-agency denial, optimistic-concurrency
  PATCH (stale version → 409) + exact employment-history-event rows
  (including a true no-op PATCH writing zero new history events),
  `GET /hr/employees/me` self-service shape, `GET /hr/overview`
  aggregates. `npm test`: 358/358 passing (350 baseline + 8 new, zero
  regressions). `npm run build` (client): clean. Real-browser Playwright
  check of both the Owner dashboard and the Producer My HR page: both
  render correctly with no console errors from this feature.

**Real-world note for a future session**: the server test suite's npm
script (`node --test src/**/*.test.js`) is expanded by the shell before
Node sees it, and this shell has `globstar` off — so a test file nested
more than one directory deep under `src/` (e.g. the original
`src/routes/hr/hr.test.js` location) is silently never run, by `npm
test` locally OR in CI (GitHub Actions' default `bash` also has
globstar off). This was caught by hand (comparing the test count before
and after adding the file) and fixed by keeping all HR route tests flat
at `server/src/routes/hrFoundation.test.js`, matching every other route
test file's existing convention — never nest a new `*.test.js` file
under `src/routes/hr/` or any other subdirectory without first fixing
this glob gap (e.g. switching the npm script to rely on Node's own
built-in recursive test discovery) — Part B/C's own test files must stay
flat under `server/src/` too, for the same reason.

### Part B — Time & Attendance (read-only consumer of TimeClockEntry) — COMPLETE, verified, committed
- [x] Schema: `HrTimesheet`, `HrTimesheetSegment`, `HrAttendanceException`.
  Additive-only; `npx prisma db push` succeeded clean.
- [x] Backend: `server/src/lib/hrTimesheetBuilder.js` — `segmentsForEntry`
  (pure, derives WORK/LUNCH/BREAK segments from one `TimeClockEntry` row,
  sorted by real chronological order regardless of field-declaration
  order; flags `ORDERING_ANOMALY`/`OVERNIGHT_SHIFT`/
  `STILL_OPEN_PAST_EXPECTED_SHIFT_LENGTH`, never fabricates an end time),
  `buildTimesheetForEmployee`/`computeAndStoreTimesheet` (the only
  functions that read `TimeClockEntry` — a regression-guard test asserts
  this literally by grepping the source). `server/src/jobs/
  hrAttendanceDetection.js` — periodic (`setInterval`, same in-process
  convention as `leadPriorityRecompute.js`), registered in `index.js`;
  Part B scope note: without Part C's `HrShiftAssignment` or an agency
  grace-period setting, it can only detect what the raw clock data
  itself reveals — a forgotten clock-out (`MISSED_PUNCH`) — never a
  fabricated LATE_ARRIVAL/NO_CALL_NO_SHOW_CANDIDATE guess; every row it
  creates starts `OPEN`, never auto-resolved. `server/src/routes/hr/
  timeAttendance.js` — `GET /hr/attendance/live`, `POST /hr/timesheets/
  compute`, `GET /hr/timesheets[/mine|/:id]`, `POST /hr/timesheets/:id/
  {submit,approve,reject}` (state-machine-enforced: OPEN→SUBMITTED→
  APPROVED/REJECTED, an APPROVED timesheet is locked against
  recomputation), `GET /hr/attendance/exceptions`, `POST /hr/attendance/
  exceptions/:id/review` (the only way out of OPEN, HR_ADMIN only).
- [x] Client: `HrDashboardPage.jsx` gained ATTENDANCE (live roster status
  + open-exception review queue) and TIMESHEETS (compute + approve/
  reject) tabs. `HrMyProfilePage.jsx` gained a MY TIME section
  (self-service: view own timesheets, submit an OPEN one — no
  self-compute, an honest "ask HR" empty state when nothing's been
  computed yet).
- [x] Tests: `server/src/lib/hrTimesheetBuilder.test.js` (11 cases — 8
  pure-logic segment-derivation edge cases including the regression-guard
  grep, 3 real-DB) + `server/src/routes/hrAttendance.test.js` (4 real-DB/
  HTTP cases covering the full timesheet state machine, live status,
  and detection→human-review flow). `npm test`: 373/373 (358 baseline +
  15 new, zero regressions — one isolated flake seen once across many
  runs, not reproduced on two immediate reruns, likely unrelated DB-pool
  contention in the large real-DB suite, not a Part B defect). `npm run
  build` (client): clean. Real-browser Playwright check: live status
  shows a real `ON_BREAK` state, a stale shift produces a real
  `MISSED_PUNCH` candidate, reviewing it (EXCUSE) removes it from the
  OPEN queue, computing a timesheet via the UI shows up correctly, and
  the employee's own My Time page shows and successfully submits it.

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

Parts A and B are complete and verified (373/373 server tests, clean
client build, real-browser checks of both). Begin Phase 1 Part C —
Scheduling & Leave: schema (`HrShiftTemplate`/`HrShiftAssignment`/
`HrShiftSwapRequest`/`HrLeaveType`/`HrLeavePolicy`/
`HrLeavePolicyAssignment`/`HrLeaveLedgerEntry`/`HrLeaveRequest`), then
`scheduling.js` routes, `hrLeaveAccrual.js` (idempotent accrual posting
— deterministic `idempotencyKey`, never double-posts on a retried run;
`HrLeaveLedgerEntry` is the *only* source of truth for a balance, never
a bare stored integer), `leave.js` routes (balance-denial check skipped
for `isProtected` leave types — flagged to HR, never auto-approved/
denied), then client (schedule calendar, leave policies/calendar, My
Schedule, My Time Off), then tests — per the plan at
`/root/.claude/plans/root-claude-uploads-f963d8da-f76a-598c-adaptive-shore.md`.
Remember the test-file-location gap noted above before adding any new
`*.test.js` file — keep it flat under `server/src/`, never nested.
Once Part C lands, Part B's `HrAttendanceException` detection job can
be extended to use `HrShiftAssignment` as a real expected-schedule
baseline (LATE_ARRIVAL/EARLY_DEPARTURE/NO_CALL_NO_SHOW_CANDIDATE) — not
required for Part C itself, note it as a natural follow-up only.
