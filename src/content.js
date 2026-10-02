/* Orchestration. Runs in every frame — ATS forms are often iframed (Greenhouse, Lever),
   so each frame independently fills what it can and reports back to the popup. */

const JA = (self.JA = self.JA || {});

const FILLABLE = 'input, textarea, select';
const IGNORED_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'password', 'search']);

/** Collect controls across the document and any open shadow roots. */
function collectControls() {
  const out = [];
  const seen = new Set();

  const walk = (root) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    for (const el of root.querySelectorAll(FILLABLE)) out.push(el);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };

  walk(document);
  return out;
}

/** True if the control already holds a user-meaningful value. */
function hasValue(el) {
  if (el.type === 'radio' || el.type === 'checkbox') return el.checked;
  if (el.tagName === 'SELECT') {
    const opt = el.selectedOptions[0];
    return Boolean(el.value) && Boolean(opt && opt.textContent.trim()) && el.selectedIndex > 0;
  }
  return Boolean(el.value && el.value.trim());
}

function previewOf(value) {
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

/** A control can take a long snippet only if it is a textarea or a roomy text input. */
function acceptsLongText(el) {
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  if (!['text', '', 'textarea'].includes(el.type)) return false;
  const max = Number(el.getAttribute('maxlength') || 0);
  return max === 0 || max >= 200;
}

async function run(opts) {
  const { profile, snippets, settings } = await JA.load();
  const overwrite = opts.overwrite ?? settings.overwriteExisting;
  const useSnippets = opts.useSnippets ?? settings.useSnippets;
  const dryRun = Boolean(opts.dryRun);

  const report = { url: location.href, frame: window === window.top ? 'main' : location.href, entries: [] };

  // For a radio or checkbox, the useful description is the group's question, not the
  // option's own "Yes" label.
  const describe = (el) => {
    const isChoice = el.type === 'radio' || el.type === 'checkbox';
    return previewOf((isChoice && JA.groupQuestion(el)) || JA.questionText(el) || el.name || el.id);
  };
  const add = (status, el, extra) => report.entries.push({ status, question: describe(el), ...extra });

  const controls = collectControls();
  const handledRadioGroups = new Set();

  for (const el of controls) {
    const type = (el.type || '').toLowerCase();

    if (el.tagName === 'INPUT' && type === 'file') {
      add('manual', el, { note: 'File upload — attach this yourself (resume, cover letter).' });
      continue;
    }
    if (IGNORED_TYPES.has(type)) continue;
    if (!JA.isVisible(el)) continue;

    // --- long free-text questions: saved answers win over short profile values ---
    if (useSnippets && acceptsLongText(el)) {
      const hit = JA.matchSnippet(JA.questionText(el), snippets, settings.snippetThreshold);
      if (hit) {
        if (hasValue(el) && !overwrite) {
          add('skipped-filled', el, { source: `snippet: ${hit.snippet.label}` });
          continue;
        }
        if (dryRun) {
          add('would-fill', el, { source: `snippet: ${hit.snippet.label}`, value: previewOf(hit.snippet.answer), score: hit.score });
          continue;
        }
        const ok = JA.fillText(el, hit.snippet.answer);
        if (settings.highlightFilled) JA.highlight(el, ok);
        add(ok ? 'filled' : 'failed', el, { source: `snippet: ${hit.snippet.label}`, value: previewOf(hit.snippet.answer), score: hit.score });
        continue;
      }
    }

    // --- structured profile fields ---
    const match = JA.classify(el);
    if (!match) {
      if (el.tagName === 'TEXTAREA') add('no-match', el, { note: 'Free-text question with no saved answer.' });
      continue;
    }

    let value = profile[match.key];
    if (value == null || String(value).trim() === '') {
      add('no-data', el, { key: match.key, note: `Profile field "${match.key}" is empty.` });
      continue;
    }
    value = String(value).trim();

    if (match.key === 'dob') value = JA.formatDate(value, el);

    // Radio groups are handled once per group, not once per radio.
    if (type === 'radio') {
      const container = el.closest('fieldset,[role="radiogroup"]') || el.parentElement;
      // Unnamed groups key off their container element so separate groups stay separate.
      const groupKey = el.name ? `name:${el.name}` : container;
      if (handledRadioGroups.has(groupKey)) continue;
      handledRadioGroups.add(groupKey);

      const scope = el.getRootNode();
      const radios = el.name
        ? Array.from(scope.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`))
        : Array.from((container || scope).querySelectorAll('input[type="radio"]'));

      if (radios.some((x) => x.checked) && !overwrite) {
        add('skipped-filled', el, { key: match.key });
        continue;
      }
      if (dryRun) {
        add('would-fill', el, { key: match.key, value });
        continue;
      }
      const ok = JA.fillRadioGroup(radios, value);
      if (ok && settings.highlightFilled) JA.highlight(radios[0], true);
      add(ok ? 'filled' : 'failed', el, { key: match.key, value, note: ok ? undefined : `No option matched "${value}".` });
      continue;
    }

    if (hasValue(el) && !overwrite) {
      add('skipped-filled', el, { key: match.key });
      continue;
    }
    if (dryRun) {
      add('would-fill', el, { key: match.key, value });
      continue;
    }

    let ok = false;
    if (el.tagName === 'SELECT') ok = JA.fillSelect(el, value);
    else if (type === 'checkbox') ok = JA.fillCheckbox(el, value);
    else ok = JA.fillText(el, value);

    if (settings.highlightFilled) JA.highlight(el, ok);
    add(ok ? 'filled' : 'failed', el, {
      key: match.key,
      value: previewOf(value),
      note: ok ? undefined : el.tagName === 'SELECT' ? `No option matched "${value}".` : 'The page rejected the value.',
    });
  }

  return report;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || (msg.type !== 'JA_FILL' && msg.type !== 'JA_SCAN')) return;
  run({ ...msg.opts, dryRun: msg.type === 'JA_SCAN' })
    .then((report) => {
      // Quiet frames (ads, trackers, chrome) shouldn't clutter the popup.
      if (report.entries.length === 0) return;
      chrome.runtime.sendMessage({ type: 'JA_REPORT', report }).catch(() => {});
    })
    .catch((err) => {
      chrome.runtime.sendMessage({ type: 'JA_REPORT', report: { error: String(err), entries: [] } }).catch(() => {});
    });
  // No synchronous response — reports arrive via JA_REPORT so every frame can answer.
});
