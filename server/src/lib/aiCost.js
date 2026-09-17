// Per-million-token rates, in USD micros (1 micro = 1/1,000,000 of a dollar).
// These are approximate and will drift as providers change pricing — treated
// everywhere as an ESTIMATE, never as invoice truth (per spec: "Never present
// estimated AI cost as invoice truth without label").
//
// Cost is stored in micros rather than cents because a single ED chat call
// typically costs a fraction of a cent — rounding to whole cents would make
// nearly every log row show $0.00, which defeats the point of cost tracking.
const RATES_PER_MILLION_MICROS = {
  'claude-haiku-4-5-20251001': { input: 1_000_000, output: 5_000_000 }, // $1.00 in / $5.00 out per million tokens
  default: { input: 3_000_000, output: 15_000_000 },
};

function estimateCostMicros(model, inputTokens, outputTokens) {
  const rates = RATES_PER_MILLION_MICROS[model] || RATES_PER_MILLION_MICROS.default;
  const inputCost = (inputTokens / 1_000_000) * rates.input;
  const outputCost = (outputTokens / 1_000_000) * rates.output;
  return Math.round(inputCost + outputCost);
}

function microsToDollars(micros) {
  return micros / 1_000_000;
}

module.exports = { estimateCostMicros, microsToDollars };
