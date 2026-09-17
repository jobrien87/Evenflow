// This is the ONLY place ED talks to an LLM. Everything else about ED's
// factual context (goals, pace, counts, priority) is deterministic and comes
// from lib/edContext.js — never from here. If this integration isn't
// configured, ED must say so plainly rather than fabricating an answer.

const DEFAULT_MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

async function callEd({ systemPrompt, userMessage, maxTokens = 500 }) {
  if (!isConfigured()) {
    return { available: false };
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = new Error(`AI provider error: ${resp.status} ${text}`);
    err.providerStatus = resp.status;
    throw err;
  }

  const data = await resp.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  return {
    available: true,
    text,
    model: DEFAULT_MODEL,
    inputTokens: data.usage ? data.usage.input_tokens : 0,
    outputTokens: data.usage ? data.usage.output_tokens : 0,
  };
}

module.exports = { callEd, isConfigured, DEFAULT_MODEL };
