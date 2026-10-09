# Backstage HR — Existing System Audit

> **Status: verified, not assumed.** Every claim below was confirmed by
> reading the actual repository (three parallel investigation passes
> against `server/` and `client/` on branch `hr-suite/phase-1-foundation`,
> commit `2b13d59`) — not inferred from the directive or from memory of
> past sessions. Where something could not be confirmed, it's marked
> **Unknown** rather than guessed.

## 1. Architecture

- **Backend**: Node.js + Express, `server/src/app.js` mounts one router
  file per feature under `server/src/routes/`.
- **Database**: PostgreSQL, accessed via Prisma (`server/prisma/schema.prisma`,
  client at `server/src/lib/db.js`). **Schema changes ship via
  `prisma db push`, not versioned `prisma migrate` files** — confirmed in
  `.github/workflows/ci.yml` and the Render start command. There is no
  migration-file rollback tool; the only real rollback path is reverting
  the commit and re-running `db push`, which is safe only for additive
  changes. This governs every schema decision in this suite: **additive
  only** (new tables, new nullable columns — never a drop/rename in the
  same change that something else depends on).
- **Frontend**: React + Vite (`client/`), client-side routing via
  `react-router`, no server-side rendering.
- **Auth**: cookie-based sessions (`evenflow_session=<rawToken>`),
  `server/src/lib/auth.js` (`createSession`, hashed tokens), middleware
  in `server/src/middleware/auth.js`.
- **Package manager**: npm, separate lockfiles for `server/` and `client/`.
- **Testing**: Node's built-in `node:test` + `node:assert/strict` — no
  Jest/Mocha. Real Postgres, real HTTP server, no mocking of Prisma or
  the HTTP layer (see §7).
- **CI/CD**: GitHub Actions, `.github/workflows/ci.yml` — a real
  `postgres:16` service container, `npm ci` → `prisma db push` →
  `npm test` → non-blocking `npm audit`, mirrored for the client build.
- **Hosting**: Render (confirmed from prior session work on
  `render.yaml`/deployment; not re-verified this pass).

## 2. Core identity/tenant model

`server/prisma/schema.prisma`:

- `Role` enum: `PLATFORM_OWNER | AGENCY_OWNER | AGENCY_MANAGER | PRODUCER
  | TELEMARKETER | SUPPORT_ADMIN | READ_ONLY`. The last two exist in the
  enum but **no `requireRole(...)` call anywhere in the app references
  them today** — confirmed unused, not reserved for HR (per the user).
- `User`: `id, email (unique), passwordHash?, firstName, lastName,
  phone?, role, status (INVITED|ACTIVE|DEACTIVATED), agencyId?,
  officeId?, presenceStatus, mfa* fields, ...`. **No `managerId`,
  `departmentId`, or `positionId` field exists anywhere on `User`.**
- `Agency`: tenant root. Feature-gating is done via boolean flags
  (`crmEnabled`, `coachingEnabled`, `breakRoomEnabled`, `salesStudioGateEnabled`,
  etc.) — the established pattern this suite's own `coachingEnabled`-style
  gate (if any is added) should follow.
- `Office`: a physical branch/location (`agencyId`, `name`,
  `routingCities[]`, `routingZipRanges`, `routingMode`). `User.officeId`
  links here. **Reused directly as the HR "work location" concept** — no
  new Location table.
- No permission-grant table exists anywhere in the schema. Every route
  hardcodes its allowed-role list via `requireRole('AGENCY_OWNER',
  'AGENCY_MANAGER')`-style calls.

## 3. Auth/permission middleware (`server/src/middleware/auth.js`)

- `requireAuth` — 401 if no session.
- `requireRole(...roles)` — 403 if `req.user.role` isn't in the list.
  Confirmed hardcoded enum-list per route, not a flexible grant table.
- `scopeAgencyId(req)` — `PLATFORM_OWNER` may target any agency (or all,
  if omitted); every other role is hard-locked to their own `agencyId`.
- `ROLE_RANK`: `{PLATFORM_OWNER:3, AGENCY_OWNER:2, AGENCY_MANAGER:1,
  PRODUCER:0, TELEMARKETER:0}`.
- `canActOnUser(actorRole, targetRole)` — `PLATFORM_OWNER` always true;
  else strictly `ROLE_RANK[actor] > ROLE_RANK[target]`.
- `isLastActiveOwner` lives in `server/src/routes/users.js:525`, not
  `auth.js` — blocks deactivating an agency's last active owner.

**HR implication**: a new `HrRoleGrant` table (additive) layers HR
authority (`HR_ADMIN`, `HR_AUDITOR`) on top of a user's existing `Role`
without touching any of the above — see the Phase 1 plan.

