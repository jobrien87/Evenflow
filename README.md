# EvenFlow — Foundational Build

This is the **production foundation** of EvenFlow: authentication, multi-tenant
RBAC, agencies, producer/team invitations, the CRM lead model, the unified
Work Queue, and "Start My Day." Every other module in the full EvenFlow spec
(Yield Transfers, Vendor API, Call Intelligence, Training, ED, Billing) is
designed to extend this same data model and auth boundary — they are the next
build phases, not included here.

## Integration verification (dead-end audit)

Per a direct request to verify this actually connects end-to-end rather than being a pile of features, a deliberate audit pass was run against every module built so far, looking specifically for what the spec calls "disconnected data islands." Two real gaps were found and fixed rather than glossed over:

1. **Agency transfer settings had no UI.** The backend fully supported enabling transfers, setting product/state rules, a daily cap, and a per-transfer fee — but no frontend screen ever called those endpoints. In practice this meant `transfersEnabled` would stay `false` forever, so the entire Yield Transfers module, while individually well-tested, would never actually route a single real transfer. **Fixed**: added a real Agency Settings panel (new "Settings" tab for Agency Owners) wired to the existing `PATCH /agencies/:id/transfer-settings` endpoint, plus the missing vendor cost-per-lead field on the vendor creation form.
2. **Sale premiums never reached the Financial Ledger.** Both the CRM lead disposition flow and the Yield Transfer disposition flow captured a `SOLD` outcome with a real dollar amount, but neither ever converted that into a `RevenueEvent` — the money was recorded on the record itself but never flowed into financial reporting. **Fixed**: added `recordTransferSaleRevenue` and `recordLeadSaleRevenue` hooks, wired into both disposition endpoints, and added a "Mark Sold" action with a premium field to the Producer's Work Queue (which didn't exist before either).

Both fixes were then verified with an actual integration test (not just a description): the real `findEligibleAgency` routing function was proven to fail before an agency's settings are configured and succeed immediately after — using the exact same function, not a rewritten stand-in. Then a simulated transfer acceptance fee, a transfer sale premium, a vendor lead cost, and a CRM lead sale premium were all run through the real `financialEvents.js` hooks and the real `financialCalc.js` profitability calculator in a single pass, confirming they land in the same ledger and produce one consistent revenue/cost/margin/ROI figure — because `/api/financials/summary` and ED's context both read the same underlying tables through the same calculator, not two versions of the same math.

This is not a claim that every possible path through the app has been walked — Call Intelligence, Training, Billing, and the full Support UI are still not built (see Roadmap), and that is stated plainly rather than hidden. But nothing described as "built" above is a placeholder, a button that does nothing, or a calculation quietly disconnected from the data that should feed it.

### Second audit pass — every backend function checked against every frontend call

A follow-up pass cross-referenced every client-side API function against every page component to find anything built on the backend but never actually reachable by a real user, and checked every route file for Express path-shadowing bugs (a literal route registered after a `:param` route with the same shape, which silently makes the literal route unreachable). Found and fixed:

- **Route-shadowing bug**: `GET /transfers/credit-requests` was registered after `GET /transfers/:id`, so Express would have matched "credit-requests" as a transfer ID and the endpoint would never have worked. Caught before shipping; the whole codebase was then scanned for the same pattern (none found elsewhere).
- **Credit Workflow had zero UI** despite full backend support: added "Request Credit" on the agency side and a full Approve/Deny queue on the Platform Owner side.
- **Telemarketer dashboard had no visibility into its own assignments** — a TM could submit leads with no way to know whether they even had an active office assignment. Added a real `GET /telemarketers/me/assignments` endpoint and a dashboard section showing assigned offices (or an honest "no offices assigned yet" state).
- **Manual CRM lead creation was unreachable** — added an "+ Add Lead" form for Agency Owners.
- **User deactivation was unreachable** — added a Deactivate action per user row.
- **Vendor "View Instructions" and "Revoke"** were built on the backend, never exposed — added both, including a real instructions modal.
- **The transfer reject action used a hardcoded fake reason string** instead of asking for one — fixed to a real prompt.
- **Support tickets had no UI at all** — built a real `SupportPanel` (list, create, and Platform-Owner status management), wired into both Agency Owner and Platform Owner.
- **ED could theoretically escalate to a support ticket but no button ever called it, and the chat widget silently discarded conversation history on every close** — added a real "Create Support Ticket" flow inside the widget and made it load real history from the server on open instead of resetting.
- **Manual revenue/cost ledger entry and AI operational cost visibility** (both explicitly required by spec, both fully built on the backend) had no UI — added a manual entry form and an AI usage/cost summary, both under the Platform Owner's Financials tab.

