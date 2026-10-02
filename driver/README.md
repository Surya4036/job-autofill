# Batch driver

Opens a queue of application URLs in a real Chrome profile, fills each form with the same
engine the extension uses, attaches your resume, and stops. **It never submits anything.**

When a page needs a human — sign-in, SSO, 2FA, CAPTCHA — it hands the browser back, waits
for you in the terminal, then carries on.

## Setup

```bash
cd driver
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/playwright install chromium
```

Then generate your profile data:

```bash
node ../tools/export-profile.mjs     # writes ../local/profile.json
```

If you've edited anything in the extension, use its **options page → Export JSON** instead
and save the result over `local/profile.json` — that file has your real edits. Add a
`"resumePath"` key, or pass `--resume`.

## Run

```bash
./.venv/bin/python apply_driver.py --dry-run              # report only
./.venv/bin/python apply_driver.py                        # actually fill
./.venv/bin/python apply_driver.py --channel chrome
```

Inputs and outputs default to the gitignored `local/` folder: URLs from `local/urls.txt`
(one per line, `#` for comments), config from `local/profile.json`, output to
`local/runs/<timestamp>/` as `report.json` plus a full-page screenshot per step. Override
any of them with `--urls`, `--config`, `--out`.

Tabs stay open at the end so you can review and submit by hand.

| Flag | Effect |
|---|---|
| `--dry-run` | Reports what would be filled, changes nothing |
| `--overwrite` | Replace values the page already has |
| `--profile-dir` | Persistent browser profile (default `~/.job-autofill-browser`) |
| `--channel chrome` | Use your installed Chrome instead of bundled Chromium |
| `--resume` | Resume file to attach |
| `--slow-mo 300` | Delay every action, to watch it work |
| `--step-pause 3` | Hold on each filled step before advancing |
| `--highlight` | Outline filled fields in green |

## How it shares code with the extension

`matcher.js`, `filler.js` and `engine.js` contain no `chrome.*` calls. The driver reads
those three files, concatenates them into one arrow function, and `evaluate()`s it in each
frame:

```python
report = frame.evaluate(injector, payload)   # payload -> JA.run(config)
```

A single `evaluate()` is used rather than three script tags for two reasons: the files'
top-level `var JA` bindings end up in one shared function scope, and `evaluate()` isn't
subject to the page's Content-Security-Policy the way an injected `<script>` is.

`store.js` is deliberately excluded — it's the only file that talks to `chrome.storage`.
Config arrives as a plain object instead.

So a fix to the matching rules lands in both the extension and the driver. There is no
second copy of the logic to keep in sync.

## Resume uploads work differently here

The extension builds a synthetic `DataTransfer`. The driver instead lets the engine *tag*
file inputs (`data-ja-file="resume" | "other" | "unsupported"`) via the `tagFiles` option,
then attaches with Playwright's `set_input_files`. That goes through the browser itself, so
it survives uploaders that reject a synthetic attachment.

Fields asking for a cover letter, transcript or photo are tagged `other` and left alone.

## The human handoff

Before filling, the driver checks for a visible password field, known CAPTCHA containers
(reCAPTCHA, hCaptcha, Turnstile, PerimeterX), and auth keywords in the URL and title. On a
hit it prints why, then waits:

```
   PAUSED — this page needs you: a sign-in or verification page.
   Finish it in the browser window (sign in, solve the check, reach the form).
   [Enter] continue · [s] skip this URL · [q] quit:
```

Pressing Enter re-checks; if the wall is still up it says so rather than filling a login
form with your home address. Because `--profile-dir` persists, a site you signed into last
run is already authenticated next time, so this prompt should appear once per employer, not
once per application.

It also handles job URLs that are a description page rather than a form: if a page has
fewer than three fields it looks for an Apply button and clicks through, then re-checks for
an auth wall.

## Multi-step applications

The driver walks wizards. Per step it fills, attaches the resume, screenshots, then looks
for a control matching `save and continue / continue / next / proceed` and clicks it.

Three rules keep that safe:

- **Candidates are filtered by their own label against `NEVER_CLICK`** (`submit`, `send`,
  `finish`, `withdraw`, `cancel`, `delete`, `back`, `previous`). So "Continue" is clicked
  and "Continue and Submit" is not. When no advance control remains, it reports
  `reached final step` and stops.
- **A page fingerprint detects non-progress.** SPA wizards keep the same URL between steps,
  so the URL proves nothing; the driver hashes the form controls instead. Same fingerprint
  after clicking means a validation error it can't satisfy, and it stops rather than
  looping.
- **Dry runs never advance.** Clicking Continue writes partial data into the employer's
  system, so `--dry-run` inspects one page and tells you the form is multi-step.

`--max-steps` (default 8) caps the walk. `--max-steps 1` disables stepping.

Tested against `test/wizard/step1.html`, a four-step fixture ending in a red Submit button:
7 / 10 / 11 / 4 fields filled across the steps, resume attached on step four, stopped
without submitting.

## Limits worth knowing
- **Bot detection.** Headed and persistent-profile is the configuration least likely to be
  flagged, and `--channel chrome` helps further, but some sites behind PerimeterX or
  Cloudflare will still challenge you. That's what the pause is for.
- **Never auto-submit.** Not implemented, and not an oversight. A form sent without you
  reading it is how a wrong salary figure or a mismatched cover letter goes out.
- **Custom dropdown widgets** (Workday's listboxes) remain unsupported, same as in the
  extension — they aren't real `<select>` elements.
