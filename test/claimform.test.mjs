// Drives the real form filler in local Chrome against test pages. The model is a
// stand-in that asks for a specific action on each page, and the pages record
// whether anything was actually sent.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { findChromium, geminiReply } from './helpers.mjs';

process.env.GEMINI_API_KEY = 'test';
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_MODEL;

const chromePath = findChromium();
const skip = chromePath ? false : 'no local Chromium found (set CHROME_PATH)';
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

const formPage = (inner) => `<!doctype html><html><body><div style="height:220px">site header</div>
<form id="f" action="/sent" onsubmit="event.preventDefault(); window.__sent = (window.__sent || 0) + 1;">
  <label>Ticket number <input name="ticket"></label>
  <label>Last name <input name="last"></label>
  ${inner}
</form></body></html>`;

const infoText = 'If your flight arrived more than three hours late, you may be owed compensation. '.repeat(30);
const find = (controls, pick) => controls.find(pick)?.i;
const click = (controls, pick) => ({ index: find(controls, pick), op: 'click', value: '' });

const CASES = {
  'icon-button': {
    html: formPage('<button aria-label="Submit claim"><svg width="20" height="20"><rect width="20" height="20"/></svg></button>'),
    act: (c) => [click(c, (x) => x.label === 'Submit claim')],
  },
  'image-input': {
    html: formPage(`<input type="image" alt="Submit" src="${GIF}" width="40" height="20">`),
    act: (c) => [click(c, (x) => x.type === 'image')],
  },
  'claim-now': {
    html: formPage('<button type="submit">Claim now</button>'),
    act: (c) => [click(c, (x) => x.text === 'Claim now')],
  },
  'script-next': {
    html: formPage(`<div role="button" onclick="document.getElementById('f').requestSubmit()">Next</div>`),
    act: (c) => [click(c, (x) => x.text === 'Next')],
  },
  'script-save': {
    html: formPage(`<button type="button" onclick="document.getElementById('f').submit()">Save</button>`),
    act: (c) => [click(c, (x) => x.text === 'Save')],
  },
  'select-submits': {
    html: formPage('<label>Reason <select name="reason" onchange="this.form.requestSubmit()"><option>Choose</option><option>Delay</option></select></label>'),
    act: (c) => [{ index: find(c, (x) => x.tag === 'select'), op: 'select', value: 'Delay' }],
  },
  'payment-script': {
    html: formPage('<button type="button" onclick="window.__sent = (window.__sent || 0) + 1">Proceed to payment</button>'),
    act: (c) => [click(c, (x) => x.text === 'Proceed to payment')],
  },
  'label-changes': {
    html: formPage(`<input name="extra" oninput="document.getElementById('go').textContent = 'Submit claim'">
      <button type="button" id="go" onclick="window.__sent = (window.__sent || 0) + 1">Next</button>`),
    act: (c) => [{ index: find(c, (x) => x.label === 'extra'), op: 'fill', value: 'x' }, click(c, (x) => x.text === 'Next')],
  },
  'info-page': {
    html: `<!doctype html><html><body><div style="height:220px">site header</div><h1>Delay compensation</h1><p>${infoText}</p><a href="/form">File a claim</a></body></html>`,
    act: (c) => [click(c, (x) => x.text === 'File a claim')],
  },
  fills: {
    html: formPage('<button type="submit">Submit</button>'),
    act: (c) => [
      { index: find(c, (x) => x.label?.startsWith('Ticket')), op: 'fill', value: '2100000000' },
      { index: find(c, (x) => x.label?.startsWith('Last')), op: 'fill', value: 'Demo' },
    ],
  },
};

function decide(prompt) {
  const { pathname } = new URL(prompt.url);
  if (pathname === '/form') return { page: 'claim_form', summary: 'The claim form.', actions: [], stop: true, stopReason: 'Ready to submit' };
  const name = pathname.split('/').pop();
  const actions = CASES[name].act(prompt.controls).filter((a) => a.index !== undefined);
  return { page: 'claim_form', summary: `test ${name}`, actions, stop: name !== 'info-page', stopReason: 'test done' };
}

globalThis.fetch = async (url, options) => {
  if (!String(url).includes('generativelanguage.googleapis.com')) throw new Error(`unexpected request: ${url}`);
  const prompt = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
  return geminiReply(decide(prompt));
};

const { fillClaimForm } = await import('../lib/claimform.js');

const pages = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  res.writeHead(200, { 'Content-Type': 'text/html' });
  if (pathname === '/form') return res.end(formPage('<button type="submit">Submit</button>'));
  if (pathname === '/sent') return res.end('<p>sent</p>');
  return res.end(CASES[pathname.split('/').pop()]?.html ?? 'missing');
});

describe('claim form filler', { skip, concurrency: true }, () => {
  let browser;
  let base;

  before(async () => {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    await new Promise((resolve) => pages.listen(0, resolve));
    base = `http://localhost:${pages.address().port}`;
  });

  after(async () => {
    await browser?.close();
    pages.close();
  });

  async function runCase(name) {
    const page = await browser.newPage();
    const events = [];
    const started = Date.now();
    try {
      const result = await fillClaimForm({ page, url: `${base}/case/${name}`, facts: {}, emit: (e) => events.push(e), step: 'form' });
      const state = await page.evaluate(() => ({
        sent: window.__sent || 0,
        ticket: document.querySelector('[name=ticket]')?.value,
        last: document.querySelector('[name=last]')?.value,
      })).catch(() => ({ sent: 0 }));
      return { result, events, ...state, path: new URL(page.url()).pathname, seconds: (Date.now() - started) / 1000 };
    } finally {
      await page.close();
    }
  }

  for (const name of ['icon-button', 'image-input', 'claim-now', 'script-next', 'script-save', 'select-submits', 'payment-script', 'label-changes']) {
    it(`never sends the form: ${name}`, async () => {
      const { sent, path } = await runCase(name);
      assert.equal(sent, 0, `${name} sent the form`);
      assert.notEqual(path, '/sent', `${name} submitted the form to its action URL`);
    });
  }

  it('follows a "File a claim" link from an information page without a long wait', async () => {
    const { result, events, path, seconds } = await runCase('info-page');
    assert.equal(path, '/form', `ended on ${path}: ${result.reason}`);
    assert.ok(seconds < 25, `took ${seconds.toFixed(0)} s`);
    assert.equal(events.some((e) => e.type === 'note' && /reloaded/.test(e.text)), false);
  });

  it('still fills in fields', async () => {
    const { ticket, last, sent } = await runCase('fills');
    assert.equal(ticket, '2100000000');
    assert.equal(last, 'Demo');
    assert.equal(sent, 0);
  });
});
