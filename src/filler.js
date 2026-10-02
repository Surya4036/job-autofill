/* DOM writing. Everything here is about making a value stick in frameworks that
   control their own inputs (React, Vue, Angular) — a naive `el.value = x` is silently
   reverted by React because it never sees a change event it believes in. */

const JA = (self.JA = self.JA || {});

JA.isVisible = function isVisible(el) {
  if (!el || el.disabled || el.readOnly) return false;
  if (el.type === 'hidden') return false;
  if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  // Radios and checkboxes are routinely 0x0 with a styled label on top, so allow those.
  if (rect.width === 0 && rect.height === 0 && el.type !== 'radio' && el.type !== 'checkbox') return false;
  return true;
};

/** Write through the native setter so React's value tracker sees a real change. */
function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value');
  if (setter && setter.set) setter.set.call(el, value);
  else el.value = value;
}

function fire(el, events) {
  for (const type of events) {
    el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  }
}

/** Fill a text-like input or textarea. */
JA.fillText = function fillText(el, value) {
  el.focus({ preventScroll: true });
  setNativeValue(el, '');
  fire(el, ['input']);
  setNativeValue(el, value);
  fire(el, ['input', 'change']);
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
  el.blur();
  return el.value === value;
};

const norm = (s) => JA.words(s);

/** Score how well an option matches the value we want. */
function optionScore(optionText, optionValue, want) {
  const w = norm(want);
  if (!w) return 0;
  for (const cand of [norm(optionText), norm(optionValue)]) {
    if (!cand) continue;
    if (cand === w) return 100;
    if (cand.startsWith(w) || w.startsWith(cand)) return 70;
    if (cand.includes(w) || w.includes(cand)) return 50;
  }
  return 0;
}

/** Pick the closest <option> for a value. Yes/No answers match strictly so that
 *  "No" never lands on "Not specified" or "None of the above". */
JA.fillSelect = function fillSelect(el, value) {
  const strict = /^(yes|no)$/i.test(value.trim());
  let best = null;
  for (const opt of Array.from(el.options)) {
    if (!opt.value && !opt.textContent.trim()) continue;
    const score = optionScore(opt.textContent, opt.value, value);
    const min = strict ? 100 : 50;
    if (score >= min && (!best || score > best.score)) best = { opt, score };
  }
  if (!best) return false;
  el.focus({ preventScroll: true });
  el.value = best.opt.value;
  fire(el, ['input', 'change']);
  el.blur();
  return true;
};

/** Click the radio in this group whose label matches the value. */
JA.fillRadioGroup = function fillRadioGroup(radios, value) {
  const strict = /^(yes|no)$/i.test(value.trim());
  let best = null;
  for (const radio of radios) {
    const label = JA.optionLabel(radio);
    const score = Math.max(optionScore(label, radio.value, value), optionScore(radio.value, '', value));
    const min = strict ? 100 : 50;
    if (score >= min && (!best || score > best.score)) best = { radio, score };
  }
  if (!best) return false;
  best.radio.click();
  if (!best.radio.checked) {
    best.radio.checked = true;
    fire(best.radio, ['input', 'change']);
  }
  return best.radio.checked;
};

JA.fillCheckbox = function fillCheckbox(el, value) {
  const want = /^(yes|true|1|y)$/i.test(String(value).trim());
  if (el.checked === want) return true;
  el.click();
  if (el.checked !== want) {
    el.checked = want;
    fire(el, ['input', 'change']);
  }
  return el.checked === want;
};

/** Reformat a YYYY-MM-DD date to whatever the field appears to expect. */
JA.formatDate = function formatDate(iso, el) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
  if (!m) return iso;
  const [, y, mo, d] = m;
  if (el.type === 'date') return iso;

  const hintSource = `${el.placeholder || ''} ${el.getAttribute('title') || ''} ${JA.questionText(el)}`.toLowerCase();
  if (/dd\s*[/.-]\s*mm\s*[/.-]\s*yyyy/.test(hintSource)) return `${d}/${mo}/${y}`;
  if (/yyyy\s*[/.-]\s*mm\s*[/.-]\s*dd/.test(hintSource)) return `${y}/${mo}/${d}`;
  if (/mm\s*[/.-]\s*dd\s*[/.-]\s*yyyy/.test(hintSource)) return `${mo}/${d}/${y}`;
  return `${mo}/${d}/${y}`; // most common default on US-hosted ATS forms
};

JA.highlight = function highlight(el, ok) {
  const prev = el.style.outline;
  el.style.outline = ok ? '2px solid #16a34a' : '2px solid #f59e0b';
  el.style.outlineOffset = '1px';
  setTimeout(() => {
    el.style.outline = prev;
  }, 2500);
};
