// Loaded with --import by the feature-run test. Answers the network the way
// Anakin and S3 would: the run's stored link has expired, and the account holds
// this run's recording plus a later one from another session.
globalThis.fetch = async (url) => {
  url = String(url);
  const reply = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  if (url.startsWith('https://expired.example/')) return reply(403, 'expired');
  if (url === 'https://api.anakin.io/v1/recordings') {
    return reply(200, {
      recordings: [
        { connId: 'rec-mine', createdAt: '2026-09-13T17:06:35Z', duration: 39, status: 'completed' },
        { connId: 'rec-other', createdAt: '2026-09-13T22:00:00Z', duration: 60, status: 'completed' },
      ],
    });
  }
  const detail = url.match(/^https:\/\/api\.anakin\.io\/v1\/recordings\/([\w-]+)$/);
  if (detail) return reply(200, { connId: detail[1], videoUrl: `https://s3.example/${detail[1]}.webm` });
  if (url.startsWith('https://s3.example/')) return reply(200, `VIDEO ${url.split('/').pop().replace('.webm', '')}`);
  throw new Error(`unexpected request: ${url}`);
};
