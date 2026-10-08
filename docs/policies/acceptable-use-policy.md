# Acceptable Use Policy

> **Owner: unassigned.** This policy needs a real, named, accountable
> human owner before it can be enforced or referenced in an employee/
> contractor agreement. This is one of the six policy documents flagged
> in the SOC 2 readiness assessment as a governance gap.
>
> **Last reviewed:** drafted 2026-10-08, not yet reviewed by a human
> owner.

## 1. Purpose and audience

This policy applies to everyone with access to Evenflow's systems:
employees and contractors with application accounts (any role —
Platform Owner, Agency Owner, Agency Manager, Producer, Telemarketer),
and anyone with engineering/infrastructure access (the GitHub
repository, the Render dashboard, production credentials).

## 2. Acceptable use

- Use your own account. Credentials are personal and must not be
  shared — if two people need access, each gets their own invitation,
  not a shared login.
- Access only the data you need for your actual job. A Producer's
  account should not be used to browse another producer's leads; an
  admin's broader access (Platform Owner impersonation, a Factory
  Reset, a Purge) should only be used for its intended, legitimate
  purpose, and every such action is already audit-logged — use it
  knowing it's logged, not despite that.
- Report a suspected security issue immediately (see
  `docs/policies/incident-response-plan.md`) rather than trying to fix
  it quietly yourself first, unless you are also the Incident
  Commander.
- Keep your own device reasonably secure — a locked screen, up-to-date
  OS, and (for anyone with infrastructure access) a password manager
  rather than a reused/weak password for the Render dashboard or
  GitHub.

## 3. Prohibited actions

- Sharing an account, a password, an API key, or an MFA backup code
  with anyone else, including a coworker "just this once."
- Accessing, exporting, or sharing consumer PII (leads, customers, call
  recordings/transcripts) for any purpose outside your actual job —
  curiosity about a specific person's data is not a legitimate reason.
- Disabling or bypassing a security control (MFA, a rate limiter, a
  tenant-scoping check) to make your own work faster. If a control is
  genuinely getting in the way of legitimate work, raise it with the
  policy owner (once assigned) rather than working around it silently.
- Using production credentials/data for anything other than their
  intended purpose — e.g. never copy real customer data into a local
  test/dev environment without explicit authorization, and never point
  a test script at the production database (a real past exposure the
  team already corrected: `server/scripts/smoke-test.js` previously
  carried a hardcoded credential meant only for local testing and has
  since been fixed to use an environment variable instead, with a
  stated rule to never again point it at a production URL).
- Introducing a new third-party dependency or integration without
  going through `docs/policies/vendor-management-policy.md`'s
  evaluation step.
- Committing a real secret (API key, database URL, password) to the
  Git repository. If this happens by accident: rotate the secret
  immediately (see the Incident Response Plan's credential-rotation
  runbook) — do not assume removing it from a later commit is
  sufficient, since Git history retains it.

## 4. Enforcement

A violation of this policy should be handled the same way any incident
is: per `docs/policies/incident-response-plan.md`, proportionate to
what actually happened (an honest mistake quickly self-reported is
different from a deliberate, repeated violation).

## 5. Acknowledgment

Once a human owner is assigned, this policy should be given to every
new team member with system access as part of onboarding, with an
explicit acknowledgment (even a simple "I have read and will follow
this" is enough to start) rather than assumed.
