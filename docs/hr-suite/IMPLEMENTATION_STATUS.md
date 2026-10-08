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
  (Parts A/B/C all built, tested, and committed — only Phase 1's own
  final combined verification pass remains; see below)
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

### Part C — Scheduling & Leave — COMPLETE, verified, committed
- [x] Schema: `HrShiftTemplate`, `HrShiftAssignment`, `HrShiftSwapRequest`,
  `HrLeaveType`, `HrLeavePolicy`, `HrLeavePolicyAssignment`,
  `HrLeaveLedgerEntry`, `HrLeaveRequest`, `HrLeaveTransactionType` enum,
  plus a new `HrSettings` model (`weeklyOvertimeThresholdMinutes`, a
  plain scheduling heads-up, not a payroll calculation — referenced but
  not previously modeled when Part B's `hrTimesheetBuilder.js` was
  written). Additive-only; `npx prisma db push` succeeded clean.
- [x] Backend: `server/src/lib/hrScheduling.js` (pure — `resolveShiftInstants`
  resolves a workDate + "HH:MM" + work time zone to real UTC instants via
  the same guess-and-correct convergence as `lib/timezone.js`'s
  `zonedMidnightUtc`, generalized to an arbitrary wall-clock time;
  `wallClockHHMM` is its inverse; `workDateOverlapsLeave`/`isoWeekRange`
  are the overlap/weekly-threshold helpers). `server/src/lib/
  hrLeaveLedger.js` (`getBalanceMinutes` — the one shared
  SUM(minutes)-over-the-ledger helper, used by both `leave.js` and
  `hrLeaveAccrual.js` so they never drift). `server/src/lib/
  hrLeaveAccrual.js` — `postAccrualsForOpenPolicies({ now })`: FRONT_LOADED/
  PER_PAY_PERIOD (semi-monthly 1st–15th/16th–end, a documented default —
  no real payroll "pay period" model exists yet)/PER_HOUR_WORKED (reads
  Part B's already-derived `HrTimesheet.regularMinutes` for the calendar
  month, never `TimeClockEntry` directly — `hrTimesheetBuilder.js` stays
  the one place that reads it), annual-cap trimming, carryover-expiration
  (only at a genuine year-boundary rollover — i.e. only when a ledger
  entry already exists from before the current calendar year; a brand-new
  assignment's first-ever grant is never pre-trimmed), every ledger entry
  it posts carries an explicit `createdAt: now` (never the column's
  real-wall-clock default) so a historical/simulated run stays internally
  consistent with its own year/cap math, and a deterministic
  `idempotencyKey` backed by the column's real DB `@unique` constraint
  (a P2002 race on a concurrent run is treated as a no-op, never an
  error). Registered via `startHrLeaveAccrualJob()` in `src/index.js`,
  same in-process `setInterval` convention as Part B's attendance job.
  `server/src/routes/hr/scheduling.js` — `GET /hr/schedule[/mine]`,
  `GET/POST /hr/schedule/shift-templates`, `POST/PATCH/DELETE /hr/schedule/
  shifts[/:id]` (DELETE is a soft-cancel — `status: CANCELLED`, never a
  hard delete, matching this app's never-destroy-history convention),
  `POST /hr/schedule/shifts/:id/swap-request` (employee-initiated, owner-
  checked), `GET /hr/schedule/swap-requests`, `POST .../approve` (requires
  an explicit covering employee, reassigns `HrShiftAssignment` and sets
  `status: COVERED` only inside the same conditional-`updateMany`-gated
  transaction as the status change — never auto-applied) `/deny`,
  `GET/PATCH /hr/settings`. A local `requireHrAdminOrManager` middleware
  (plain `AGENCY_OWNER`/`AGENCY_MANAGER`/`PLATFORM_OWNER` OR an `HR_ADMIN`
  grant — reusing `hasHrRole` from `hrAuth.js`, not modifying it) backs
  every scheduling write, per the plan's own "HR_ADMIN/manager" note;
  `GET /hr/schedule[/shift-templates]` and `GET /hr/leave/calendar` are
  open to any authenticated agency member (same broad-visibility
  precedent as `GET /timeclock/status`), with redaction — not access —
  protecting a protected leave type. `server/src/routes/hr/leave.js` —
  `GET/POST /hr/leave/types`, `GET/POST /hr/leave/policies`, `GET/POST
  /hr/leave/policy-assignments`, `GET /hr/leave/balance` (self or, for
  HR_AUDITOR+, `?employeeProfileId=`), `GET /hr/leave/requests[/mine]`,
  `POST /hr/leave/requests` (self-service; balance-denial skipped
  entirely for an `isProtected` leave type — the request is still
  created, just left `PENDING` for ordinary HR review, never auto-
  approved or auto-denied), `POST /hr/leave/requests/:id/{approve,deny}`
  (approve is concurrency-safe: a conditional `updateMany(WHERE status:
  PENDING)` inside the same transaction as the `USE` ledger write means a
  real race has exactly one winner, confirmed under `Promise.all`; deny
  posts no ledger entry), `GET /hr/leave/calendar` (redacts a protected
  leave type to `"Approved time off"` — and hides `isProtected` itself —
  for anyone without real `HR_ADMIN` authority for that agency). Wired
  into `hr/index.js`.
- [x] Client: `HrDashboardPage.jsx` gained SCHEDULE (week view with
  prev/this/next-week nav, click-to-assign shift creation from a
  template or custom HH:MM, shift-template management, pending
  swap-request review), LEAVE POLICIES (leave type/policy/
  policy-assignment config, pending leave-request review queue), and
  LEAVE CALENDAR tabs, plus a Scheduling settings card under SETTINGS.
  `HrMyProfilePage.jsx` gained My Schedule (own upcoming shifts, request
  a swap, a `SWAP PENDING` badge while one is outstanding) and My Time
  Off (balance tiles, request form, request history) sections.
  `client/src/lib/api.js` has the full new `hr*` wrapper set. A
  real-browser pass (see below) independently found two of the same
  bugs a concurrent session on this branch had just fixed, plus one
  more of its own:
  - `HrDashboardPage.jsx`'s `load()`: a plain `AGENCY_MANAGER` with no
    HR grant 403ing on a Part A Foundation-only call inside the page's
    one `Promise.all` blanked the whole page with a raw error. This
    session's own first fix made `load()` resilient (settle every call
    independently, degrade only the failed piece). While rebasing onto
    this branch's latest tip, a concurrent session under this same
    overall effort had already landed a different, more thorough fix
    for the identical bug — real per-tier access control (`GET /hr/
    overview` now returns an `access: {hrRole, canWrite,
    canManageGrants}` block; every existing tab hides write controls
    for a read-only `HR_AUDITOR` viewer; a Manager with zero grant sees
    an honest "ask your Agency Owner" message instead of a raw error).
    Rather than silently overriding that already-shipped, deliberately-
    reasoned design during the rebase, this session's own `load()` fix
    was dropped in favor of it, and Part C's three new tabs
    (SCHEDULE/LEAVE POLICIES — LEAVE CALENDAR is read-only already)
    were extended with the same `canWrite` gating as every other tab,
    for consistency. Net effect: reaching Backstage HR at all still
    requires at least an `HR_AUDITOR` grant for a Manager (by that
    session's explicit design), but once there, every tab — Part A and
    Part C alike — now correctly shows/hides write controls by real
    access tier instead of rendering buttons that would just 403 on
    click.
  - Shift times rendered via a bare `toLocaleTimeString()` with no
    explicit zone, so they showed in the *viewer's* browser-local zone
    instead of the shift's own work time zone (a shift resolved for
    9:00 AM Eastern read as "01:00 PM" in a UTC-zoned browser) — fixed
    by passing an explicit `timeZone` (the employee's own
    `workTimeZone`) to every `toLocaleTimeString()` call for a shift,
    in both `HrDashboardPage.jsx`'s SCHEDULE tab and
    `HrMyProfilePage.jsx`'s My Schedule section.
  - A submitted swap request gave the requesting employee no feedback
    that it was pending — the shift's own `status` stays `SCHEDULED`
    until a manager decides — fixed by having `GET /hr/schedule/mine`
    include each shift's pending swap requests and showing a `SWAP
    PENDING` badge in place of the button while one is outstanding.
- [x] Tests: `server/src/lib/hrLeaveAccrual.test.js` (6 cases, real-DB):
  accrual math per method (the PER_HOUR_WORKED case against real
  `HrTimesheet.regularMinutes`, confirming a different month's
  timesheet doesn't leak in), annual-cap trimming to the exact
  remaining room then zero further posts once exhausted,
  carryover-expiration only at a genuine year-boundary rollover (the
  real bug this test caught — see "Known defects" below), and
  idempotency under true `Promise.all` concurrency. `server/src/routes/
  hrLeave.test.js` (6 cases, real-DB/HTTP): insufficient balance
  rejected before a request is ever created, approve posts exactly one
  `USE` entry and deny posts none, two concurrent approval attempts —
  exactly one 200/one 409/exactly one `USE` entry, a protected leave
  type requestable and approvable with zero balance, calendar redaction
  (manager sees `"Approved time off"`, owner's implicit `HR_ADMIN` sees
  the real name), cross-agency denial. `server/src/routes/
  hrScheduling.test.js` (6 cases, real-DB/HTTP): agency-scoped shift
  CRUD (a plain manager succeeds, a cross-agency owner is denied;
  soft-cancel confirmed via a direct row read after "delete"), a shift
  overlapping approved leave still gets created with a
  `SHIFT_OVERLAPS_APPROVED_LEAVE` warning (never silently blocked or
  double-booked), and a swap changes nothing (`HrShiftAssignment` row
  read directly) until explicit manager approval, rejected for a
  non-owner requester and a non-manager approver, with deny leaving the
  assignment untouched. All three kept flat under `server/src/lib/`/
  `server/src/routes/` per the documented glob gotcha. `npm test`:
  391/391 (373 baseline + 18 new, zero regressions, confirmed stable
  across two consecutive full-suite runs). `npm run build` (client):
  clean. Real-browser Playwright pass (seeded test agency: an owner, a
  manager, a producer + a covering teammate, a paid `Vacation` leave
  type with a `FRONT_LOADED` policy and a real granted balance, a
  protected `FMLA` leave type, a shift template, a real scheduled
  shift): Owner — Schedule tab shows the seeded shift, creating a new
  shift through the UI works and the modal closes; Leave Policies shows
  real leave types/policies, approving a real pending request through
  the UI works; Leave Calendar shows the owner's own `FMLA` entry under
  its real name (implicit `HR_ADMIN`); Settings shows the new
  Scheduling card. Manager — Leave Calendar redacts the same `FMLA`
  entry to `"Approved time off"` (confirmed by direct screenshot
  inspection, not just text-matching, since the page's own explanatory
  copy mentions "FMLA" as an example and would otherwise false-positive
  a naive text search). Producer — My Schedule shows real shifts in the
  correct work time zone, requesting a swap shows a `SWAP PENDING`
  badge; My Time Off shows the real balance, submitting a new request
  works, request history shows real past-approved entries. Zero
  uncaught JS exceptions (`pageerror`) across all three sessions; the
  only console noise was the manager's expected 403s on Part A
  endpoints it genuinely has no grant for, plus one pre-existing,
  unrelated `ERR_CERT_AUTHORITY_INVALID` noise item on every page load
  in this sandboxed environment. All seeded test data deleted and both
  dev servers stopped afterward.

### Final verification (all of Phase 1)
- [ ] `npm test` / `npm run build` — 0 regressions against the 350-test
  baseline
- [ ] Real time-clock walkthrough — Break Room/clock behavior unchanged
- [ ] Real PTO request/approval walkthrough
- [ ] Real-browser Playwright pass
- [ ] Commit and push to `hr-suite/phase-1-foundation`

## Known defects

None open. Two were caught and fixed during Part C's own build (not
shipped, not released — documented here per this tracker's convention
of recording what was caught, not just what shipped clean):
- `hrLeaveAccrual.js`'s carryover-expiration check originally ran on
  every accrual post, including a policy assignment's very first-ever
  `FRONT_LOADED` grant — immediately trimming a brand-new balance down
  to `carryoverCapMinutes` before the employee had a chance to use any
  of it. Caught by manual end-to-end smoke testing before the formal
  test suite was even written; fixed by only applying the trim when a
  ledger entry already exists from before the current calendar year.
- Three client-side bugs caught only by the real-browser Playwright
  pass, not by any test: `HrDashboardPage.jsx`'s single `Promise.all`
  blanked the whole page for a manager with no HR grant instead of
  degrading gracefully (this session's own fix for this one was later
  superseded, during a rebase, by a concurrent session's independent
  and more thorough fix for the identical bug — see Part C's own Client
  entry above for the full reconciliation story); shift times rendered
  in the viewer's browser-local zone instead of the shift's own work
  time zone; a submitted swap request gave no pending-state feedback.
  All three fixed in what's on the branch now.

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
- Part C's benefit-year anchor is the calendar year (Jan 1), not a
  per-employee hire-date anniversary — simple and correct for the
  common case; a true anniversary-based benefit year is a later
  refinement, not a Phase-1 blocker (documented default, not raised
  with the user — low-stakes and reversible, consistent with this
  tracker's "choose sensible defaults when safe/reversible" rule).
- Part C's pay-period anchor for `PER_PAY_PERIOD` accrual is
  semi-monthly (1st–15th, 16th–end of month) — there is no real payroll
  "pay period" model anywhere in this codebase yet (that's the Payroll
  phase), so this is a documented placeholder shape, not a real
  configurable payroll calendar.
- `PER_HOUR_WORKED` accrual reads Part B's already-derived, already-
  approved-timesheet-eligible `HrTimesheet.regularMinutes`, never raw
  `TimeClockEntry` — keeps `hrTimesheetBuilder.js` as the one place in
  this suite that reads the raw clock table, and `accrualAmountMinutes`
  for this method is interpreted as "minutes of leave earned per 60
  minutes worked" (the schema has only one Int field to carry the
  rate — documented here since the field's meaning is otherwise
  implicit).
- `GET /hr/schedule`, `GET /hr/schedule/shift-templates`, and `GET
  /hr/leave/calendar` are deliberately open to any authenticated agency
  member, not HR-role-gated — "who's working when" and "who's
  approved off" are ordinary team-visibility information (same
  precedent as the pre-existing `GET /timeclock/status`), and
  redaction — not access — is what actually protects a protected leave
  type's category. Shift *mutation* (`POST/PATCH/DELETE` shifts,
  swap-request approval) still requires `HR_ADMIN` or a plain
  `AGENCY_OWNER`/`AGENCY_MANAGER` role, per the plan's own "HR_ADMIN/
  manager" note for scheduling.
- A shift-assignment "delete" (`DELETE /hr/schedule/shifts/:id`) is a
  soft-cancel (`status: CANCELLED`), not a hard row delete — matches
  this app's established never-destroy-history convention (same
  precedent as `HrDepartment`'s PATCH-`isActive:false` "delete").
- A new `HrSettings` model (per-agency `weeklyOvertimeThresholdMinutes`)
  was added in Part C even though it isn't one of the plan's explicitly
  listed Prisma blocks, because the plan's own Backend prose calls for
  it by name and Part B's `hrTimesheetBuilder.js` already had a
  placeholder comment anticipating it. Part B's own `HrTimesheet.
  overtimeMinutes` calculation was deliberately left using its existing
  constant rather than wired to this new setting, to avoid touching
  Part B's already-shipped, already-tested code in this round — a
  future pass can wire them together.
- This app's pre-existing `PtoRequest` model (Roster Settings, a
  simple agency-wide PTO request feature that predates this suite) is
  left completely untouched and runs independently of Part C's new
  `HrLeaveLedgerEntry`-backed leave system — they are two separate,
  non-conflicting features (different model names, no schema
  collision); no attempt was made to merge or migrate between them,
  since nothing in the plan called for that and the existing-system
  audit's "no conflicting models" note didn't anticipate this one
  pre-existing overlap. Flagged here for a future phase to actually
  decide whether/how to consolidate them.

## Next required action

Parts A, B, and C are all complete and verified (391/391 server tests,
clean client build, real-browser checks of all three). The next step is
Phase 1's own final, full-suite verification pass — not more building:
re-run `npm test`/`npm run build` one more time fresh on this exact
commit; do a real local time-clock walkthrough (clock in, lunch, break,
clock out) confirming Break Room eligibility and `GET /timeclock/status`
behave byte-for-byte unchanged, and that Part B's derived
`HrTimesheet`/`HrTimesheetSegment` rows match by hand-calculation; do a
real end-to-end PTO walkthrough through the actual UI (not just the API
tests) — request leave, approve it, confirm the balance and exactly one
`USE` entry, request more than the balance allows and confirm rejection,
schedule a shift overlapping an approved leave request and confirm the
warning; confirm cross-agency denial end-to-end across every Part
A/B/C endpoint with two isolated test agencies; a combined real-browser
Playwright pass confirming Backstage HR's full nav (Overview/Employees/
Departments/Settings/Attendance/Timesheets/Schedule/Leave Policies/
Leave Calendar) for Owner/Manager/Platform Owner, and My HR's full set
(My Dashboard/My Time/My Schedule/My Time Off) for Producer/
Telemarketer; then update both tracker docs and commit/push the final
state to `hr-suite/phase-1-foundation`, per the plan's own Phase 0+1
Verification section. No merge to the main development branch or
production deployment without separate explicit authorization, per the
directive's own Part 27 rule. Once that full pass is clean, Part B's
`HrAttendanceException` detection job can be extended to use the now-real
`HrShiftAssignment` data as an expected-schedule baseline (LATE_ARRIVAL/
EARLY_DEPARTURE/NO_CALL_NO_SHOW_CANDIDATE) — a natural follow-up, not a
blocker for closing out Phase 1.
