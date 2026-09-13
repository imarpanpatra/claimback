// Builds the static site for a Hugging Face Static Space: the page plus the
// recorded run, with no server. Live claims run on the Node server (render.yaml).
//   LIVE_URL=https://claimback.onrender.com node scripts/build-static.js
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = 'dist/hf-space';

if (!existsSync('public/demo/featured-run.json')) {
  console.error('No recorded run yet. Run scripts/feature-run.js first.');
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
// Keep the folder's .git, so a Space remote set up there survives rebuilds.
for (const entry of await readdir(OUT)) {
  if (entry !== '.git') await rm(path.join(OUT, entry), { recursive: true, force: true });
}
await cp('public', OUT, { recursive: true });
await writeFile(path.join(OUT, 'site.json'), JSON.stringify({ liveUrl: process.env.LIVE_URL || null }));
await writeFile(path.join(OUT, 'README.md'), `---
title: Claimback
emoji: ✈️
colorFrom: green
colorTo: blue
sdk: static
pinned: false
license: mit
short_description: An AI agent that claims flight delay compensation
---

# Claimback

A recorded run of Claimback, an AI agent that checks what happened to a delayed flight, reads the law that covers it, and fills in the airline's claim form.

Source code: https://github.com/imarpanpatra/claimback
`);
console.log(`Built ${OUT}${process.env.LIVE_URL ? ` (live link: ${process.env.LIVE_URL})` : ''}`);
