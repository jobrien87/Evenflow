// Deterministic, rule-based cross-sell detection. Per spec's own example
// ("Auto customer without Home → potential Home cross-sell"), this is
// exactly the kind of thing plain rules should compute — no LLM call, no
// guessing, and it only ever looks at products the customer is REALLY
// recorded as owning (populated exclusively from real SOLD dispositions).

const COMPLEMENTARY_RULES = [
  { have: 'Auto', suggest: 'Home' },
  { have: 'Home', suggest: 'Auto' },
  { have: 'Auto', suggest: 'Life' },
  { have: 'Home', suggest: 'Life' },
];

function detectCrossSellGaps(currentProducts) {
  const owned = new Set((currentProducts || []).map((p) => p.trim()));
  const gaps = [];
  const seen = new Set();

  for (const rule of COMPLEMENTARY_RULES) {
    if (owned.has(rule.have) && !owned.has(rule.suggest) && !seen.has(rule.suggest)) {
      gaps.push({
        suggest: rule.suggest,
        reason: `Has ${rule.have}, does not have ${rule.suggest}`,
      });
      seen.add(rule.suggest);
    }
  }

  return gaps;
}

module.exports = { detectCrossSellGaps, COMPLEMENTARY_RULES };
