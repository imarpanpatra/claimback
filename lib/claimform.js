// Drives the airline's claim form in Anakin's cloud browser. The model decides
// what goes where; this module does the typing and enforces the one hard rule:
// never press the button that actually sends the claim.
import { askJson } from './llm.js';

const MAX_PAGES = 6;
const FINAL_BUTTON = /\b(submit|send|confirm|pay|purchase|place|finish|complete|file)\b/i;

const SYSTEM = `You are filling in an airline's compensation claim form for a passenger, one page at a time.
You get the page's visible text and a numbered list of its controls.
- Dismiss cookie or consent banners first, preferring "reject" or "necessary only".
- On an information page, click the link or button that starts the claim.
- Fill every field you have data for. For selects use the exact option text. For date inputs use YYYY-MM-DD.
- Respect maxLength, and don't retype a prefix the page already shows next to a field (a ticket field showing 098 only needs the digits after 098).
- Skip disabled controls.
- Put fills before any click, and click at most one thing per step.
- Never click a button that submits, sends, confirms or pays. Set stop to true with stopReason "Ready to submit" instead.
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

// Consent banners cover the form and swallow clicks, and models tend to skip
// them, so clear them in code. Rejecting is the only choice this code makes.
const CONSENT_SELECTORS = ['#onetrust-reject-all-handler', '#didomi-notice-disagree-button', '[data-testid="uc-deny-all-button"]'];
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

// True once some frame shows at least two usable fields below the site header.
// A bare "an input exists" check passes on the header's search box long before
// the claim form itself has rendered.
async function waitForForm(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const count = await frame.evaluate(() => [...document.querySelectorAll('input, select, textarea')].filter((el) => {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (['hidden', 'search', 'submit', 'button', 'checkbox', 'radio'].includes(type)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1 && r.top + window.scrollY > 150;
      }).length).catch(() => 0);
      if (count >= 2) return true;
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
    return clean(el.getAttribute('aria-label') || (by && document.getElementById(by)?.innerText) || el.getAttribute('placeholder') || el.getAttribute('title') || el.name || '');
  };

  const controls = [];
  const nodes = document.querySelectorAll('input, select, textarea, button, a, [role="button"], [role="checkbox"], [role="radio"], [role="combobox"]');
  for (const el of nodes) {
    if (controls.length >= 150) break;
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag;
    if (type === 'hidden' || !visible(el)) continue;
    const text = clean(el.innerText || el.value || '');
    if (tag === 'a' && !/claim|compensation|delay|disrupt|refund|start|continue|next|form|accept|reject|agree/i.test(text)) continue;

    const i = controls.length;
    el.setAttribute('data-cb', String(i));
    const isButton = tag === 'button' || tag === 'a' || type === 'submit' || el.getAttribute('role') === 'button';
    controls.push({
      i,
      tag,
      type,
      label: labelOf(el).slice(0, 120) || undefined,
      text: isButton ? text.slice(0, 80) : undefined,
      required: el.required || el.getAttribute('aria-required') === 'true' || undefined,
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || undefined,
      maxLength: el.maxLength > 0 ? el.maxLength : undefined,
      value: ['checkbox', 'radio'].includes(type) ? el.checked : tag === 'select' ? clean(el.selectedOptions[0]?.text) : el.value?.slice(0, 60) || undefined,
      options: tag === 'select' ? [...el.options].slice(0, 60).map((o) => clean(o.text)) : undefined,
    });
  }
  return { text: clean(document.body?.innerText).slice(0, 6000), controls };
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

  await page.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  await page.goto(url, { waitUntil: 'commit', timeout: 60_000 });
  if (!(await waitForForm(page, 30_000))) {
    emit({ type: 'note', step, text: 'The form hadn’t appeared after 30 seconds, so the page was reloaded.' });
    await page.reload({ waitUntil: 'commit', timeout: 60_000 }).catch(() => {});
    await waitForForm(page, 30_000);
  }
  // Some consent tools re-render the page after a choice is made.
  if (await clearConsent(8000)) await waitForForm(page, 10_000);
  await screenshot(page, emit, step, 'The claim form, opened in Anakin’s cloud browser.');

  const filled = [];
  const fieldCount = () => filled.filter((f) => f.op !== 'click').length;
  const stoppedAtSubmit = () => `Filled ${fieldCount()} field${fieldCount() === 1 ? '' : 's'} and stopped at the submit button. Claimback never sends a claim for you.`;
  let reason = `Worked through ${MAX_PAGES} pages without reaching the submit button.`;

  for (let round = 1; round <= MAX_PAGES; round++) {
    await clearConsent();
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
      if (action.op === 'click' && FINAL_BUTTON.test(control.text ?? '')) {
        atSubmit = true;
        break;
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
