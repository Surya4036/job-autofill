/* Popup: triggers a fill/preview in every frame of the active tab and aggregates
   the reports that come back. */

const $ = (id) => document.getElementById(id);
const FIRST_WINDOW_MS = 500; // long enough for an already-live content script to answer
const COLLECT_WINDOW_MS = 1200;

let collected = [];
let collecting = false;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'JA_REPORT' && collecting) collected.push(msg.report);
});

(async function initOptions() {
  const { settings } = await JA.load();
  $('overwrite').checked = settings.overwriteExisting;
  $('useSnippets').checked = settings.useSnippets;
})();

for (const id of ['overwrite', 'useSnippets']) {
  $(id).addEventListener('change', async () => {
    const { settings } = await JA.load();
    await JA.save({
      settings: { ...settings, overwriteExisting: $('overwrite').checked, useSnippets: $('useSnippets').checked },
    });
  });
}

$('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$('preview').addEventListener('click', () => dispatch('JA_SCAN'));
$('fill').addEventListener('click', () => dispatch('JA_FILL'));

async function dispatch(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/.test(tab.url || '')) {
    $('status').textContent = 'This page is not a normal web page, so the extension cannot run here.';
    return;
  }

  collected = [];
  collecting = true;
  $('preview').disabled = $('fill').disabled = true;
  $('status').textContent = type === 'JA_SCAN' ? 'Scanning…' : 'Filling…';
  $('results').innerHTML = '';

  const opts = { overwrite: $('overwrite').checked, useSnippets: $('useSnippets').checked };
  const send = async () => {
    try {
      // Fires into every frame. Frames with nothing to report stay silent, so the
      // absence of a response is not an error.
      await chrome.tabs.sendMessage(tab.id, { type, opts });
    } catch {
      // No live listener: handled by the injection fallback below.
    }
  };

  await send();
  await wait(FIRST_WINDOW_MS);

  // Silence usually means the page has no live content script — it was open before the
  // extension was installed or reloaded. Inject and ask again rather than making the
  // user reload the page.
  if (!collected.length) {
    $('status').textContent = 'Starting up on this page…';
    if (await injectContentScripts(tab.id)) await send();
  }

  await wait(COLLECT_WINDOW_MS);
  collecting = false;
  $('preview').disabled = $('fill').disabled = false;
  render(type);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function injectContentScripts(tabId) {
  try {
    const files = chrome.runtime.getManifest().content_scripts[0].js;
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files });
    return true;
  } catch {
    // Injection is blocked on chrome:// pages, the Web Store, and PDF viewers.
    return false;
  }
}

function render(type) {
  const entries = collected.flatMap((r) => r.entries || []);
  const results = $('results');
  results.innerHTML = '';

  if (!entries.length) {
    $('status').textContent =
      'No fillable form fields found on this page. If the form is inside an embedded widget this extension cannot reach, open it in its own tab.';
    return;
  }

  const done = entries.filter((e) => e.status === 'filled' || e.status === 'would-fill');
  const attention = entries.filter((e) => ['failed', 'manual', 'no-data'].includes(e.status));
  const skipped = entries.filter((e) => e.status === 'skipped-filled');
  const unmatched = entries.filter((e) => e.status === 'no-match');

  const verb = type === 'JA_SCAN' ? 'would fill' : 'filled';
  const bits = [`${done.length} ${verb}`];
  if (skipped.length) bits.push(`${skipped.length} already had values`);
  if (attention.length) bits.push(`${attention.length} need you`);
  $('status').textContent = `${bits.join(' · ')}.`;

  section(results, verb === 'filled' ? 'Filled' : 'Would fill', done, 'ok', (e) => [
    e.question,
    [e.source || e.key, e.value].filter(Boolean).join(' → '),
  ]);
  section(results, 'Needs your attention', attention, 'warn', (e) => [e.question, e.note || e.status]);
  section(results, 'Left alone (already filled)', skipped, '', (e) => [e.question, e.source || e.key || '']);
  section(results, 'No saved answer', unmatched, '', (e) => [e.question, 'Add an answer on the options page']);
}

function section(parent, title, entries, cls, lines) {
  if (!entries.length) return;
  const sec = document.createElement('section');
  const h = document.createElement('h2');
  h.textContent = `${title} (${entries.length})`;
  sec.appendChild(h);
  const ul = document.createElement('ul');
  for (const e of entries) {
    const [q, v] = lines(e);
    const li = document.createElement('li');
    if (cls) li.className = cls;
    const qd = document.createElement('div');
    qd.className = 'q';
    qd.textContent = q || '(unlabelled field)';
    li.appendChild(qd);
    if (v) {
      const vd = document.createElement('div');
      vd.className = 'v';
      vd.textContent = v;
      li.appendChild(vd);
    }
    ul.appendChild(li);
  }
  sec.appendChild(ul);
  parent.appendChild(sec);
}
