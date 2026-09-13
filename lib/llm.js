// Every structured question the agent asks goes through here. OpenAI answers
// when OPENAI_API_KEY is set, with Gemini as the fallback; with only a Gemini
// key, Gemini answers everything.
import { AsyncLocalStorage } from 'node:async_hooks';
import * as gemini from './gemini.js';
import * as openai from './openai.js';

// Collects the models that actually answered during one claim, so the result
// can say which ones did the reasoning.
export const modelsUsed = new AsyncLocalStorage();

const providers = () => [
  process.env.OPENAI_API_KEY && openai,
  process.env.GEMINI_API_KEY && gemini,
].filter(Boolean);

export function llmLabel() {
  const names = [];
  if (process.env.OPENAI_API_KEY) names.push(openai.openaiModel());
  if (process.env.GEMINI_API_KEY) names.push(gemini.geminiModel());
  return names.join(', with ') || 'no model configured';
}

export async function askJson(args) {
  const available = providers();
  if (!available.length) throw new Error('Set OPENAI_API_KEY or GEMINI_API_KEY');

  let lastError;
  for (const provider of available) {
    try {
      const { answer, model } = await provider.askJson(args);
      modelsUsed.getStore()?.add(model);
      return answer;
    } catch (err) {
      lastError = err;
      if (provider !== available.at(-1)) console.warn(`${err.message}. Trying the next provider.`);
    }
  }
  throw lastError;
}
