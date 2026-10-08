# Data Classification Policy

> **Owner: unassigned.** This policy needs a real, named, accountable
> human owner before the handling rules below are more than a
> reference. This is one of the six policy documents flagged in the
> SOC 2 readiness assessment as a governance gap.
>
> **Last reviewed:** drafted 2026-10-08, not yet reviewed by a human
> owner.

## 1. Purpose

This policy defines the categories of data Evenflow stores and how each
category should be handled — who can see it, how long it's kept, and
what extra care it needs beyond the baseline access controls in
`docs/policies/access-control-policy.md`.

## 2. Categories

### 2.1 Consumer PII (highest sensitivity)

The personal data of the insurance leads/customers an agency works —
name, phone, email, address, date of birth, and (for Life/Health
products) health-adjacent conversation content captured in free-text
fields (`Lead.tmNotes`, `Lead.customFields`, `Call.transcript`).

- **Models**: `Customer`, `Lead` (most fields), `HistoricalRecord`,
  `Sale` (the customer-identifying fields), `Call.transcript`.
- **Handling**: agency-scoped by default — never visible across
  agencies except to a Platform Owner. `Customer.doNotContact`/
  `optOutAt` must be honored at every phone-number-keyed intake point
  (see `createLeadRecord`'s suppression check). Call-transcript text is
  redacted of structured PII (SSN/card/phone/email) before being sent
  to a third-party AI provider for analysis
  (`lib/transcriptRedaction.js`).
- **Retention**: no hard deletion today except via the per-Customer
  delete/export routes or an agency-wide Factory Reset — both are
  explicit, audited, irreversible actions, never automatic.

### 2.2 Authentication secrets

Passwords, session tokens, password-reset tokens, invitation tokens,
MFA secrets and backup codes, vendor API keys.

- **Handling**: never stored in recoverable plaintext. Passwords are
  bcrypt-hashed; every token is a random value hashed (SHA-256) at
  rest; an MFA secret is stored only long enough to be confirmed, then
  kept only as long as MFA stays enabled; backup codes are stored only
  as hashes, each one-time-use.
- **Never logged**: a raw token/secret must never appear in a server
  log line or be echoed back in an error response (see the Security
  Policy's note on this exact class of bug having already been found
  and fixed once — `lib/email.js` no longer logs a raw reset/invite
  URL).

### 2.3 Financial/operational data

Revenue and cost ledger entries, billing/subscription state, call
recordings, performance/coaching data (Flow Score, call analysis
scores).

- **Models**: `RevenueEvent`, `CostEvent`, `AgencySubscription`,
  `Call` (the audio file itself), `CallAnalysis`, `FlowScoreSnapshot`.
- **Handling**: agency-scoped; a producer sees their own performance
  data, an Agency Owner/Manager sees their whole agency's. Call
  recordings currently live on local disk (not durable across
  deploys) — see the Security Policy's note on this gap.
- **Retention**: kept indefinitely today; no automatic purge. A
  retention policy (e.g. 2–7 years, matching common insurance
  record-keeping norms) should be set once a human owner is assigned.

### 2.4 Audit/compliance data

`AuditEvent` rows — who did what, when, to what, with a before/after
diff for mutations.

- **Handling**: write-mostly; read access should be limited to
  Platform Owner/Agency Owner/Manager roles investigating an incident
  or reviewing activity, not a general-purpose feed.
- **Retention**: grows unbounded today — there is no purge policy.
  `AuditEvent.actorId` is deliberately nullable so that purging a user
  account never erases the audit trail itself.

### 2.5 Public/non-sensitive data

Product names, the training-drill library content, carrier/policy-type
constant lists (`lib/products.js`, `lib/manualSale.js`) — content with
no PII and no competitive sensitivity.

- **Handling**: no special controls needed beyond ordinary application
  access control.

## 3. Cross-cutting rule: never trust the client for classification

Every classification and access decision above is enforced server-side
(see `server/PERMISSIONS.md`) — the client UI hiding a field or a
button is a UX convenience, never the actual security boundary.

## 4. Open question for the eventual human owner

A formal data retention schedule (how long each category above is kept
before automatic deletion/anonymization) has not been set. This is a
business decision requiring input beyond what code alone can decide —
flagged here rather than guessed at.
