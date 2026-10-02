# Apply Autofill

A Chrome extension that fills job application forms from a saved profile and a library of
reusable answers. Built because the same forty fields and the same eight essay questions
show up on every application.

No network requests. Everything lives in `chrome.storage.local`, which means it stays in
this browser profile on this machine.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this `job-autofill/` folder
4. Click the extension icon → **Edit profile & answers**, fill in the blanks (DOB, address,
   LinkedIn/GitHub, education), and **Save**

The profile ships pre-seeded from `resume-v2-backend.md`, so name, email, phone, city,
current company and notice period are already there. The empty ones are the ones only you
know.

## Use

On an application form:

1. Click the extension icon
2. **Preview** — shows what it *would* fill, changing nothing
3. **Fill this page** — fills it, briefly outlining each touched field in green

The popup then groups everything into:

- **Filled** — what went in, and where it came from
- **Needs your attention** — uploads it wouldn't guess at, dropdowns where no option matched, profile
  fields that are still empty
- **Left alone** — fields that already had values (turn on *Overwrite filled fields* to
  replace them)
- **No saved answer** — free-text questions you haven't written an answer for yet

Always read the form before submitting. The extension is a typist, not a reviewer.

## How matching works

**Structured fields** (`src/matcher.js`) — each control is reduced to one normalised string
built from its label, `aria-label`, placeholder, `name`, `id`, `autocomplete` and
`data-automation-id`. camelCase is split first, so Workday's `legalNameSection_firstName`
becomes `legal name section first name`. That string is tested against ~60 weighted rules
and the highest-weight match wins, so `Preferred First Name` beats the generic first-name
rule, and `Emergency Contact Name` matches nothing at all.

**Free-text questions** — the question text is scored against the trigger phrases on each
saved answer. A multi-word phrase found verbatim scores 3, the same words scattered through
the question score 1.5, a bare keyword scores 1. Default threshold is 2, so a single
coincidental keyword never triggers a fill. Tune it under **Behaviour** on the options page.

**Making values stick** (`src/filler.js`) — React, Vue and Angular track their own input
state and silently revert a plain `el.value = x`. Writes go through the native value setter
followed by `input` and `change` events so the framework accepts them. Selects and radio
groups are matched by option text, and `Yes`/`No` answers match strictly so `No` never
lands on "Not specified".

**Resume upload** — save the file once under **Resume file** on the options page and it's
attached to resume fields automatically. A content script can build a `DataTransfer` and
assign to `input.files`, which is the same mechanism Playwright and Cypress use. Hidden
inputs are handled too, since ATS forms habitually hide the real input behind a styled
button. Three cases are deliberately *not* attached and get reported instead: fields asking
for a different document (cover letter, transcript, photo), fields whose `accept` attribute
excludes your file type, and sites with custom uploaders that reject a programmatic
attachment.

Durations are matched numerically when wording fails, so a profile saying `2 months` picks
`60 days` out of a dropdown that only offers days. Where there's no exact equivalent it
rounds *up* — never tell an employer you can start sooner than your notice period actually
allows. This only engages when both the value and the options parse as durations, so
country and Yes/No selects are untouched.

## What it deliberately won't do

- **Submit.** It never clicks a submit button.
- **Logins, passwords, search boxes, CAPTCHAs.** Skipped on sight.
- **Workday's custom dropdowns.** Workday renders many "selects" as button-and-listbox
  widgets rather than `<select>`, which need per-widget click choreography. Text fields,
  real selects and radios work; the rest get reported so you can see what's left.

## Testing

```
node test/matcher.test.js     # field classification, answer matching, date formats
open test/fixture.html        # a fake ATS form covering the awkward cases
```

For the fixture to work you need **Allow access to file URLs** enabled on the extension's
card in `chrome://extensions` — otherwise Chrome won't inject the content script into a
`file://` page and Preview will report nothing found.

`test/fixture.html` is a local page with the field shapes that actually break autofill —
unlabelled inputs, radio groups, a `DD/MM/YYYY` text date, a select whose options don't
match your profile wording, a file input, and a question with no saved answer. Run
**Preview** against it after changing any matching rule.

## What not to share

Everything personal lives in one gitignored folder, `local/`:

| File | Why it stays local |
|---|---|
| `local/profile.json` | Date of birth, phone, home address. Also the file to **Import JSON** on the options page. |
| `local/urls.txt` | Which jobs you're applying to |
| `local/runs/` | Screenshots of partly filled forms, so also your details |

One folder to skip. `git` honours `.gitignore` automatically — but GitHub's **web upload
ignores `.gitignore` entirely**, so if you upload through the browser, leave `local/` and
`driver/.venv/` out by hand.

## Layout

```
manifest.json
src/store.js      profile schema, seeded defaults, answer library, storage helpers
src/matcher.js    field classification + answer matching (pure strings, no DOM writes)
src/filler.js     framework-safe value setting, select/radio matching, date formats
src/content.js    per-frame orchestration and reporting
src/popup.*       Preview / Fill, aggregated report
src/options.*     profile editor, answer editor, JSON export/import
test/             Node tests + browser fixture
```

Content scripts run in all frames, because Greenhouse and Lever embed their forms in
iframes. Each frame fills what it can and posts a report; the popup aggregates them and
ignores frames that found nothing.

## Known rough edges

- If a page was already open when you installed or reloaded the extension, the content
  script isn't in it yet. Reload the page.
- Multi-entry sections (add three past jobs, two degrees) fill only the first visible
  instance. Repeat-section handling isn't built.
- Answers are fixed text by design — nothing is generated per company, so an answer
  mentioning "your team" stays generic. Edit after filling where it matters.

## Possible next steps

- Per-company answer overrides, so "why this company" can be specific without retyping the
  rest
- Workday custom-dropdown support (the single biggest coverage gap)
- Read the profile from `resume-v2-*.md` directly instead of duplicating it in
  `store.js`, so there's one source of truth with `job-hunt-copilot/`