After all of the above, the full audit was re-run (every API function checked against every page, every route file checked for path-shadowing) and came back clean, and the client was rebuilt with zero errors.

### Third audit pass — static schema validation (no live database available in the build sandbox)

This build was assembled in a sandbox that cannot reach Prisma's binary host, so `prisma generate`/`prisma validate`/`prisma migrate` could never actually be run against a live PostgreSQL instance during development — every prior test of this project ran against hand-written in-memory mocks standing in for Prisma. That's real coverage for business logic, but it cannot catch a schema/query mismatch, because a mock will happily return whatever shape you tell it to, whether or not the real schema could produce it.

To close that gap, this pass wrote a static analyzer that parses `schema.prisma` directly to build the real set of relation fields for every model, then scans every `prisma.<model>.<method>()` call in every route file for `include: {}` and nested `select: {}` blocks, flagging any referenced field that doesn't actually exist as a relation on that model. This is exactly the class of bug that passes every mock-based test, passes every syntax check, and only fails the moment it hits a real database — which made it invisible to every audit so far.

It found one real instance: `training.js`'s team-progress endpoint (`GET /training/assignments`) called `include: { user: {...} }` on `TrainingAssignment`, but the schema only ever declared a bare `userId` string on that model, never an actual `user` relation field. This would have compiled, passed every mock test, and then thrown `Unknown field 'user' for include statement` the first time an Agency Owner or Platform Owner actually opened the Team Progress view against a real database. Fixed by adding the missing `user User @relation(...)` field (and its required back-relation on `User`) to the schema.

