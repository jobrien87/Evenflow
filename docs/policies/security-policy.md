# Security Policy

> **Owner: unassigned.** This policy needs a real, named, accountable
> human owner inside the company before it can be treated as adopted —
> a document in this repo is a draft, not a control. Until an owner signs
> off, treat every "must"/"required" below as a recommendation, not an
> enforced rule. This is one of the six policy documents flagged in the
> SOC 2 readiness assessment as a governance gap bigger than any single
> code issue.
>
> **Last reviewed:** drafted 2026-10-08, not yet reviewed by a human owner.

## 1. Purpose and scope

This policy describes how Evenflow protects the data it holds on behalf
of its agency customers and their end consumers — insurance leads,
customers, call recordings, and the financial/operational data generated
by using the platform. It applies to the Evenflow application (this
repository), the infrastructure it runs on (Render), and every person
with administrative or code-level access to either.

## 2. Authentication

- Passwords are hashed with bcrypt (cost factor 12), never stored or
  logged in plaintext (`server/src/lib/auth.js`).
- Sessions are 256-bit random tokens, stored server-side only as a
  SHA-256 hash, with a 14-day expiry and explicit revocation on logout
  or password reset (`Session` model, `revokeSession`/
  `revokeAllSessionsForUser`).
- Password-reset and invitation tokens follow the same pattern: 256-bit/
  192-bit random tokens, hashed at rest, single-use, short-lived (1 hour
  for a reset, 7 days for an invitation).
- TOTP multi-factor authentication is available to every account and
  **required** for Platform Owner and Agency Owner accounts (the
  highest-privilege roles) once this policy is adopted — enrollment is
  self-service at `/security` (`server/src/routes/auth.js`'s
  `/auth/mfa/*` routes). A stolen password alone is not sufficient to
  reach a protected account's data.
- Login attempts are rate-limited (20 per 15 minutes per IP) and every
  failed attempt — wrong password, unknown email, inactive account, or
  a wrong MFA code — is recorded as a real `AuditEvent`
  (`action: 'auth.login_failed'`), giving a real forensic trail for
  spotting credential-stuffing or brute-force activity after the fact.

## 3. Authorization

- Role-based access control across 5 roles (Platform Owner, Agency
  Owner, Agency Manager, Producer, Telemarketer), enforced server-side
  on every route — never only in the client UI. See `server/PERMISSIONS.md`
  for the generated, current access-control matrix.
- Every multi-tenant query is scoped to the caller's own agency (or, for
  a Telemarketer working across agencies, to their own
  `TelemarketerAssignment` rows) via the shared `scopeAgencyId()`
  helper or an equivalent explicit ownership check.
- Impersonation (a Platform Owner viewing the app as another user, for
  support) is itself audit-logged and restricted to the Platform Owner
  role.

## 4. Data protection and encryption

- The production database connection enforces TLS (`sslmode=require`,
  `server/src/lib/db.js`) as defense in depth beyond the provider's own
  default.
- Vendor API credentials (the per-vendor lead-ingestion key) are stored
  as SHA-256 hashes only, never recoverable in plaintext once issued.
- Call-transcript text sent to a third-party AI provider (Anthropic) for
  call-coaching analysis is redacted of obvious structured PII (SSNs,
  card numbers, phone numbers, email addresses) before the request is
  made (`server/src/lib/transcriptRedaction.js`).
- Uploaded call recordings currently live on Render's local disk, which
  is **not durable across deploys/restarts** — this is a known,
  documented gap (see the Vendor Management policy's note on object
  storage) and should be moved to real encrypted object storage before
  recordings are treated as a reliable long-term record.

## 5. Audit logging and monitoring

- Nearly every sensitive state change (login, role changes, data
  deletion/purge, factory reset, MFA enable/disable, impersonation) is
  recorded in the `AuditEvent` table with actor, role, agency, a
  before/after diff where relevant, and a `correlationId` that also
  appears in the corresponding server error log line.
- `AuditEvent.actorId` is deliberately nullable so that deleting an
  account (via the Purge Deactivated User flow) never erases the
  historical record of what that account did.
- There is currently no external error-tracking (e.g. Sentry) or
  uptime-monitoring service wired in — flagged as a Tier 1 gap in the
  SOC 2 assessment, not yet closed because it requires a third-party
  account the company must set up itself.

## 6. Vulnerability and dependency management

- GitHub Actions runs the full automated test suite and a non-blocking
  `npm audit` on every push (`.github/workflows/ci.yml`).
- Dependabot is configured for weekly dependency updates across both
  `server/` and `client/`, plus GitHub Actions itself
  (`.github/dependabot.yml`).
- A `CODEOWNERS` file names a default reviewer so that, once GitHub
  branch protection requires a review, there is a real person to assign
  it to.

## 7. Incident response

See `docs/policies/incident-response-plan.md` for what happens when a
security incident is suspected or confirmed.

## 8. Policy review

This policy should be reviewed at least annually, and whenever a
material change is made to authentication, authorization, or data
storage. Until a human owner is assigned (see the top of this document),
no review cadence is actually in force.
