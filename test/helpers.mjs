// Shared test helpers. Nothing here calls a paid API.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// What Gemini's REST API returns for a structured answer.
export const geminiReply = (answer) => json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });

export function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
    for (const sub of ['chrome-win64', 'chrome-win', 'chrome-linux']) {
      for (const exe of ['chrome.exe', 'chrome']) {
        const candidate = path.join(root, dir, sub, exe);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

// Serves a folder the way a static host would: files only, 404 for anything else.
export async function serveStatic(dir) {
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(dir, pathname === '/' ? 'index.html' : pathname);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return { url: `http://localhost:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Starts the real server.js with lib/agent.js swapped for a stub, so no paid API runs.
export async function startServer(env = {}) {
  const port = await freePort();
  const hooks = new URL('./fixtures/use-stub-agent.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', hooks, 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), LIVE_RUN_CODE: 'secret', GEMINI_API_KEY: 'test', OPENAI_API_KEY: '', ANAKIN_API_KEY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const url = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${url}/api/config`).then(() => true, () => false)) {
      return {
        url,
        port,
        log: () => log,
        stop: async () => {
          child.kill();
          await exited;
        },
      };
    }
    await sleep(100);
  }
  child.kill();
  throw new Error(`server.js did not start:\n${log}`);
}
