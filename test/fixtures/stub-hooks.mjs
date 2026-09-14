// Module hook: resolves server.js's import of ./lib/agent.js to the stub agent.
const STUB = new URL('./stub-agent.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === './lib/agent.js' && context.parentURL?.endsWith('/server.js')) {
    return { url: STUB, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
