// Drives the airline's claim form in Anakin's cloud browser. The model decides
// what goes where; this module does the typing and makes sure nothing is ever
// sent: form submission is switched off inside the page, and controls that
// would send are never clicked.
import { askJson } from './llm.js';

const MAX_PAGES = 6;
// Words that mark a button as the one that sends. Checked against everything a
// button can be labelled with: its text, accessible name, value, alt and title.
const SENDS = /\b(submit|send|confirm|pay|payment|purchase|place order|finish|lodge)\b/i;

const SYSTEM = `You are filling in an airline's compensation claim form for a passenger, one page at a time.
You get the page's visible text and a numbered list of its controls.
- Dismiss cookie or consent banners first, preferring "reject" or "necessary only".
- On an information page, click the link or button that starts the claim.
- Fill every field you have data for. For selects use the exact option text. For date inputs use YYYY-MM-DD.
- Respect maxLength, and don't retype a prefix the page already shows next to a field (a ticket field showing 098 only needs the digits after 098).
- Skip disabled controls.
- Put fills before any click, and click at most one thing per step.
- Controls marked "sends" would send the form. Never click them, or any button that submits, sends, confirms or pays. Set stop to true with stopReason "Ready to submit" instead.
- If the page needs a login, a captcha, or data you don't have for a required field, set stop to true and say what's needed.
- Only use indexes from the list. Never invent passenger data; leave unknown optional fields empty.`;

const STEP_SCHEMA = {
  type: 'object',
  properties: {
    page: { type: 'string', enum: ['claim_form', 'information', 'consent_banner', 'login_required', 'captcha', 'other'] },
    summary: { type: 'string', description: 'One sentence on what this page is and what you are doing on it.' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          op: { type: 'string', enum: ['fill', 'select', 'check', 'click'] },
          value: { type: 'string', description: 'Text to type or option to pick. Empty for check and click.' },
        },
        required: ['index', 'op', 'value'],
      },
    },
    stop: { type: 'boolean' },
    stopReason: { type: 'string' },
  },
  required: ['page', 'summary', 'actions', 'stop', 'stopReason'],
};

// Runs in every page and frame before the site's own scripts. With it no form
// can be submitted, whether by a click, the Enter key or a script. Attempts are
// counted so the filler knows it reached the point of sending.
function lockSubmissions() {
  if (window.__claimbackBlockedSubmits) return;
  const attempts = [];
  Object.defineProperty(window, '__claimbackBlockedSubmits', { value: attempts });
  HTMLFormElement.prototype.submit = function submit() {
    attempts.push('form.submit()');
  };
  HTMLFormElement.prototype.requestSubmit = function requestSubmit() {
    attempts.push('form.requestSubmit()');
  };
  window.addEventListener('submit', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    attempts.push('submit event');
  }, true);
}

async function blockedSubmits(page) {
  let total = 0;
  for (const frame of page.frames()) {
    total += await frame.evaluate(() => window.__claimbackBlockedSubmits?.length ?? 0).catch(() => 0);
  }
  return total;
}

// Consent banners cover the form and swallow clicks, and models tend to skip
// them, so clear them in code. Rejecting is the only choice this code makes.
const CONSENT_SELECTORS = ['#onetrust-reject-all-handler', '#didomi-notice-disagree-button', '[data-testid="uc-deny-all-button"]'];
const CONSENT_TOOLS = '#onetrust-consent-sdk, script[src*="onetrust"], script[src*="cookielaw"], #didomi-host, script[src*="didomi"], #usercentrics-root, script[src*="usercentrics"]';
const CONSENT_NAMES = /^(reject all|reject|decline|decline all|refuse all|necessary only|only necessary|use necessary cookies only)$/i;

