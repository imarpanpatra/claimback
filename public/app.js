const $ = (selector) => document.querySelector(selector);
const timeline = $('#timeline');
const resultBox = $('#result');
const creditsEl = $('#credits');
const PHASES = { read: 'Read', reason: 'Reason', act: 'Act' };

const steps = new Map();
let lastStep = null;
let source = null;
let cancelReplay = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function append(stepId, node) {
  const target = steps.get(stepId) ?? lastStep;
  if (target) target.querySelector('.body').append(node);
  else timeline.append(el('li', { class: 'step failed' }, el('div', { class: 'body' }, node)));
}

function finishStep() {
  lastStep?.classList.remove('active');
}

function render(e) {
  switch (e.type) {
    case 'step': {
      finishStep();
      const li = el('li', { class: `step ${e.phase} active` },
        el('div', { class: 'head' }, el('span', { class: `chip ${e.phase}` }, PHASES[e.phase]), el('h3', {}, e.title)),
        el('div', { class: 'body' }));
      steps.set(e.id, li);
      lastStep = li;
      timeline.append(li);
      li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      break;
    }
    case 'tool':
      append(e.step, el('div', { class: 'tool' },
        el('span', { class: 'tool-name' }, e.name),
        el('span', { class: 'tool-detail' }, e.detail),
        e.credits ? el('span', { class: 'cost' }, `${e.credits} cr`) : null));
      break;
    case 'note':
      append(e.step, el('p', { class: e.guardrail ? `note guard ${e.guardrail}` : 'note' }, e.text));
      break;
    case 'thought':
      append(e.step, el('p', { class: 'thought' }, e.text));
      break;
    case 'source':
      append(e.step, el('blockquote', { class: 'source' },
        el('p', {}, `“${e.quote}”`),
        el('footer', {},
          el('a', { href: e.url, target: '_blank', rel: 'noopener' }, e.title || hostOf(e.url)),
          e.verified === true ? el('span', { class: 'verified' }, '✓ Quote found on the page') : null,
          e.verified === false ? el('span', { class: 'unverified' }, 'Quote not found on the page') : null)));
      break;
    case 'action':
      append(e.step, el('div', { class: 'action' }, el('span', { class: 'op' }, e.op), el('span', {}, e.label), e.value ? el('code', {}, e.value) : null));
      break;
    case 'shot':
      append(e.step, el('figure', { class: 'shot' },
        el('img', { src: `data:image/jpeg;base64,${e.image}`, alt: e.caption || 'Screenshot of the airline page', onclick: (ev) => zoom(ev.target.src) }),
        e.caption ? el('figcaption', {}, e.caption) : null));
      break;
    case 'recording':
      append(e.step, el('p', { class: 'note' }, el('a', { href: e.url, target: '_blank', rel: 'noopener' }, 'Watch the cloud-browser recording')));
      break;
    case 'letter':
      append(e.step, letterCard(e));
      break;
    case 'credits':
      creditsEl.textContent = e.total;
      break;
    case 'result':
      finishStep();
      showResult(e.claim);
      break;
    case 'error':
      lastStep?.classList.add('failed');
      append(e.step, el('p', { class: 'error' }, e.message));
      break;
    case 'end':
      finishStep();
      setBusy(false);
      break;
    default:
      break;
  }
}

function letterCard(e) {
  const copy = el('button', {
    class: 'secondary small',
    type: 'button',
    onclick: async () => {
      await navigator.clipboard.writeText(`${e.subject}\n\n${e.body}`).catch(() => {});
      copy.textContent = 'Copied';
    },
  }, 'Copy letter');
  return el('details', { class: 'letter', open: true }, el('summary', {}, e.subject), el('pre', {}, e.body), copy);
}

