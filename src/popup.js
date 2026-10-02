/* Popup: triggers a fill/preview in every frame of the active tab and aggregates
   the reports that come back. */

const $ = (id) => document.getElementById(id);
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
  try {
    // Fires into every frame. Frames with nothing to report stay silent, so the
    // absence of a response is not an error.
    await chrome.tabs.sendMessage(tab.id, { type, opts });
  } catch {
    // Content script not injected (page loaded before install, or a blocked origin).
  }

  setTimeout(() => {
    collecting = false;
    $('preview').disabled = $('fill').disabled = false;
    render(type);
  }, COLLECT_WINDOW_MS);
}

function render(type) {
  const entries = collected.flatMap((r) => r.entries || []);
  const results = $('results');
  results.innerHTML = '';

  if (!entries.length) {
    $('status').textContent =
      'No form fields found. If the page was already open when you installed the extension, reload it and try again.';
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
