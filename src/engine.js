/* The fill engine. Deliberately free of chrome.* APIs so the same code runs inside the
   extension's content script and inside a Playwright-driven page. All configuration is
   passed in; nothing is read from storage here. */

var JA = (self.JA = self.JA || {}); // var, not const: content scripts share one global scope

const FILLABLE = 'input, textarea, select';
const IGNORED_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'password', 'search']);
const OTHER_DOCUMENT = /cover letter|covering letter|portfolio|transcript|certificate|photo|passport|payslip|id proof/;

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

/**
 * Fill the current document.
 *
 * config:
 *   profile, snippets, settings  — the saved data
 *   overwrite    replace values the page already has
 *   useSnippets  allow saved answers into free-text questions
 *   dryRun       report only, change nothing
 *   resumeFile   { name, type, dataUrl? } — dataUrl needed only to attach in-page
 *   tagFiles     mark file inputs with data-ja-file instead of attaching, so an
 *                external driver (Playwright) can attach them natively
 *
 * Returns a report; synchronous so a driver can call it in one page.evaluate().
 */
JA.run = function run(config) {
  const { profile, snippets, settings, resumeFile } = config;
  const overwrite = Boolean(config.overwrite);
  const useSnippets = config.useSnippets !== false;
  const dryRun = Boolean(config.dryRun);
  const tagFiles = Boolean(config.tagFiles);
  // Green outlines are useful in driver screenshots too, so this is not gated on tagFiles.
  const highlight = Boolean(settings.highlightFilled);

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

    // File inputs are handled before the visibility check on purpose: ATS forms routinely
    // hide the real input behind a styled button, and a hidden input still accepts a file.
    if (el.tagName === 'INPUT' && type === 'file') {
      const label = JA.words(`${describe(el)} ${el.name || ''} ${el.id || ''}`);
      const wantsOtherDocument = OTHER_DOCUMENT.test(label) && !/resume|\bcv\b/.test(label);

      // Driver mode: label the input and let Playwright's set_input_files do the work.
      // Native attachment survives uploaders that reject a synthetic DataTransfer.
      if (tagFiles) {
        let kind = 'resume';
        let note = 'Resume upload — the driver attaches this natively.';
        if (wantsOtherDocument) {
          kind = 'other';
          note = 'Asks for a document other than your resume.';
        } else if (resumeFile && !JA.acceptsFile(el, resumeFile.name, resumeFile.type)) {
          kind = 'unsupported';
          note = `Only accepts ${el.getAttribute('accept')} — your resume is ${resumeFile.name}.`;
        }
        el.setAttribute('data-ja-file', kind);
        add(kind === 'resume' ? 'needs-file' : 'manual', el, { tag: kind, note });
        continue;
      }

      if (!resumeFile || !resumeFile.dataUrl) {
        add('manual', el, { note: 'File upload — save a resume on the options page to automate this.' });
        continue;
      }
      if (wantsOtherDocument) {
        add('manual', el, { note: 'Asks for a document other than your resume — attach manually.' });
        continue;
      }
      if (!JA.acceptsFile(el, resumeFile.name, resumeFile.type)) {
        add('manual', el, { note: `Only accepts ${el.getAttribute('accept')} — your saved resume is ${resumeFile.name}.` });
        continue;
      }
      if (el.files && el.files.length && !overwrite) {
        add('skipped-filled', el, { source: 'resume' });
        continue;
      }
      if (dryRun) {
        add('would-fill', el, { source: 'saved resume', value: resumeFile.name });
        continue;
      }
      const attached = JA.fillFile(el, resumeFile);
      if (attached && highlight) JA.highlight(el, true);
      add(attached ? 'filled' : 'manual', el, {
        source: 'saved resume',
        value: resumeFile.name,
        note: attached ? undefined : 'This page would not accept a programmatic attachment — attach manually.',
      });
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
        if (highlight) JA.highlight(el, ok);
        add(ok ? 'filled' : 'failed', el, { source: `snippet: ${hit.snippet.label}`, value: previewOf(hit.snippet.answer), score: hit.score });
        continue;
      }
    }

    // --- structured profile fields ---
    const match = JA.classify(el);
    if (!match) {
      if (el.tagName === 'TEXTAREA') {
        add('no-match', el, { note: 'Free-text question with no saved answer.' });
      } else if (type === 'checkbox' && !el.checked) {
        // Certifications, consents and opt-ins are the user's to give, never ours to tick.
        // Reporting them matters: an unticked required agreement blocks submission.
        add('manual', el, { note: 'Tick this yourself — agreements and consents are yours to give.' });
      }
      continue;
    }

    let value = profile[match.key];
    if (value == null || String(value).trim() === '') {
      add('no-data', el, { key: match.key, note: `Profile field "${match.key}" is empty.` });
      continue;
    }
    value = String(value).trim();

    // Any ISO date in the profile (birth date, earliest start date) gets reformatted
    // to whatever order this particular field expects.
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) value = JA.formatDate(value, el);

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
      if (ok && highlight) JA.highlight(radios[0], true);
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

    if (highlight) JA.highlight(el, ok);
    add(ok ? 'filled' : 'failed', el, {
      key: match.key,
      value: previewOf(value),
      note: ok ? undefined : el.tagName === 'SELECT' ? `No option matched "${value}".` : 'The page rejected the value.',
    });
  }

  return report;
};
