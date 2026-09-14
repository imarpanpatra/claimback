// Stand-in for lib/agent.js: emits a short, predictable run with no network calls.
// STUB_MS sets how long the run takes and STUB_TICKS how many notes it emits.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runClaim(input, emit) {
  emit({ type: 'step', id: 'flight', phase: 'read', title: `Stub run for ${input.flightNumber}` });
  const ticks = Number(process.env.STUB_TICKS || 5);
  const ms = Number(process.env.STUB_MS || 1000);
  for (let i = 0; i < ticks; i++) {
    await sleep(ms / ticks);
    emit({ type: 'note', step: 'flight', text: `tick ${i}` });
  }
  const claim = {
    verdict: 'not_owed',
    flight: { flight: input.flightNumber, fromName: 'London', fromCode: 'LHR', toName: 'Delhi', toCode: 'DEL', date: input.date },
    reasons: ['stub'],
    models: ['stub'],
    credits: 0,
  };
  emit({ type: 'result', claim });
  return claim;
}