## 4. Existing time clock (`TimeClockEntry`)

Schema (`schema.prisma:1240-1258`): one event-log row per shift —
`id, userId, agencyId, clockInAt, clockOutAt?, lunchStartAt?, lunchEndAt?,
breakStartAt?, breakEndAt?, createdAt`. **No enum for state** — "one open
entry per user" is enforced in the route layer, not the database (the
schema's own comment says so explicitly).

`server/src/lib/timeClockState.js`: `openEntryWhere(userId)` →
`{userId, clockOutAt: null}`; `stateOf(entry)` → `CLOCKED_OUT | ON_LUNCH
| ON_BREAK | CLOCKED_IN`. **The single shared source of truth**, used by
both `timeClock.js` and `breakRoom.js`.

`server/src/routes/timeClock.js` (all `requireAuth`, clock actions
`requireRole('PRODUCER','TELEMARKETER')`):
- `GET /me` — caller's own open entry + derived state.
- `POST /clock-in` — 409 if already clocked in; Telemarketers must supply
  an `agencyId` matching an `ACTIVE` `TelemarketerAssignment`; sets
  `User.presenceStatus = 'GRINDING'`.
- `POST /clock-out` — 409 if not clocked in or if lunch/break still open.
- `POST /lunch-start` / `/lunch-end`, `POST /break-start` / `/break-end`
  — one lunch and one break per shift each (`*_ALREADY_USED` otherwise).
- `POST /presence` — manual override into
  `AWAY|BREAK|LUNCH|MEETING|GRINDING|COACHING`, always allowed.
- `GET /status` — team roster (every ACTIVE producer + ACTIVE-assignment
  telemarketer in the agency, with `presenceStatus`/`since`), open to any
  authenticated agency member, polled every 15s by `TeamClockStatusBox.jsx`.
- `GET /report` (`requireRole('AGENCY_OWNER','AGENCY_MANAGER')`) —
  closed-shift hours report for a date range.

Client: `TimeClockWidget.jsx` (persistent top bar), `TeamClockStatusBox.jsx`
(Main Stage team status), `TimeClockReportPanel.jsx` (hours report under
Roster Settings).

**Non-negotiable for this suite**: none of the files above are modified.
HR's Time & Attendance module (Phase 1 Part B) is a read-only consumer.

## 5. Break Room gating (`server/src/lib/breakRoom.js`)

Not a separate concept — `canAccessBreakRoom(user)` reads the exact same
`stateOf()` helper as the time clock:

```js
const eligible = state === 'ON_BREAK' || (state === 'ON_LUNCH' && settings.lunchEligible);
```

Role must be `PRODUCER`/`TELEMARKETER`; `Agency.breakRoomEnabled` must be
true; `lunchEligible` defaults to `false`. Used by every Break Room route
(`server/src/routes/breakRoom.js`) with no duplicate inline checks.
**Not modified by this suite.**

## 6. Lead-routing "availability" — confirmed gap, intentionally untouched

`leadDistribution.js`, `vendorApi.js`, and the Moshpit/claim logic in
`leads.js` filter candidates purely by `role` + `User.status === 'ACTIVE'`.
**None of them check clock/presence state.** A producer on lunch, on
break, or fully clocked out can still receive or claim a lead today. This
is a real, confirmed gap — not something this phase fixes (per the
directive's own instruction that HR schedule/leave data "may inform
availability... but must not override active routing behavior without a
defined integration contract" — that contract is future work, not
Phase 1).

## 7. Audit logging (`server/src/lib/audit.js`)

```js
recordAudit({actorId, actorRole, agencyId, action, entityType, entityId, before, after, metadata, correlationId})
```
→ `AuditEvent` row. `actorId` is nullable. No retention/purge job exists
anywhere — rows are kept indefinitely today. **Reused directly for HR**
(action strings prefixed `hr.*`) — no parallel `hr_audit_events` table.

## 8. Notifications (`server/src/lib/notifications.js`)

`notifyUser`/`notifyUsers`/`notifyAgencyOwners`, backed by `Notification`
+ `NotificationPreference.mutedTypes`. **Reused directly** for HR
notifications (new `type` strings) — no new pipeline.

## 9. Navigation/routing architecture

`client/src/layout/navConfig.js` — `NAV_BY_ROLE` maps each role to an
ordered nav-item array (`AGENCY_MANAGER` reuses `AGENCY_OWNER`'s array
with `excludeRoles` per item). `Sidebar.jsx`/`MobileDrawer.jsx` render
via `mainNavForRole`/`secondaryNavForRole`; a `stub: true` item opens a
`ComingSoonModal` instead of navigating (the mechanism previously used
for Record Store before it was built). `App.jsx` wraps each role's routes
in `<RoleGate allow={[...]}>` with flat child `<Route>` entries.

