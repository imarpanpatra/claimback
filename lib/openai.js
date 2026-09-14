// OpenAI Chat Completions client with strict JSON-schema output.
const API = 'https://api.openai.com/v1/chat/completions';
const REASONING_MODELS = /^(gpt-5|o\d)/;

export const openaiModel = () => process.env.OPENAI_MODEL || 'gpt-5-mini';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Strict structured outputs need every object closed and every key required.
function strict(schema) {
  if (Array.isArray(schema)) return schema.map(strict);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    out[key] = key === 'properties'
      ? Object.fromEntries(Object.entries(value).map(([name, s]) => [name, strict(s)]))
      : strict(value);
  }
  if (out.type === 'object') {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties ?? {});
  }
  return out;
}

export async function askJson({ system, prompt, schema, timeoutMs = 120_000 }) {
  const model = openaiModel();
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: strict(schema) } },
    ...(REASONING_MODELS.test(model) && { reasoning_effort: 'low' }),
  };

  for (let attempt = 1; ; attempt++) {
    let res;
    let data;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      data = await res.json().catch(() => ({}));
    } catch (err) {
      // A timeout has already waited long enough, so hand over to the next
      // provider instead of waiting again.
      if (err.name === 'TimeoutError') throw new Error(`OpenAI timed out after ${timeoutMs / 1000}s`);
      if (attempt >= 3) throw err;
      await sleep(2000 * attempt);
      continue;
    }

    if (res.ok) {
      const message = data.choices?.[0]?.message;
      if (message?.refusal) throw new Error(`OpenAI declined: ${message.refusal}`);
      if (!message?.content) throw new Error(`OpenAI returned no answer (finish_reason: ${data.choices?.[0]?.finish_reason ?? 'unknown'})`);
      return { answer: JSON.parse(message.content), model };
    }

    const text = data.error?.message ?? 'request failed';
    const error = new Error(`OpenAI ${res.status} from ${model}: ${text}`);
    const retryable = res.status >= 500 || (res.status === 429 && !/quota|billing/i.test(text));
    if (!retryable || attempt >= 3) throw error;
    await sleep(2000 * attempt);
  }
}
