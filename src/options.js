/* Options page: edit the profile, the saved-answer library, and behaviour settings. */

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.appendChild(c);
  return node;
};

let state = null;

function renderProfile() {
  const host = $('profile');
  host.innerHTML = '';

  for (const group of JA.SCHEMA) {
    const grid = el('div', { className: 'grid' });
    for (const f of group.fields) {
      const label = el('label', { className: 'f' });
      label.append(document.createTextNode(f.label));

      let input;
      if (f.type === 'yesno') {
        input = el('select');
        for (const v of ['', 'Yes', 'No']) input.appendChild(el('option', { value: v, textContent: v || '— not set —' }));
      } else {
        input = el('input', { type: f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : 'text' });
      }
      input.id = `p_${f.key}`;
      input.value = state.profile[f.key] ?? '';
      label.appendChild(input);
      if (f.hint) label.appendChild(el('span', { className: 'hint', textContent: f.hint }));
      grid.appendChild(label);
    }
    host.appendChild(el('fieldset', {}, [el('legend', { textContent: group.group }), grid]));
  }
}

function snippetCard(s, index) {
  const card = el('div', { className: 'snippet' });

  const labelField = el('label', { className: 'f' });
  labelField.append(document.createTextNode('Name'));
  const labelInput = el('input', { type: 'text', value: s.label || '', className: 'sn-label' });
  labelField.appendChild(labelInput);

  const remove = el('button', { className: 'danger', type: 'button', textContent: 'Remove' });
  remove.addEventListener('click', () => {
    state.snippets.splice(index, 1);
    renderSnippets();
  });

  card.appendChild(el('div', { className: 'top' }, [labelField, remove]));

  const trigField = el('label', { className: 'f' });
  trigField.append(document.createTextNode('Trigger phrases (one per line)'));
  const trigInput = el('textarea', {
    className: 'sn-triggers',
    value: (s.triggers || []).join('\n'),
    style: 'min-height:70px',
  });
  trigField.appendChild(trigInput);
  trigField.appendChild(
    el('span', {
      className: 'hint',
      textContent: 'Multi-word phrases match far more reliably than single keywords.',
    })
  );
  card.appendChild(trigField);

  const ansField = el('label', { className: 'f' });
  ansField.append(document.createTextNode('Answer'));
  const ansInput = el('textarea', { className: 'sn-answer', value: s.answer || '' });
  ansField.appendChild(ansInput);
  card.appendChild(ansField);

  card._read = () => ({
    id: s.id || `snippet-${Date.now()}-${index}`,
    label: labelInput.value.trim() || 'Untitled',
    triggers: trigInput.value
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean),
    answer: ansInput.value,
  });

  return card;
}

function renderSnippets() {
  const host = $('snippets');
  host.innerHTML = '';
  state.snippets.forEach((s, i) => host.appendChild(snippetCard(s, i)));
}

function renderSettings() {
  $('snippetThreshold').value = state.settings.snippetThreshold;
  $('highlightFilled').value = String(state.settings.highlightFilled);
}

/** Pull the current DOM values back into `state`. */
function collect() {
  for (const key of JA.PROFILE_KEYS) {
    const input = $(`p_${key}`);
    if (input) state.profile[key] = input.value.trim();
  }
  state.snippets = Array.from($('snippets').children).map((card) => card._read());
  state.settings.snippetThreshold = Number($('snippetThreshold').value) || JA.DEFAULT_SETTINGS.snippetThreshold;
  state.settings.highlightFilled = $('highlightFilled').value === 'true';
}

function flash(message) {
  $('saved').textContent = message;
  setTimeout(() => {
    $('saved').textContent = '';
  }, 2500);
}

$('save').addEventListener('click', async () => {
  collect();
  await JA.save(state);
  flash('Saved.');
});

$('addSnippet').addEventListener('click', () => {
  collect();
  state.snippets.push({ id: `snippet-${Date.now()}`, label: '', triggers: [], answer: '' });
  renderSnippets();
});

$('export').addEventListener('click', () => {
  collect();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'apply-autofill-profile.json' });
  a.click();
  URL.revokeObjectURL(a.href);
});

$('importBtn').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    state = {
      profile: { ...JA.DEFAULT_PROFILE, ...(parsed.profile || {}) },
      snippets: Array.isArray(parsed.snippets) ? parsed.snippets : state.snippets,
      settings: { ...JA.DEFAULT_SETTINGS, ...(parsed.settings || {}) },
    };
    renderProfile();
    renderSnippets();
    renderSettings();
    await JA.save(state);
    flash('Imported and saved.');
  } catch (err) {
    flash(`Could not read that file: ${err.message}`);
  }
  e.target.value = '';
});

$('reset').addEventListener('click', async () => {
  if (!confirm('Replace your profile, saved answers and settings with the built-in defaults? This cannot be undone.')) return;
  state = {
    profile: { ...JA.DEFAULT_PROFILE },
    snippets: JSON.parse(JSON.stringify(JA.DEFAULT_SNIPPETS)),
    settings: { ...JA.DEFAULT_SETTINGS },
  };
  await JA.save(state);
  renderProfile();
  renderSnippets();
  renderSettings();
  flash('Reset to defaults.');
});

(async function init() {
  state = await JA.load();
  renderProfile();
  renderSnippets();
  renderSettings();
})();
