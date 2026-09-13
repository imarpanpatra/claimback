// Gemini REST client with JSON-schema output.
const API = 'https://generativelanguage.googleapis.com/v1beta/models';

// Overload (503) and the free tier's per-model daily quota are both common, so
// each call retries the chosen model and then works down the Gemini 3 Flash
// family, where every version has its own quota.
const FALLBACKS = [
  { model: 'gemini-3.7-flash', attempts: 2 },
  { model: 'gemini-3.6-flash', attempts: 2 },
  { model: 'gemini-3.5-flash', attempts: 2 },
  { model: 'gemini-3.1-flash-lite', attempts: 1 },
];
const PRIMARY_ATTEMPTS = 3;

export function geminiModel() {
  return process.env.GEMINI_MODEL || 'gemini-3.8-flash';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function attemptPlan() {
  const primary = geminiModel();
  const plan = Array(PRIMARY_ATTEMPTS).fill(primary);
  for (const { model, attempts } of FALLBACKS) {
    if (model !== primary) plan.push(...Array(attempts).fill(model));
  }
  return plan;
}

function generationConfig(model, schema, thinkingLevel) {
  const config = { responseMimeType: 'application/json', responseJsonSchema: schema };
  // "low" answers these structured questions in a couple of seconds; the
  // default thinking level can take half a minute.
  if (model.startsWith('gemini-3')) config.thinkingConfig = { thinkingLevel };
  return config;
}

export async function askJson({ system, prompt, schema, images = [], thinkingLevel = 'low', timeoutMs = 120_000 }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');

  const parts = [
    { text: prompt },
    ...images.map((data) => ({ inlineData: { mimeType: 'image/jpeg', data } })),
  ];
  const plan = attemptPlan();
  const outOfQuota = new Set();
  let lastError;

  for (const [i, model] of plan.entries()) {
    if (outOfQuota.has(model)) continue;
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: generationConfig(model, schema, thinkingLevel),
    };

    let fatal = null;
    try {
      const res = await fetch(`${API}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        const candidate = data.candidates?.[0];
        const text = (candidate?.content?.parts ?? [])
          .filter((p) => p.text && !p.thought)
          .map((p) => p.text)
          .join('');
        if (text) return { answer: JSON.parse(text), model };
        lastError = new Error(`Gemini returned no answer (finishReason: ${candidate?.finishReason ?? 'unknown'})`);
      } else {
        const message = data.error?.message ?? 'request failed';
        lastError = new Error(`Gemini ${res.status} from ${model}: ${message}`);
        if (res.status === 429 && /quota/i.test(message)) {
          // Retrying a model that is out of quota only wastes time.
          outOfQuota.add(model);
          continue;
        }
        if (res.status !== 429 && res.status < 500) fatal = lastError;
      }
    } catch (err) {
      lastError = err.name === 'TimeoutError' ? new Error(`Gemini timed out after ${timeoutMs / 1000}s`) : err;
    }

    if (fatal) throw fatal;
    if (i < plan.length - 1) await sleep(Math.min(2000 * 2 ** i, 12_000));
  }
  throw lastError;
}
