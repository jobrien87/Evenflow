# Incident Response Plan

> **Owner: unassigned.** This plan needs a real, named, accountable
> human owner (and at least one designated backup) before it can be
> relied on during a real incident — until then, the roles and contacts
> below are placeholders to be filled in, not a working escalation
> chain. This is one of the six policy documents flagged in the SOC 2
> readiness assessment as a governance gap.
>
> **Last reviewed:** drafted 2026-10-08, not yet reviewed, not yet
> exercised in a tabletop drill.

## 1. Purpose

This plan describes how Evenflow detects, contains, and recovers from a
security incident — unauthorized access, a data breach, a compromised
credential, a service outage with a security dimension, or a
vulnerability actively being exploited — and how affected parties
(agency customers, their consumers, regulators) are notified.

## 2. Roles (fill in real names before relying on this plan)

| Role | Responsibility | Name |
|---|---|---|
| Incident Commander | Owns the response end-to-end, makes the call/no-call/notify decisions | _unassigned_ |
| Technical Lead | Diagnoses and contains the technical root cause | _unassigned_ |
| Communications Lead | Drafts and sends customer/regulator notifications | _unassigned_ |

A one-person company can hold all three roles at once — the point of
naming them separately is so that, as the team grows, each is handed to
a specific person rather than left ambiguous.

## 3. Severity classification

- **Critical** — confirmed unauthorized access to customer PII
  (`Customer`/`Lead` records), a compromised admin credential, or a
  live, actively-exploited vulnerability. Immediate response, Incident
  Commander notified regardless of time of day.
- **High** — a vulnerability found before exploitation, a suspicious
  pattern in `AuditEvent` data (e.g. a burst of `auth.login_failed`
  rows from one IP) that hasn't yet resulted in confirmed access,
  or a vendor (subprocessor) reporting their own breach.
- **Medium** — a misconfiguration found during review with no evidence
  of exploitation, a dependency vulnerability flagged by `npm audit` or
  Dependabot with no known active exploit.
- **Low** — a hardening opportunity identified proactively, no
  indication of risk realized.

## 4. Response steps

1. **Detect.** An incident can surface from: an `AuditEvent` anomaly
   noticed during review, a Dependabot/`npm audit` alert, a report from
   a customer or vendor, or direct observation (e.g. unexpected data in
   the app).
2. **Triage and classify.** The person who detects it notifies the
   Incident Commander (or acts as one if solo) and assigns a severity
   per Section 3.
3. **Contain.** Stop ongoing harm first — this can mean revoking a
   specific user's sessions (`revokeAllSessionsForUser`), disabling a
   compromised vendor API key, rotating a leaked secret (see Section 6),
   or taking a specific route/feature offline via a deploy.
4. **Eradicate.** Fix the actual root cause — patch the vulnerable code,
   rotate every credential that could have been exposed, not just the
   one known to be compromised.
5. **Recover.** Confirm the fix is deployed and verified (the same
   `npm test`/`npm run build`/real-browser-verification discipline this
   codebase already follows for every change). Restore from backup if
   data integrity was affected (see Section 7 on the current backup
   gap).
6. **Notify.** See Section 5 for who and when.
7. **Post-mortem.** Write down what happened, why, and what changes
   (code, process, or monitoring) would have caught it sooner or
   prevented it. This document itself should be updated if the plan
   didn't match reality.

## 5. Notification obligations

- **Agency customers**: notify directly and promptly if their data (or
  their own end consumers' data) was or may have been exposed. Be
  specific about what was affected, not vague.
- **Consumers (end data subjects)**: most US state breach-notification
  laws require notifying affected individuals; the specific trigger and
  timeline vary by state (where the consumer resides, not where
  Evenflow or the agency is based) — this needs a licensed attorney's
  review once a real incident occurs, not a guess from this document.
- **State insurance regulators**: for agency customers (licensed
  insurance producers), several states' adoption of the NAIC Insurance
  Data Security Model Law imposes a **72-hour** notification duty to
  the state insurance commissioner for a qualifying breach. Confirm
  which states' agencies are affected and whether their specific
  adoption of the model law applies.
- **Vendors/subprocessors**: if a subprocessor (Render, Anthropic,
  Brevo, Stripe, Bunny.net, Boberdoo) is the source of an incident,
  their own breach-notification terms (per their DPA, once one exists —
  see the Vendor Management policy) govern what they owe Evenflow.

## 6. Credential rotation runbook (interim, manual)

No automated secret-rotation exists today. If a secret is suspected
compromised:

1. **Anthropic / Brevo / Stripe / Bunny.net / Boberdoo API keys** —
   generate a new key in that vendor's dashboard, update the
   corresponding Render environment variable, redeploy, then revoke the
   old key in the vendor's dashboard.
2. **A user's session/password** — an admin can already deactivate the
   account (revokes all sessions) or trigger a forced password reset
   (`POST /users/:userId/send-password-reset`); for broader concern,
   disable then re-invite.
3. **The database credential itself** — rotate via Render's Postgres
   dashboard, update `DATABASE_URL`, redeploy.

## 7. Known gap: no automated backups

Postgres currently runs on Render's free tier, which has no automated
backup mechanism. There is no `pg_dump` script or scheduled export
today. **This is the single biggest real risk to data-loss recovery**
and should be closed (upgrading the Postgres plan) before this plan is
considered more than a paper exercise for a data-integrity incident, as
opposed to a confidentiality incident.

## 8. Testing this plan

A plan that has never been rehearsed is unproven. Once a human owner is
assigned, run a tabletop exercise (a fictional scenario, walked through
by the team without touching production) at least annually.
