// Strips obvious, reliably-regex-detectable PII from a call transcript
// before it's sent to a third-party LLM for analysis (lib/callAnalysis.js).
// This is the code-only alternative to a paid Anthropic zero-data-retention
// enterprise agreement (SOC 2 Tier 1 compliance item). It intentionally
// does not attempt to redact every possible PII token — a customer's name
// spoken in free-flowing conversation isn't reliably detectable by regex
// without risking mangling the legitimate coaching content the analysis
// depends on — only the small set of structured patterns a regex can
// match with very low false-positive risk: SSNs, card-like numbers, phone
// numbers, and email addresses.

const SSN_RE = /\b\d{3}[-.\s]\d{2}[-.\s]\d{4}\b/g;
const PHONE_RE = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
// Broad candidate match for a card-like run of digits (optionally grouped
// by single spaces/dashes) — filtered below to the real 13-19 digit
// length a card number actually has, so a shorter run (a policy number, a
// phone extension) is left untouched.
const CARD_CANDIDATE_RE = /\b\d[\d\- ]{11,22}\d\b/g;

function redactCardNumbers(text) {
  return text.replace(CARD_CANDIDATE_RE, (match) => {
    const digitsOnly = match.replace(/[^\d]/g, '');
    return digitsOnly.length >= 13 && digitsOnly.length <= 19 ? '[REDACTED-CARD]' : match;
  });
}

function redactTranscript(transcript) {
  if (!transcript) return transcript;
  let out = transcript;
  out = out.replace(SSN_RE, '[REDACTED-SSN]');
  out = redactCardNumbers(out);
  out = out.replace(PHONE_RE, '[REDACTED-PHONE]');
  out = out.replace(EMAIL_RE, '[REDACTED-EMAIL]');
  return out;
}

module.exports = { redactTranscript };
