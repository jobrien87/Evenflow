# Access Control Policy

> **Owner: unassigned.** This policy needs a real, named, accountable
> human owner before the review cadence and approval steps below can be
> treated as actually happening rather than aspirational. This is one
> of the six policy documents flagged in the SOC 2 readiness assessment
> as a governance gap.
>
> **Last reviewed:** drafted 2026-10-08, not yet reviewed by a human
> owner.

## 1. Purpose

This policy governs who gets access to what inside Evenflow — both
within the application itself (agency staff using the product) and to
the underlying infrastructure and code (engineering/admin access).

## 2. Principle

Access is granted on a least-privilege basis: an account gets the
narrowest role that lets it do its actual job, and that access is
revoked promptly when it's no longer needed (a role change, an
employee's departure, an agency's offboarding).

## 3. Application roles

Evenflow has five real roles, enforced server-side on every route (see
`server/PERMISSIONS.md` for the generated, current matrix):

- **Platform Owner** — Evenflow's own staff; full cross-agency access,
  including impersonation (itself audit-logged) and the ability to
  wipe an agency's data (Factory Reset). **MFA required.**
- **Agency Owner** — full control of their own agency: roster, billing,
  settings, financial reporting. **MFA required.**
- **Agency Manager** — most of an Agency Owner's day-to-day
  capabilities within their own agency, with a few owner-only actions
  (e.g. cannot act on another Manager or the Owner — see
  `canActOnUser`'s seniority rule).
- **Producer** — sees and works their own assigned leads; cannot see
  another producer's leads or the agency's financials.
- **Telemarketer** — cross-agency by design (via `TelemarketerAssignment`
  rows, not a fixed `agencyId`); submits leads into whichever agency
  they're actively assigned to.

## 4. Provisioning (granting access)

- A new user is always **invited**, never created with a standing
  password — the invitation flow (`POST /users` → a hashed, single-use,
  7-day invitation token emailed via Brevo) is the only path to a real
  account.
- A Platform Owner can invite an Agency Owner for a new agency. An
  Agency Owner/Manager can invite Producers/Managers into their own
  agency. A Telemarketer is invited by a Platform Owner and then
  assigned to one or more agencies.
- Every invitation and role assignment is audit-logged.

## 5. Deprovisioning (revoking access)

- **Deactivation** (`status: DEACTIVATED`) is the normal first step —
  it revokes every active session immediately and blocks login, while
  preserving the account's historical data (leads worked, notes,
  calls). This is reversible (an admin can reactivate, or resend an
  invitation to let the person set a new password).
- **Purge** (`DELETE /users/:userId`, only reachable after
  deactivation) permanently removes the account. It is blocked if the
  account has real recorded history another party depends on (notes,
  logged activities, uploaded calls) — the purge preview shows exactly
  what's blocking it before anything irreversible happens. Optional
  references (e.g. `AuditEvent.actorId`) are nulled, not deleted,
  preserving the historical trail.
- The **last active Agency Owner** of an agency cannot be deactivated
  or purged — every agency must always have at least one active owner
  (`isLastActiveOwner` check).

## 6. Authentication requirements

- Minimum 10-character password (enforced at account-activation/reset
  time).
- TOTP multi-factor authentication is available to every role and
  **required** for Platform Owner and Agency Owner accounts once this
  policy is adopted. Self-service enrollment is at `/security`.
- A forgotten password is recovered via a self-service, rate-limited,
  single-use reset link — never by an admin reading or resetting a
  password directly (there is no way to do that; only a hash is ever
  stored).

## 7. Access review

Once a human owner is assigned, review the active roster for each
agency (and the Platform Owner roster) at least quarterly: confirm
every active account still needs its current role, and that no
deactivated account was missed for purge once its blocking history (if
any) is no longer a concern. There is no automated review reminder
today — this is a manual process until one exists.

## 8. Infrastructure and code access

Access to the Render dashboard (environment variables, database
credentials, deploy triggers) and to this GitHub repository should be
limited to the people who actually need it, and reviewed on the same
cadence as application access above. `CODEOWNERS` names a default
reviewer for code changes; as the team grows, branch protection should
require that review before merge (a GitHub settings change, not a code
change — see the SOC 2 assessment's Tier 2 items).