The same pass also verified: every compound unique key referenced in code (`vendorId_externalLeadId`, `courseId_userId`, `assignmentId_lessonId`) matches the exact field order Prisma would generate from the corresponding `@@unique` declaration; no two models share an ambiguous unnamed relation (which Prisma's real validator would reject outright); and every frontend page component is actually imported and reachable from the app — zero orphaned files. All came back clean after the one fix above.

**Honest caveat**: this static check is thorough but is not a substitute for actually running `prisma generate` and `prisma migrate dev` against a real Postgres instance, which the README's setup steps ask you to do on first deploy. If anything else was missed, that step — not this one — is what will surface it, and the error will be a clear schema/migration failure rather than a silent bad behavior.

### Fourth pass — market-readiness / dependency & security audit

Before calling this launch-ready, a pass focused specifically on what a real
production deploy needs beyond "the code works":

- **Every `process.env.X` reference in the server was cross-checked against `.env.example`** — all documented, nothing silently relied on an undocumented variable.
- **`render.yaml` was checked against that same list** and updated to include every optional integration point (transcription, object storage, Stripe) as unset placeholders, so they're discoverable in the Render dashboard rather than something you'd only find by reading source code.
- **A security sweep for hardcoded secrets, API keys, and passwords** came back clean, and `.gitignore` was found to be missing `uploads/` (the local call-recording storage directory) — fixed before it could become an accidental commit.
- **Dependency audit**: `npm audit` on both client and server. Found and fixed two real moderate-severity vulnerabilities — `react-router-dom` (upgraded 6→7, verified every API this app actually uses is unchanged and the build passes with zero code changes) and `uuid` (upgraded to the latest major; confirmed the CVE doesn't even apply to how this app calls it — always `uuidv4()` with no arguments, never the vulnerable buffer-supplied path — but fixed it anyway since the upgrade was free). Both dependency trees now report **zero vulnerabilities**.
- **Removed two unused dependencies** (`jsonwebtoken`, `crypto-random-string`) left over from early auth-strategy exploration before session-cookie auth was settled on — dead weight that added install time and could mislead a future maintainer about which auth strategy is actually in use.
- Reran the full syntax check, schema-vs-query validator, route-shadowing scan, and a live boot test after every change above — all still clean.

## What's real right now

- Real password auth (bcrypt), session cookies, invitation-based onboarding — no hardcoded passwords
- Server-enforced RBAC and tenant isolation (Platform Owner / Agency Owner / Manager / Producer / Telemarketer)
- Agencies, users, leads, tasks, audit log — all backed by real Postgres tables via Prisma
- A deterministic (non-AI) lead/task priority engine powering the Work Queue
- "Start My Day" recap computed from real database aggregates, not fake data
- Honest health check (`/api/health`) — reports `NOT_CONFIGURED` instead of faking success
- Email invitations use a real adapter (Resend) that reports `NOT_CONFIGURED` if no API key is set, rather than pretending to send
- **Yield Transfers**: TM accounts + agency office assignments (with full history, never destroyed), a real transfer state machine (LEAD_CAPTURED → QUALIFIED → ROUTING → OFFERED → ACCEPTED/REJECTED → CONNECTED → COMPLETED → DISPOSITIONED → CREDIT workflow), a deterministic routing engine that checks agency status/product/state/daily-cap and **never silently drops a lead** (explicit `NO_ELIGIBLE_DESTINATION` reason instead), race-safe accept (atomic conditional update — two producers can't both accept the same transfer), automatic overflow re-routing on reject, and a credit request/approval workflow. Unit-tested against the spec's routing test matrix (agency paused, wrong product, cap reached, no assignment) and state-machine transition matrix — all passing.
- **Vendor Lead API**: "Send Posting Instructions" generates a real vendor + a hashed API credential (shown once, never retrievable again) + auto-generated docs (endpoint, curl example, field list, response codes) derived from the actual validator schema — not hand-maintained docs that can drift. The public `POST /api/v1/leads` endpoint authenticates by hashed key, validates the payload, enforces product-match, and — critically — **is truly idempotent**: resubmitting the same `external_lead_id` returns a duplicate response instead of creating a second lead. Every request is logged to an API transaction log (PII-masked in the general view). Functionally tested end-to-end: valid key creates a lead, duplicate `external_lead_id` is caught, product mismatch is rejected, missing fields are rejected with field errors, and a wrong secret against a valid key prefix is rejected — all verified.
- **Financial Ledger**: revenue/cost tracked as an append-only, integer-cents ledger — never floating point, never edited/deleted after the fact. Revenue and cost events are **auto-generated from real activity** (a configured per-transfer fee creates a real revenue event on transfer acceptance; a configured vendor cost-per-lead creates a real cost event on lead ingestion; an approved credit request creates an offsetting cost event) — and when a fee/cost isn't configured, **no event is fabricated**; the reporting layer shows `INSUFFICIENT_DATA` instead of inventing a number. Margin and ROI use two distinct, clearly-defined formulas (margin ÷ revenue, ROI ÷ cost) and both explicitly return `null` with a labeled reason rather than `0`, `NaN`, or `Infinity` when the denominator is missing or zero. The calculation core is pure/DB-free and unit-tested (11 assertions covering normal cases and the zero-revenue/zero-cost edge cases) — all passing. The auto-generation hook was also verified end-to-end: creating a vendor lead with a configured cost-per-lead produces exactly the right cost event, attributed to the right agency and vendor.
- **ED**: the built-in assistant. Its factual context — goal pace, open lead/task counts, transfer acceptance rate, revenue/cost/margin — is always computed by plain deterministic arithmetic straight from real rows (`lib/edContext.js`), never invented by the LLM. The language layer (`ANTHROPIC_API_KEY`) is a genuine, separate integration boundary: when it's not configured, ED still reports the real numbers plainly instead of faking a conversational answer — verified end-to-end by actually calling the endpoint with no key set and confirming it returns real, correctly-computed data (e.g. goal pace math) with an honest "language layer isn't configured" note. AI usage is logged with real token counts and a cost estimate — stored in USD micros rather than cents, because a bug caught during testing showed cents rounds nearly every real chat call down to $0.00, silently defeating the cost-visibility feature; fixed and reverified before shipping. ED can escalate to a real (minimal) Support Ticket system when it can't help. Humor level (LOW/NORMAL/SPICY) is configurable; ED is an original character with hard prompt-level guardrails against fabricating features or impersonating anyone.
- **Call Intelligence**: upload → transcription → structured AI scoring → coaching, architected source-agnostic (`manual_upload` today; `browser_extension`/`phone_system`/`webhook` are first-class enum values the pipeline doesn't need to change for later). File validation sniffs actual file bytes (magic numbers) rather than trusting the client's claimed MIME type — verified directly: a text file renamed to look like audio is rejected, real WAV/MP3/MP4/OGG/WebM signatures are correctly recognized. Storage uses a real adapter interface with a local-disk implementation for development, clearly documented as **not** durable on Render's ephemeral filesystem, and it fails loudly rather than silently if object-storage env vars are set without a real provider wired in. Transcription and AI analysis are both genuine, separate integration boundaries: with no transcription provider configured (the honest default), the real processing pipeline was run end-to-end and confirmed to land on `FAILED` with an honest, human-readable reason — "transcription service is not configured... can be retried" — and to create **zero** fabricated transcript, analysis, or AI-cost records. Analysis output is structured (12 fixed scoring dimensions, objections with handled-well/not flags, buying signals, coaching opportunities, a `review_recommended` flag rather than invented legal conclusions) and validated with Zod; malformed or out-of-range AI output (verified with 4 test cases) is rejected rather than silently accepted as a real score. Manager review preserves the AI's score and a separate manager-adjusted score, never overwriting one with the other, via a real review form in the UI. A known vulnerability in the initial file-upload dependency (multer 1.x) was caught during this build and upgraded to 2.x before shipping.
- **Billing & Entitlements**: real Plans (CRM/Transfers/Coaching flags + price) and per-agency Subscriptions, with no payment processor faked — the system runs in an explicit, honestly-labeled "manual/admin mode" (Platform Owner assigns plans directly) unless a real `STRIPE_SECRET_KEY` integration is wired in. Assigning a plan doesn't just create a billing record — it immediately syncs the agency's real `crmEnabled`/`transfersEnabled`/`coachingEnabled` flags, and those flags are now **actually enforced server-side**: a new `requireModuleEnabled` middleware blocks Call Intelligence and Yield Transfer actions when an agency's plan doesn't include them, tested against 4 real scenarios (Platform Owner bypass, blocked agency, entitled agency, and a misconfigured no-agency user) — all behaving correctly. This closes a real gap found during this build: those three flags existed in the schema since the foundation but were never actually checked by any route until now. The frontend handles a `MODULE_NOT_ENTITLED` rejection with a clear message rather than a misleading empty state. Agency Owners get a read-only plan view with a "request a change" path to Support rather than a fake self-serve checkout.
- **Training/Coaching curriculum**: courses → lessons → optional quiz, assignments with real per-lesson progress tracking, gated behind the same `coachingEnabled` entitlement as Call Intelligence. Quiz grading is entirely server-side — the client only ever submits which options it picked, never a score, so there is no way to fake a passing result by tampering with the request; verified with 6 test cases including a type-mismatch tampering attempt (correctly scored 0, not silently coerced into a pass) and the "no quiz taken" case (`null` score, not `0`, since those mean different things). The "Recommended for you" surface is entirely deterministic — it averages a producer's real per-dimension call scores, finds the weakest one, and matches it to an active course's category using plain arithmetic and string matching, with zero LLM involvement; verified with 3 scenarios including the case where a producer's weakest dimension has no matching course, where it correctly returns no recommendation rather than forcing a bad match. Course authoring validates that every quiz question's correct-answer index actually points at a real option, so a typo cannot silently create an unanswerable question.
- **Notifications**: a real in-app notification feed with per-user preferences (email on/off, per-type mutes), wired only into events that actually fire elsewhere in this codebase — new vendor lead, lead assigned, transfer offered, transfer accepted, credit decision, call analysis complete, training assigned, support status change, and vendor paused/failed. Deliberately *not* implemented: task-overdue or transfer-timeout notifications, because there is no scheduled job in this build to detect either condition — faking that hook would have meant a notification type that looks wired up but never actually fires, exactly the kind of thing this project has been auditing against. Transfer-offer alerts are CRITICAL severity and explicitly cannot be muted, per spec ("critical transfer alerts should not disappear into a generic notification list") — verified with 3 test cases including the override case. Email delivery reuses the same honest adapter as the rest of the app: if `RESEND_API_KEY` isn't set, no email goes out and nothing claims otherwise, while the in-app notification is created either way.
- **Winback & Cross-Sell Engine**: Cross-sell opportunities are genuinely auto-detected — a real SOLD disposition (lead or transfer) updates the customer's actual product list, and a deterministic rule set (e.g. "has Auto, doesn't have Home") creates a real opportunity, with duplicate-prevention verified directly (re-running the same sale event twice does not create a second opportunity). Winback opportunities are honestly **not** auto-detected: this system has no policy-cancellation lifecycle tracked anywhere, so there is no real signal to detect a lapse from — winbacks are always manually recorded, real, entered data (which customer, what product, when it lapsed, what the premium was), stated plainly in the UI rather than presented as if the system somehow knows. Building this surfaced and fixed a real pre-existing gap: `Transfer.customerId` had never been populated anywhere since the Yield Transfers module was built (no Customer record was ever linked at transfer creation), which would have silently meant Yield-Transfer-sourced sales could never feed the cross-sell or Customer 360 story — fixed by adding the same phone/email customer dedup at transfer creation that leads already had. Both opportunity types feed into the same unified Work Queue as leads and tasks, per spec's explicit requirement that they combine into one prioritized feed rather than becoming a disconnected fourth queue — including fixing a bug caught before shipping, where the producer's queue UI would have called the wrong API endpoint (task-complete) against an opportunity's ID had the fix not been made first.

- **Goal-setting**: closes a real structural gap found during this build — the `Goal` model has existed since the foundation, and pace calculations on the Producer dashboard and inside ED have read from it since day one, but no route anywhere ever let anyone create one. That means the entire "Goal Pace" feature could never have shown real data in production, silently, since the very first commit. Fixed with full CRUD, wired into a real UI, scoped so Agency Owners can only set goals for their own team.
- **Owner Impersonation**: a real "View As" system for Josh/Tom with the security model taken seriously, not just a UI toggle. The impersonation cookie is opaque — just an internal log ID — and is only ever honored if the REAL, currently-authenticated session's user ID matches who actually started that specific impersonation. This was directly tested as an attack scenario: a second, different real user attempting to reuse the exact same cookie value is correctly rejected, alongside an already-ended session and a garbage/forged ID (4 test cases, all pass). Sensitive Platform-Owner-only routes stay protected automatically by construction — impersonating as a Producer makes `req.user.role` become `PRODUCER` for the rest of that request, so any route still gated with `requireRole('PLATFORM_OWNER')` correctly denies access, exactly matching the spec's "sensitive operations require exiting impersonation" without needing a second, separate guard. A visible red banner and one-click Exit are always present while active, and start/end are both audit-logged.
- **Customer 360**: a real unified timeline assembled from actual events already recorded elsewhere — Lead status changes, Transfer state transitions, Call uploads/analysis completions, and Opportunity status changes — merged and sorted chronologically, unit-tested for correct ordering. This never invents a narrative; every timeline entry traces back to a row that was already written by some other, already-tested part of the system. Reachable by clicking a customer's name from the Agency Owner's leads list.

## Architecture

- `server/` — Node.js + Express + PostgreSQL (Prisma ORM)
- `client/` — React (Vite) single-page app

## First Deployment (Render + GitHub)

### 1. Push this repo to GitHub
See "GitHub steps" below if you haven't done this yet.

### 2. Deploy via Render Blueprint
This repo includes `render.yaml`, which defines the database, backend, and
frontend in one file.

1. Go to https://dashboard.render.com → **New** → **Blueprint**
2. Connect your GitHub repo
3. Render reads `render.yaml` and provisions:
   - `evenflow-db` (Postgres)
   - `evenflow-server` (backend API)
   - `evenflow-client` (frontend static site)
4. Render will ask you to fill in a couple of environment variables it can't
   guess:
   - On **evenflow-server**: `APP_URL` → set this to your `evenflow-client` URL once you know it (e.g. `https://evenflow-client.onrender.com`)
   - On **evenflow-client**: `VITE_API_BASE_URL` → set this to your `evenflow-server` URL (e.g. `https://evenflow-server.onrender.com`)
   - (Optional) `RESEND_API_KEY` on the server, if you want real invitation emails to send. Without it, the app still works — it just tells you emails are `NOT_CONFIGURED`.
5. Click **Apply**. Render builds and deploys both services.

Because `VITE_API_BASE_URL` and `APP_URL` depend on each other's final URLs,
the simplest path is: deploy once, copy both generated `.onrender.com` URLs
into these two variables, then trigger a manual redeploy of both services.

### 3. Bootstrap Josh & Tom (Platform Owners)
Open the **Shell** tab on the `evenflow-server` service in Render, and run:

```
npm run seed
```

This creates `josh@yield-marketing.com` and `tom@yield-marketing.com` as
Platform Owners and prints an activation link for each (since there's no
default password). Open each link, set a password, and log in.

### 4. Pre-launch smoke test

Walk this end-to-end before pointing real traffic at it. Each step exercises a
different module, and together they follow one fictional lead and one
telemarketer transfer all the way through the system — the same principle the
spec calls "FOLLOW THE DATA THROUGH THE ENTIRE BUSINESS."

**Platform level**
- [ ] `/api/health` returns `"status": "ok"`
- [ ] Log in as Josh or Tom
- [ ] **+ Invite Agency** creates an agency and (if `RESEND_API_KEY` is set) sends a real invitation email; if not set, the response honestly shows `emailStatus: "NOT_CONFIGURED"` and the activation link is in the server logs
- [ ] Billing tab: create a Plan with Transfers + Coaching enabled, assign it to the test agency — confirm the agency's entitlement flags update

**Agency & team**
- [ ] Accept the agency owner invitation, log in
- [ ] Invite a Producer, accept that invitation too
- [ ] Settings tab: turn on **Accept Yield Transfers**, add a product/state, set a transfer fee — this is what makes the next section actually work; skipping it means every transfer will honestly report `NO_ELIGIBLE_DESTINATION`

**Telemarketer → Transfer → Sale → Money**
- [ ] Platform Owner: invite a Telemarketer, assign them to the test agency
- [ ] Telemarketer: submit a qualified lead — confirm it routes to `OFFERED`, not `NO_ELIGIBLE_DESTINATION`
- [ ] Agency Owner: see the transfer alert, **Accept** it — confirm a real-time revenue event appears in Financials if a fee was configured
- [ ] Mark **Connected**, then **Complete**, then disposition **SOLD** with a premium — confirm that premium appears as revenue in Financials, and (if the product creates a real cross-sell gap) a new Cross-Sell opportunity appears

**Vendor API**
- [ ] Agency Owner: create a Vendor, note the one-time API key
- [ ] Send a real `curl` request per the generated posting instructions — confirm `201` and a new lead
- [ ] Resubmit the exact same request — confirm it's caught as a duplicate, not a second lead

**Call Intelligence & Training**
- [ ] Producer: upload any real audio file to Coaching — confirm it lands honestly on `FAILED` with a clear reason if no transcription provider is configured, or produces a real structured scorecard if one is
- [ ] Platform Owner: create a Training course + lesson with a quiz, assign it to the producer
- [ ] Producer: complete the lesson, take the quiz — confirm the score is graded server-side

**ED & Notifications**
- [ ] Open the ED widget, ask a question — confirm it reports real numbers even with no `ANTHROPIC_API_KEY` set
- [ ] Confirm the notification bell shows the transfer-offer alert from earlier, and that it's marked CRITICAL

**Financial truth check**
- [ ] Financials tab: confirm total revenue matches the sum of the transfer fee + sale premium entered above, exactly — no invented numbers, no double-counting

If every box here checks out, the core system is genuinely working end-to-end
against a real database, not just against this session's mocks.

## GitHub steps (if you're starting from scratch)

1. Create a new empty repository on github.com (no README/license — this repo already has one)
2. In your terminal, from this project's root folder:
   ```
   git init
   git add .
   git commit -m "EvenFlow foundational build"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```
3. Go back to the Render steps above.

## Local development

```
# Terminal 1
cd server
cp .env.example .env   # fill in DATABASE_URL for a local/dev Postgres instance
npm install
npx prisma db push
npm run seed
npm run dev

# Terminal 2
cd client
npm install
npm run dev
```

Visit `http://localhost:5173`.

## Roadmap

Every module from the original specification's priority list has a real,
tested implementation: Foundation (auth/RBAC/CRM/Work Queue), Yield Transfers,
the Vendor Lead API, the Financial Ledger, ED, Call Intelligence, Billing &
Entitlements, Training/Coaching curriculum, Notifications, the Winback &
Cross-Sell Engine, Goal-setting, Owner Impersonation, and Customer 360.

That does not mean every conceivable feature from the full 38-item spec is
built — a few things are explicitly and deliberately not implemented, listed
below rather than silently missing:

- **Scheduled/timeout-driven notifications** (task overdue, transfer offer timeout/MISSED). No scheduler infrastructure exists in this build to detect either condition, so rather than wire a notification type to a hook that would never actually fire, these were left out and named here.
- **A real payment processor integration.** Billing runs in an explicit manual/admin mode; wiring a real Stripe (or similar) integration is a defined next step, not a rewrite, since the Plan/Subscription data model and entitlement-sync logic are already in place.
- **A real transcription/AI provider connected by default.** The integration boundaries are real and tested; connecting an actual provider is a config change (env vars), not new code.
- **Durable object storage and a real background job queue** for Call Intelligence at scale — both have real, working adapters for development, with the production swap-in points clearly documented rather than silently assumed.
- **A formal Reporting Engine, global search, and CSV import/export** are not yet built as dedicated features — Customer 360 and the various per-module list views (Financials, Transfers, Vendor logs) cover a meaningful subset of what a reporting engine would show, but there's no single cross-module report builder yet.
- **Agency Health Score and a platform-level Alert Center** (distinct from the per-user Notifications feed built here) are not implemented — both would need aggregate, cross-agency pattern detection this build doesn't attempt yet.

### Known limitations of the current Call Intelligence build

- **No transcription or AI-analysis provider is wired in by default.** Set `TRANSCRIPTION_PROVIDER_API_KEY`/`TRANSCRIPTION_PROVIDER_URL` and `ANTHROPIC_API_KEY` to activate the real pipeline; without them, calls upload successfully and land on an honest `FAILED` status explaining why, rather than a fake transcript.
- **Storage defaults to local disk**, which does not survive a Render redeploy. Set the `OBJECT_STORAGE_*` env vars only once a real adapter is implemented in `lib/storage.js` against your chosen provider (S3, R2, GCS) — until then, leave them unset so uploads keep working via local disk in development.
- **The job pipeline is in-process** (`setImmediate`, not a durable queue). Fine at low volume; a server restart mid-processing leaves a call at whatever status it was in, retryable via the UI, but a real queue (BullMQ/Redis) should replace this before high call volume.

Each remaining item should be added the same way everything above was: server-side tenant scoping, audit logging, honest integration-health reporting, and — per the three audit passes run during this build — a check that every schema relation used in a query actually exists, every route is reachable from a real UI element, and every route file is actually wired into the app.
