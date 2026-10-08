# Vendor Management Policy

> **Owner: unassigned.** This policy needs a real, named, accountable
> human owner before the review cadence below is more than aspirational
> — in particular, signing the actual DPAs listed in Section 3 is
> paperwork a human has to do, not something code can complete. This is
> one of the six policy documents flagged in the SOC 2 readiness
> assessment as a governance gap.
>
> **Last reviewed:** drafted 2026-10-08, not yet reviewed by a human
> owner. No DPA has been confirmed signed with any vendor below.

## 1. Purpose

This policy governs how Evenflow selects, onboards, and continues to
trust the third-party services (subprocessors) that process data on
its behalf.

## 2. Current subprocessors (confirmed by reading the actual integration code)

| Vendor | What it receives | Integration point |
|---|---|---|
| Render | Hosts the application and the Postgres database — the broadest access of any vendor, by necessity. | `render.yaml`, the whole deployment |
| Render Postgres | All application data. | `DATABASE_URL` |
| Anthropic | Call-transcript text (redacted of structured PII before sending — `lib/transcriptRedaction.js`), Ed assistant conversations, goal-parsing requests. | `lib/aiProvider.js` |
| Brevo | Recipient email address + name, for transactional invitation/password-reset emails only — no bulk/marketing use. | `lib/email.js` |
| Stripe | Billing contact info, seat counts, subscription state — no raw card data (Stripe Checkout/Elements handles card entry directly; confirm this is still true before relying on PCI SAQ-A scoping). | `lib/stripe.js` |
| Bunny.net | Call recording audio files, for the Coaching Video Theater feature. | `lib/bunnyStream.js` |
| Boberdoo | Lead data, for the Record Store real-time lead-purchasing feature. | `lib/boberdoo.js` |

Each integration already follows the same honest-degradation pattern
(an `isConfigured()`/`isObjectStorageConfigured()`-style check, never a
fabricated success when a vendor's credentials are absent) — this
policy governs the business/contractual side, not the code pattern,
which is already consistent.

## 3. Data Processing Agreements (DPA)

**Not yet confirmed signed with any vendor above.** This is standard
compliance paperwork, not a code change, and should be completed before
this policy is considered adopted:

1. Request/confirm a DPA with each vendor in Section 2 (most have a
   standard one available on request or via their own compliance page).
2. Confirm each vendor's own subprocessor list and data-residency
   commitments.
3. For Anthropic specifically: confirm whether Evenflow's account has
   (or should have) zero-data-retention terms for the API traffic sent
   from `lib/aiProvider.js`; until that's confirmed, transcript
   redaction (`lib/transcriptRedaction.js`) is the compensating control.

## 4. Evaluating a new vendor before integrating one

Before adding a new third-party integration to this codebase:

- Confirm what data it would receive and whether that's the minimum
  necessary (mirror the existing pattern of sending redacted/minimal
  data, e.g. transcript redaction, Brevo receiving only recipient
  contact info).
- Confirm the vendor has a real, inspectable security posture (SOC 2
  report, documented encryption practices) appropriate to what it will
  receive.
- Add the new vendor to the table in Section 2 and request its DPA
  before go-live, not after.

## 5. Ongoing review

Once a human owner is assigned, review this vendor list at least
annually: confirm each integration is still in active use, each DPA is
still current, and no vendor's own reported incidents affect Evenflow's
data.

## 6. Known gap: no automated backup vendor/mechanism

Render's Postgres free tier (what this app currently runs on) has no
automated backup. Upgrading to a plan with backups is a vendor/billing
decision for a human to make, flagged here rather than a silent
assumption.