function showResult(c) {
  if (c.models?.length) $('#model').textContent = ` · reasoning by ${c.models.join(', ')}`;
  const f = c.flight;
  const route = f ? `${f.flight} · ${f.fromName} (${f.fromCode}) to ${f.toName} (${f.toCode}) · ${f.date}` : '';
  let card;
  if (c.verdict === 'owed' || c.verdict === 'likely') {
    card = el('div', { class: 'result' },
      el('p', { class: 'eyebrow' }, c.verdict === 'owed' ? 'You are owed' : 'You are probably owed'),
      // When the airline may halve the payment, show the range rather than
      // implying the full amount is certain.
      el('p', { class: 'amount' }, c.reducedText ? `${c.reducedText}–${c.amountText}` : c.amountText),
      c.reducedText ? el('p', { class: 'reduced' }, `${c.amountText} in full. Because you arrived between 3 and 4 hours late, the airline may pay half.`) : null,
      el('p', { class: 'route' }, route),
      el('p', {}, `Under ${c.regimeName}. ${c.reasons?.[0] ?? ''}`),
      c.filing
        ? el('p', {}, 'Claim form on ', el('a', { href: c.filing.url, target: '_blank', rel: 'noopener' }, hostOf(c.filing.url)), `: ${c.filing.reason}`)
        : null);
  } else {
    card = el('div', { class: 'result none' },
      el('p', { class: 'eyebrow' }, c.verdict === 'not_covered' ? 'No compensation law covers this flight' : 'Nothing owed this time'),
      el('p', { class: 'route' }, route),
      ...(c.reasons ?? []).map((r) => el('p', {}, r)));
  }
  resultBox.replaceChildren(card);
  resultBox.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function zoom(src) {
  const dialog = $('#zoom');
  dialog.querySelector('img').src = src;
  dialog.showModal();
}
$('#zoom').addEventListener('click', () => $('#zoom').close());

function reset() {
  cancelReplay();
  source?.close();
  steps.clear();
  lastStep = null;
  timeline.replaceChildren();
  resultBox.replaceChildren();
  creditsEl.textContent = '0';
  $('#empty').hidden = true;
}

let liveRunsAllowed = true;
function setBusy(busy) {
  $('#run-live').disabled = busy || !liveRunsAllowed;
  $('#watch-replay').disabled = busy;
}

function showError(message) {
  append(null, el('p', { class: 'error' }, message));
}

$('#claim-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const data = Object.fromEntries(new FormData(ev.target));
  reset();
  setBusy(true);
  const res = await fetch('api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: data.code,
      flightNumber: data.flightNumber,
      date: data.date,
      passenger: { fullName: data.fullName, email: data.email, bookingReference: data.bookingReference, ticketNumber: data.ticketNumber },
    }),
  }).catch(() => null);
  const body = await res?.json().catch(() => ({}));
  if (!res?.ok) {
    setBusy(false);
    showError(body?.error ?? 'Couldn’t reach the server.');
    return;
  }
  source = new EventSource(`api/runs/${body.id}/events`);
  source.onmessage = (m) => {
    const e = JSON.parse(m.data);
    render(e);
    if (e.type === 'end') source.close();
  };
  source.onerror = () => {
    source.close();
    setBusy(false);
  };
});

async function replay() {
  reset();
  setBusy(true);
  const res = await fetch('demo/featured-run.json').catch(() => null);
  if (!res?.ok) {
    setBusy(false);
    showError('There is no recorded run on this deployment yet.');
    return;
  }
  const { input, events } = await res.json();
  const form = $('#claim-form');
  form.flightNumber.value = input.flightNumber;
  form.date.value = input.date;

  let cancelled = false;
  cancelReplay = () => {
    cancelled = true;
  };
  // ?pace=2 plays the recording at half speed, which reads better on video.
  const pace = Math.min(Math.max(Number(new URLSearchParams(location.search).get('pace')) || 1, 0.25), 5);
  let previous = 0;
  for (const e of events) {
    // Keep the rhythm of the real run but squeeze the long waits.
    const gap = Math.min(Math.max(e.t - previous, 250), e.type === 'step' ? 1400 : 900) * pace;
    previous = e.t;
    await sleep(gap);
    if (cancelled) return;
    render(e);
  }
  setBusy(false);
}
$('#watch-replay').addEventListener('click', replay);

function disableLiveRuns(hint) {
  liveRunsAllowed = false;
  $('#run-live').disabled = true;
  $('#hint').replaceChildren(...hint);
}

fetch('api/config')
  .then((r) => {
    if (!r.ok) throw new Error('no server');
    return r.json();
  })
  .then((config) => {
    $('#model').textContent = ` · reasoning by ${config.model}`;
    if (!config.liveRuns) disableLiveRuns(['Live runs are switched off on this deployment. The recording is a real run, replayed.']);
  })
  .catch(async () => {
    // A static host has no server, so point to the one that runs live claims.
    const site = await fetch('site.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    disableLiveRuns(site.liveUrl
      ? ['This page plays a real recorded run. To start a live claim, use ', el('a', { href: site.liveUrl, target: '_blank', rel: 'noopener' }, 'the live version'), '.']
      : ['This page plays a real recorded run. Live claims need the Claimback server.']);
  });

if (new URLSearchParams(location.search).has('autoplay')) replay();