**Backstage HR** is added exactly this way: nav entries per role, routes
inside each role's existing `RoleGate` block, new page components, a new
`server/src/routes/hr/*.js` set mounted in `app.js`.

## 10. Effective-dated history precedent

`TelemarketerAssignment` (`effectiveFrom`, `effectiveTo?`, `status:
ACTIVE|ENDED`) — "history is never destroyed when reassigned" per its
own schema comment. This exact shape is copied for
`HrEmploymentHistoryEvent`. `FlowScoreSnapshot` is the precedent for
immutable point-in-time snapshots (not needed in Phase 1).

## 11. Training/coaching (reusable for later HR Training phase)

`TrainingCourse`/`TrainingLesson`/`TrainingAssignment`/`LessonCompletion`
already implement "assign a course to a user, track per-lesson
completion, roll up to course completion" — a real, working model. A
future HR "Training & Certifications" module assigns HR compliance
courses through this exact schema, not a parallel LMS. Gap: no
certificate/license expiration-date field exists yet.

## 12. ED-AI (`server/src/lib/aiProvider.js`)

`isConfigured()` → `ANTHROPIC_API_KEY` presence; `callMessages()` is a
plain `fetch` to `api.anthropic.com/v1/messages` (no SDK); `callEd()`/
`callMultiTurn()` wrap it. **The one integration point** — any future
HR-AI assistant work calls through this, with its own `edContext.js`-style
`buildHrContext()`, never a second AI integration.

## 13. Document storage (`server/src/lib/storage.js`)

`save`/`read`/`remove` + `isObjectStorageConfigured()` (fails loudly, never
silently falls back to local disk, if object-storage env vars are set
without a real adapter). Local disk by default, explicitly non-durable on
Render. Reused directly for a future HR document vault.

## 14. Money convention

Every amount in this schema is `*Cents Int` + a sibling `currency String`
(confirmed: `stripe.js`, `Sale`, `RevenueEvent`, `CostEvent`). No float
money anywhere. Future HR compensation tables follow this identically.

## 15. "Not yet configured" integration pattern

```js
// server/src/lib/stripe.js
function isConfigured() { return !!process.env.STRIPE_SECRET_KEY; }
```
Same shape in `bunnyStream.js`, `email.js`. Every external integration
gates on a plain boolean and returns an honest `NOT_CONFIGURED`/
`available:false` rather than fabricating success. Future payroll and
e-signature adapters follow this identically — and until real credentials
exist, that's all they do.

## 16. Test convention (confirmed from `auth.test.js`, `calls.test.js`)

`process.env.NODE_ENV = 'development'` → real `Agency`/`User` rows via
direct `prisma.*.create` → `http.createServer(app).listen(0, ...)` →
`createSession(userId)` → `evenflow_session=<token>` cookie → real
`fetch()` calls against the real server → real `FormData`/`Blob` for
uploads → external APIs mocked via `t.mock.method(global, 'fetch', ...)`
scoped to only intercept the named external URL → explicit FK-safe
cleanup in `after()`. Every new HR test file follows this exactly.

## 17. Reusable components / conflicting models

- **Reusable**: `recordAudit`/`AuditEvent`, `notifyUser`/`Notification`,
  `Office` (location), `TrainingAssignment` (future training),
  `storage.js` (future documents), `aiProvider.js` (future HR-AI),
  `TelemarketerAssignment`'s effective-dating shape.
- **No conflicting/duplicate models found** — nothing in the existing
  schema represents department/position/manager/leave/schedule today, so
  Phase 1's new tables are purely additive with zero naming collisions.

## 18. Technical risks

- **No migration rollback tooling** (see §1) — mitigated by additive-only
  schema discipline.
- **Local-disk storage is non-durable on Render** — not a new risk
  introduced by this suite, but relevant once a Phase-5 document vault is
  built; flagged for that phase, not solved here.
- **Lead-routing availability gap** (§6) — pre-existing, documented, not
  fixed by this phase; a future integration contract is needed before HR
  schedule/leave data should ever influence routing.

## 19. Unknowns requiring future verification

- Exact Render deployment/start-command details were not re-verified this
  pass (carried over from earlier session work, not re-confirmed against
  current `render.yaml`).
- No payroll provider, e-signature provider, or benefits carrier
  credentials exist in this environment — confirmed absent, not a gap in
  this audit so much as a hard blocker for the Payroll/Lifecycle/Benefits
  roadmap phases.