async function dismissConsent(page, waitMs = 0) {
  if (waitMs) {
    await page.waitForSelector(CONSENT_SELECTORS.join(', '), { state: 'visible', timeout: waitMs }).catch(() => {});
  }
  const candidates = [...CONSENT_SELECTORS.map((s) => page.locator(s).first()), page.getByRole('button', { name: CONSENT_NAMES }).first()];
  for (const button of candidates) {
    if (!(await button.isVisible().catch(() => false))) continue;
    const label = (await button.innerText().catch(() => '')).trim() || 'Reject';
    try {
      await button.click({ timeout: 5000 });
      return label;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

// How far a page has rendered: usable fields below the site header, and how
// much text it shows.
async function pageState(page) {
  let fields = 0;
  let textLength = 0;
  for (const frame of page.frames()) {
    const state = await frame.evaluate(() => ({
      fields: [...document.querySelectorAll('input, select, textarea')].filter((el) => {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (['hidden', 'search', 'submit', 'button', 'image', 'reset', 'checkbox', 'radio'].includes(type)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1 && r.top + window.scrollY > 150;
      }).length,
      textLength: (document.body?.innerText ?? '').trim().length,
    })).catch(() => ({ fields: 0, textLength: 0 }));
    fields = Math.max(fields, state.fields);
    textLength = Math.max(textLength, state.textLength);
  }
  return { fields, textLength };
}

// Waits until the page has something to work with: a form, a one-field lookup,
// or an information page. "Any input exists" passes on a header's search box
// long before a claim form renders, and a page showing only its header is
// still loading. A text-only page must stay field-less for a few seconds, so a
// form that renders after its surrounding text isn't missed.
async function waitForPage(page, timeoutMs) {
  const started = Date.now();
  let textOnlySince = null;
  while (Date.now() - started < timeoutMs) {
    const { fields, textLength } = await pageState(page);
    if (fields >= 2) return true;
    const now = Date.now();
    if (fields === 1 && now - started > 4000) return true;
    if (fields === 0 && textLength > 1500) {
      textOnlySince ??= now;
      if (now - textOnlySince >= 3000) return true;
    } else {
      textOnlySince = null;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

// Runs inside the page. Numbers every visible control so the model can refer to it.
function markControls() {
  document.querySelectorAll('[data-cb]').forEach((el) => el.removeAttribute('data-cb'));
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const labelOf = (el) => {
    if (el.labels?.length) return clean([...el.labels].map((l) => l.innerText).join(' '));
    const by = el.getAttribute('aria-labelledby');
    return clean(el.getAttribute('aria-label') || (by && document.getElementById(by)?.innerText) || el.getAttribute('alt') || el.getAttribute('placeholder') || el.getAttribute('title') || el.name || '');
  };

  const controls = [];
  const nodes = document.querySelectorAll('input, select, textarea, button, a, [role="button"], [role="checkbox"], [role="radio"], [role="combobox"]');
  for (const el of nodes) {
    if (controls.length >= 150) break;
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag;
    if (type === 'hidden' || !visible(el)) continue;
    const text = clean(el.innerText || el.value || el.getAttribute('alt') || '');
    if (tag === 'a' && !/claim|compensation|delay|disrupt|refund|start|continue|next|form|accept|reject|agree/i.test(text)) continue;

    const i = controls.length;
    el.setAttribute('data-cb', String(i));
    const isButton = tag === 'button' || tag === 'a' || ['submit', 'button', 'image', 'reset'].includes(type) || el.getAttribute('role') === 'button';
    const buttonType = tag === 'button' ? (el.getAttribute('type') || 'submit').toLowerCase() : type;
    const sends = Boolean(el.form) && ((tag === 'button' && buttonType === 'submit') || (tag === 'input' && ['submit', 'image'].includes(type)));
    controls.push({
      i,
      tag,
      type,
      label: labelOf(el).slice(0, 120) || undefined,
      text: isButton ? text.slice(0, 80) : undefined,
      sends: sends || undefined,
      required: el.required || el.getAttribute('aria-required') === 'true' || undefined,
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || undefined,
      maxLength: el.maxLength > 0 ? el.maxLength : undefined,
      value: ['checkbox', 'radio'].includes(type) ? el.checked : tag === 'select' ? clean(el.selectedOptions[0]?.text) : el.value?.slice(0, 60) || undefined,
      options: tag === 'select' ? [...el.options].slice(0, 60).map((o) => clean(o.text)) : undefined,
    });
  }
  return { text: clean(document.body?.innerText).slice(0, 6000), controls };
}

// Reads a control fresh just before clicking it, because fills earlier in the
// same step can change it (a "Next" button that turns into "Submit claim").
async function wouldSend(frame, index) {
  return frame.locator(`[data-cb="${index}"]`).first().evaluate((el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || (tag === 'button' ? 'submit' : '')).toLowerCase();
    if (el.form && ((tag === 'button' && type === 'submit') || (tag === 'input' && ['submit', 'image'].includes(type)))) {
      return { submitsForm: true, buttonLike: true, words: '' };
    }
    const buttonLike = tag === 'button' || (tag === 'input' && ['button', 'reset'].includes(type)) || el.getAttribute('role') === 'button';
    const words = [el.innerText, el.value, el.getAttribute('aria-label'), el.getAttribute('alt'), el.getAttribute('title')].filter(Boolean).join(' ');
    return { submitsForm: false, buttonLike, words };
  }, null, { timeout: 5000 }).catch(() => ({ submitsForm: false, buttonLike: false, words: '' }));
}

// Many airlines embed the claim form in an iframe, so work in whichever frame
// has the most form fields.
async function inspect(page) {
  let best = { frame: page.mainFrame(), count: -1 };
  for (const frame of page.frames()) {
    const count = await frame.locator('input:not([type=hidden]), select, textarea').count().catch(() => 0);
    if (count > best.count) best = { frame, count };
  }
  const snapshot = await best.frame.evaluate(markControls).catch(() => ({ text: '', controls: [] }));
  return { frame: best.frame, ...snapshot };
}

// Heavy airline sites can take over a minute to fire DOMContentLoaded, so never
// wait long for it; the fields are usually usable well before.
async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(2000);
}

async function perform(frame, index, { op, value }) {
  const el = frame.locator(`[data-cb="${index}"]`).first();
  const timeout = 8000;
  if (op === 'fill') return el.fill(value, { timeout });
  if (op === 'check') return el.check({ timeout, force: true });
  if (op === 'click') return el.click({ timeout });
  if (op === 'select') {
    try {
      return await el.selectOption({ label: value }, { timeout });
    } catch {
      return el.selectOption(value, { timeout });
    }
  }
}

async function screenshot(page, emit, step, caption) {
  const shot = await page.screenshot({ type: 'jpeg', quality: 55 }).catch(() => null);
  if (shot) emit({ type: 'shot', step, image: shot.toString('base64'), caption });
}

export async function fillClaimForm({ page, url, facts, emit, step }) {
  // Consent tools often load after the page, so look for a banner again before
  // every inspection and screenshot, not just once.
  const clearConsent = async (waitMs = 0) => {
    const label = await dismissConsent(page, waitMs);
    if (label) {
      emit({ type: 'action', step, op: 'click', label: `${label} (cookie banner)`, value: '' });
      await page.waitForTimeout(800);
    }
    return label;
  };

  await page.addInitScript(lockSubmissions);
  await page.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  await page.goto(url, { waitUntil: 'commit', timeout: 60_000 });
  if (!(await waitForPage(page, 30_000))) {
    emit({ type: 'note', step, text: 'The page was still blank after 30 seconds, so it was reloaded.' });
    await page.reload({ waitUntil: 'commit', timeout: 60_000 }).catch(() => {});
    await waitForPage(page, 30_000);
  }
  // Only sites with a consent tool are worth waiting on for their banner.
  const hasConsentTool = (await page.locator(CONSENT_TOOLS).count().catch(() => 0)) > 0;
  // Some consent tools re-render the page after a choice is made.
  if (await clearConsent(hasConsentTool ? 8000 : 1500)) await waitForPage(page, 10_000);
  await screenshot(page, emit, step, 'The claim form, opened in Anakin’s cloud browser.');

  const filled = [];
  const fieldCount = () => filled.filter((f) => f.op !== 'click').length;
  const stoppedAtSubmit = () => `Filled ${fieldCount()} field${fieldCount() === 1 ? '' : 's'} and stopped at the submit button. Claimback never sends a claim for you.`;
  let reason = `Worked through ${MAX_PAGES} pages without reaching the submit button.`;

  for (let round = 1; round <= MAX_PAGES; round++) {
    await clearConsent();
    const attemptsBefore = await blockedSubmits(page);
    const { frame, text, controls } = await inspect(page);
    const decision = await askJson({
      system: SYSTEM,
      prompt: JSON.stringify({ data: facts, url: page.url(), title: await page.title().catch(() => ''), pageText: text, controls }),
      schema: STEP_SCHEMA,
    });
    emit({ type: 'thought', step, text: decision.summary });

    let atSubmit = false;
    for (const action of decision.actions) {
      const control = controls.find((c) => c.i === action.index);
      if (!control) continue;
      const name = control.label || control.text || `${control.tag} #${control.i}`;
      if (action.op === 'click') {
        const target = await wouldSend(frame, control.i);
        if (target.submitsForm || (target.buttonLike && SENDS.test(target.words))) {
          atSubmit = true;
          break;
        }
      }
      try {
        await perform(frame, control.i, action);
        filled.push({ op: action.op, field: name, value: action.value });
        emit({ type: 'action', step, op: action.op, label: name, value: action.op === 'fill' || action.op === 'select' ? action.value : '' });
      } catch (err) {
        emit({ type: 'note', step, text: `Couldn't ${action.op} “${name}”: ${err.message.split('\n')[0]}` });
      }
      if (action.op === 'click') break; // the page may have changed, so look again
    }

    await settle(page);
    // A click, a select or a script can try to submit even when no control
    // looked like a send button. The lock stopped it; treat it as the end.
    if ((await blockedSubmits(page)) > attemptsBefore) atSubmit = true;
    await clearConsent();
    await screenshot(page, emit, step, decision.summary);

    if (atSubmit || (decision.stop && /ready to submit/i.test(decision.stopReason))) {
      reason = stoppedAtSubmit();
      break;
    }
    if (decision.stop) {
      reason = decision.stopReason || 'Stopped.';
      break;
    }
    if (!decision.actions.length) {
      reason = 'Nothing more to do on this page.';
      break;
    }
  }
  return { filled, reason, finalUrl: page.url() };
}
