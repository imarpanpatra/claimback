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
const PASSENGER = { fullName: 'Alex Demo', email: 'alex.demo@example.com', ticketNumber: '0982100000000' };

const HEADER = '<div style="height:220px">site header</div>';
const formPage = (inner) => `<!doctype html><html><body>${HEADER}
<form id="f" action="/sent" onsubmit="event.preventDefault(); window.__sent = (window.__sent || 0) + 1;">
  <label>Ticket number <input name="ticket"></label>
  <label>Last name <input name="last"></label>
  ${inner}
</form></body></html>`;

const infoText = 'If your flight arrived more than three hours late, you may be owed compensation. '.repeat(30);
const infoPage = (link) => `<!doctype html><html><body>${HEADER}<h1>Delay compensation</h1><p>${infoText}</p>${link}</body></html>`;
const find = (controls, pick) => controls.find(pick)?.i;
const click = (controls, pick) => ({ index: find(controls, pick), op: 'click', value: '' });
const fillTicket = (controls) => ({ index: find(controls, (x) => x.label?.startsWith('Ticket')), op: 'fill', value: '2100000000' });

// A consent banner that lives in its own frame, as some consent tools render it.
const BANNER = '<!doctype html><html><body><p>We use cookies.</p><button onclick="parent.__rejected = true; this.remove()">Reject all</button><button>Accept all</button></body></html>';
// A page that shows nothing for six seconds, then renders its form.
const LATE_PAGE = `<!doctype html><html><body>${HEADER}<div id="slot">Loading</div><script>
setTimeout(() => { document.getElementById('slot').innerHTML = '<form onsubmit="event.preventDefault()"><label>Ticket number <input name="ticket"></label><label>Last name <input name="last"></label></form>'; }, 6000);
</script></body></html>`;

// next: the page leads somewhere, so the stand-in model doesn't stop on it.
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
  'script-send': {
    html: formPage(`<button type="button" onclick="fetch('/api/claims', { method: 'POST', body: JSON.stringify({ ticket: document.querySelector('[name=ticket]').value }) })">Continue</button>`),
    act: (c) => [fillTicket(c), click(c, (x) => x.text === 'Continue')],
    facts: { passenger: PASSENGER },
  },
  'info-page': {
    html: infoPage('<a href="/form">File a claim</a>'),
    act: (c) => [click(c, (x) => x.text === 'File a claim')],
    next: true,
  },
  'new-tab': {
    html: infoPage('<a href="/form" target="_blank">File a claim</a>'),
    act: (c) => [click(c, (x) => x.text === 'File a claim')],
    next: true,
  },
  'frame-banner': {
    html: formPage('<button type="submit">Submit</button>').replace(HEADER, `${HEADER}<iframe src="/banner" style="width:400px;height:120px"></iframe>`),
    act: (c) => [fillTicket(c)],
  },
  'late-render': {
    html: infoPage('<a href="/late">Continue to the claim form</a>'),
    act: (c) => [click(c, (x) => x.text === 'Continue to the claim form')],
    next: true,
  },
  late: {
    act: (c) => [fillTicket(c)],
  },
  fills: {
    html: formPage('<button type="submit">Submit</button>'),
    act: (c) => [
      fillTicket(c),
      { index: find(c, (x) => x.label?.startsWith('Last')), op: 'fill', value: 'Demo' },
    ],
  },
};

function decide(prompt) {
  const { pathname } = new URL(prompt.url);
  if (pathname === '/form') return { page: 'claim_form', summary: 'The claim form.', actions: [], stop: true, stopReason: 'Ready to submit' };
  const name = pathname.split('/').pop();
  const actions = CASES[name].act(prompt.controls).filter((a) => a.index !== undefined);
  return { page: 'claim_form', summary: `test ${name}`, actions, stop: !CASES[name].next, stopReason: 'test done' };
}

globalThis.fetch = async (url, options) => {
  if (!String(url).includes('generativelanguage.googleapis.com')) throw new Error(`unexpected request: ${url}`);
  const prompt = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
  return geminiReply(decide(prompt));
};

const { fillClaimForm } = await import('../lib/claimform.js');

let claimsReceived = 0;
const pages = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/api/claims') {
    claimsReceived += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{}');
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  if (pathname === '/form') return res.end(formPage('<button type="submit">Submit</button>'));
  if (pathname === '/sent') return res.end('<p>sent</p>');
  if (pathname === '/banner') return res.end(BANNER);
  if (pathname === '/late') return res.end(LATE_PAGE);
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
      const result = await fillClaimForm({ page, url: `${base}/case/${name}`, facts: CASES[name].facts ?? {}, emit: (e) => events.push(e), step: 'form' });
      const state = await page.evaluate(() => ({
        sent: window.__sent || 0,
        rejected: window.__rejected || false,
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

  it('never lets a script send the passenger’s details, whatever its button says', async () => {
    const { result, ticket } = await runCase('script-send');
    assert.equal(claimsReceived, 0, 'the page sent the ticket number to its server');
    assert.equal(ticket, '2100000000');
    assert.match(result.reason, /stopped/);
  });

  it('follows a "File a claim" link from an information page without a long wait', async () => {
    const { result, events, path, seconds } = await runCase('info-page');
    assert.equal(path, '/form', `ended on ${path}: ${result.reason}`);
    assert.ok(seconds < 25, `took ${seconds.toFixed(0)} s`);
    assert.equal(events.some((e) => e.type === 'note' && /reloaded/.test(e.text)), false);
  });

  it('carries on in a new tab when a link opens one', async () => {
    const { result } = await runCase('new-tab');
    assert.equal(new URL(result.finalUrl).pathname, '/form', result.reason);
  });

  it('clears a cookie banner inside a frame', async () => {
    const { rejected, events } = await runCase('frame-banner');
    assert.equal(rejected, true, 'the banner in the frame was not rejected');
    assert.ok(events.some((e) => e.type === 'action' && /cookie banner/.test(e.label)));
  });

  it('waits for a page that renders late instead of giving up on it', async () => {
    const { ticket, result } = await runCase('late-render');
    assert.equal(ticket, '2100000000', result.reason);
  });

  it('still fills in fields', async () => {
    const { ticket, last, sent } = await runCase('fills');
    assert.equal(ticket, '2100000000');
    assert.equal(last, 'Demo');
    assert.equal(sent, 0);
  });
});
