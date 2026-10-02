#!/usr/bin/env python3
"""Batch job-application pre-filler.

Opens a queue of application URLs in a real, persistent Chrome profile, fills each form
using the same matching logic as the Chrome extension, attaches the resume, and stops.
It never submits anything.

Whenever a page needs a human — a sign-in form, SSO, 2FA, a CAPTCHA — the driver hands the
browser back, waits for you to finish in the window, and then carries on.

Usage:
    python apply_driver.py --urls urls.txt
    python apply_driver.py --urls urls.txt --dry-run      # report only, change nothing
    python apply_driver.py --urls urls.txt --channel chrome

The browser profile persists in --profile-dir, so a site you signed into last run is
already authenticated the next time.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
EXTENSION_SRC = HERE.parent / "src"
# Personal data and run output live outside the shareable tree: one folder to keep out
# of version control, so nothing private is ever uploaded by accident.
LOCAL = HERE.parent / "local"

# store.js is excluded on purpose: it is the only file that talks to chrome.storage.
# These three are pure DOM/string logic and run unchanged in a Playwright page.
SHARED_JS = ["matcher.js", "filler.js", "engine.js"]

# A page showing any of these is asking for a human, not for autofill.
# Matched against the URL *path* and the title only — never the query string, because a
# form that submits by GET puts its own field names there ("?auth=Yes" is an answer we
# just filled in, not a login page).
AUTH_PATH_HINTS = re.compile(
    r"sign-?in|signin|log-?in|login|authenticate|\bauth\b|oauth|\bsso\b|"
    r"verify|two-?factor|\b2fa\b|\bmfa\b|challenge|captcha",
    re.I,
)
# Redirects to an identity provider are unambiguous.
AUTH_HOST_HINTS = re.compile(r"okta|onelogin|duosecurity|auth0|pingidentity|microsoftonline|accounts\.google", re.I)
CAPTCHA_SELECTORS = (
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[title*="challenge" i]',
    ".cf-turnstile",
    "#challenge-form",
    "#px-captcha",
)
APPLY_BUTTON = re.compile(r"\bapply\b|start application|i'?m interested", re.I)

# Controls that move a multi-step application forward.
ADVANCE_BUTTON = re.compile(r"save and continue|save & continue|continue|next step|\bnext\b|proceed|save and next", re.I)
# Anything that might send the application, or lose work, is never clicked. Checked
# against a candidate's own label, so "Continue" wins but "Continue and Submit" does not.
NEVER_CLICK = re.compile(r"submit|send|finish|complete application|apply now|withdraw|cancel|delete|back|previous", re.I)


# --------------------------------------------------------------------------- config


def load_config(path: Path) -> dict:
    """Read {profile, snippets, settings} — the shape the extension's Export JSON writes."""
    try:
        config = json.loads(path.read_text())
    except FileNotFoundError:
        sys.exit(
            f"No config at {path}.\n"
            f"Generate one with:  node {EXTENSION_SRC.parent / 'tools/export-profile.mjs'}\n"
            f"or export it from the extension's options page and save it there."
        )
    except json.JSONDecodeError as err:
        sys.exit(f"{path} is not valid JSON: {err}")

    if not config.get("profile"):
        sys.exit(f"{path} has no 'profile' key.")
    config.setdefault("snippets", [])
    config.setdefault("settings", {"snippetThreshold": 2.0, "highlightFilled": False})
    config["settings"].setdefault("snippetThreshold", 2.0)
    return config


def read_urls(path: Path) -> list[str]:
    try:
        lines = path.read_text().splitlines()
    except FileNotFoundError:
        sys.exit(f"No URL list at {path}. One application URL per line; # for comments.")
    urls = [line.strip() for line in lines]
    return [u for u in urls if u and not u.startswith("#")]


def build_payload(config: dict, resume: Path | None, dry_run: bool, overwrite: bool) -> dict:
    """The config object handed to JA.run() inside the page."""
    resume_file = None
    if resume is not None:
        # Only name and type are needed in driver mode; the bytes go through Playwright.
        suffix = resume.suffix.lower()
        mime = {
            ".pdf": "application/pdf",
            ".doc": "application/msword",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }.get(suffix, "application/octet-stream")
        resume_file = {"name": resume.name, "type": mime}

    return {
        "profile": config["profile"],
        "snippets": config["snippets"],
        "settings": config["settings"],
        "resumeFile": resume_file,
        "overwrite": overwrite,
        "useSnippets": True,
        "dryRun": dry_run,
        "tagFiles": True,  # let Playwright attach files natively
    }


def build_injector() -> str:
    """One arrow function carrying the shared engine, evaluated per frame.

    Concatenating into a single evaluate() keeps the files' `var JA` bindings in one shared
    function scope, and evaluate() is not subject to the page's CSP the way a script tag is.
    """
    sources = []
    for name in SHARED_JS:
        path = EXTENSION_SRC / name
        if not path.exists():
            sys.exit(f"Missing {path} — run this from inside the job-autofill checkout.")
        sources.append(f"/* ---- {name} ---- */\n{path.read_text()}")
    body = "\n".join(sources)
    return "(config) => {\n" + body + "\nreturn JA.run(config);\n}"


# --------------------------------------------------------------------- page helpers


def count_fields(page) -> int:
    try:
        return page.evaluate(
            "() => document.querySelectorAll('input:not([type=hidden]),textarea,select').length"
        )
    except PlaywrightError:
        return 0


def needs_human(page) -> str | None:
    """Why this page needs the user, or None if we can proceed."""
    try:
        if page.locator('input[type="password"]').count():
            return "a password field"
        for selector in CAPTCHA_SELECTORS:
            if page.locator(selector).count():
                return "a CAPTCHA / bot check"
        parts = urlsplit(page.url)
        if AUTH_HOST_HINTS.search(parts.netloc):
            return "an identity provider sign-in"
        if AUTH_PATH_HINTS.search(parts.path):
            return "a sign-in or verification page"
        if AUTH_PATH_HINTS.search(page.title()):
            return "a sign-in or verification page"
    except PlaywrightError:
        return None
    return None


def wait_for_human(page, reason: str) -> str:
    """Hand the browser back. Returns 'continue', 'skip' or 'quit'."""
    if not sys.stdin.isatty():
        # Piped or automated run: there is nobody to sign in, so don't fill a login form.
        print(f"   SKIPPED — needs a human ({reason}) and this run is not interactive.")
        return "skip"

    print(f"   PAUSED — this page needs you: {reason}.")
    print("   Finish it in the browser window (sign in, solve the check, reach the form).")
    while True:
        answer = input("   [Enter] continue · [s] skip this URL · [q] quit: ").strip().lower()
        if answer in ("", "c", "continue"):
            still = needs_human(page)
            if still:
                print(f"   Still seeing {still}. Take your time, or press s to skip.")
                continue
            return "continue"
        if answer in ("s", "skip"):
            return "skip"
        if answer in ("q", "quit"):
            return "quit"


def open_application_form(page) -> bool:
    """Many job URLs are a description page with an Apply button. Click through to the form.

    Only fires when the page has almost no fields, so a real form is never disturbed.
    """
    if count_fields(page) >= 3:
        return False
    for role in ("button", "link"):
        try:
            candidate = page.get_by_role(role, name=APPLY_BUTTON)
            if candidate.count():
                candidate.first.click(timeout=5000)
                page.wait_for_load_state("domcontentloaded", timeout=15000)
                page.wait_for_timeout(1200)  # let client-rendered forms mount
                return True
        except (PlaywrightError, PlaywrightTimeout):
            continue
    return False


def page_signature(page) -> str:
    """Fingerprint of the form controls on screen.

    Used to tell a real step change from a Continue button that did nothing — SPA wizards
    like Workday keep the same URL between steps, so the URL alone proves nothing.
    """
    try:
        return page.evaluate(
            """() => [...document.querySelectorAll('input:not([type=hidden]),textarea,select')]
                 .map(e => (e.name || e.id || e.placeholder || '') + ':' + e.type).join('|')"""
        )
    except PlaywrightError:
        return ""


def find_advance_control(page):
    """The control that moves to the next step, or None if this looks like the last one.

    Candidates are filtered against NEVER_CLICK by their own label, so a Submit button is
    never mistaken for a Continue button.
    """
    for role in ("button", "link"):
        try:
            candidates = page.get_by_role(role, name=ADVANCE_BUTTON)
            count = candidates.count()
        except PlaywrightError:
            continue
        for i in range(count):
            candidate = candidates.nth(i)
            try:
                label = (candidate.inner_text(timeout=2000) or "").strip()
                if not label:
                    label = candidate.get_attribute("value") or candidate.get_attribute("aria-label") or ""
                if NEVER_CLICK.search(label):
                    continue
                if not candidate.is_enabled(timeout=2000):
                    continue
                return candidate, label
            except (PlaywrightError, PlaywrightTimeout):
                continue
    return None, None


def fill_frames(page, injector: str, payload: dict) -> list[dict]:
    """Run the engine in every frame; ATS forms are frequently iframed."""
    reports = []
    for frame in page.frames:
        try:
            report = frame.evaluate(injector, payload)
        except PlaywrightError:
            continue  # cross-origin frame we cannot touch, or a frame that just detached
        if report and report.get("entries"):
            report["frameUrl"] = frame.url
            reports.append(report)
    return reports


def attach_resume(page, resume: Path) -> list[str]:
    """Attach the resume to inputs the engine tagged as resume fields.

    Playwright sets files through the browser itself, which works on uploaders that reject
    the extension's synthetic DataTransfer.
    """
    results = []
    for frame in page.frames:
        try:
            inputs = frame.locator('input[data-ja-file="resume"]')
            for i in range(inputs.count()):
                try:
                    inputs.nth(i).set_input_files(str(resume), timeout=10000)
                    results.append(f"attached {resume.name}")
                except (PlaywrightError, PlaywrightTimeout) as err:
                    results.append(f"could not attach: {str(err).splitlines()[0]}")
        except PlaywrightError:
            continue
    return results


# ----------------------------------------------------------------------------- main


def summarise(entries: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for entry in entries:
        counts[entry["status"]] = counts.get(entry["status"], 0) + 1
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--urls", type=Path, default=LOCAL / "urls.txt", help="file of application URLs, one per line")
    parser.add_argument("--config", type=Path, default=LOCAL / "profile.json", help="{profile, snippets, settings} JSON")
    parser.add_argument("--resume", type=Path, default=None, help="resume file to attach")
    parser.add_argument(
        "--profile-dir",
        type=Path,
        default=Path.home() / ".job-autofill-browser",
        help="persistent browser profile, so logins survive between runs",
    )
    parser.add_argument("--out", type=Path, default=LOCAL / "runs", help="where reports and screenshots go")
    parser.add_argument("--dry-run", action="store_true", help="report what would be filled, change nothing")
    parser.add_argument("--overwrite", action="store_true", help="replace values the page already has")
    parser.add_argument("--channel", default=None, help="browser channel, e.g. chrome (default: bundled Chromium)")
    parser.add_argument("--timeout", type=int, default=30000, help="per-navigation timeout in ms")
    parser.add_argument(
        "--max-steps",
        type=int,
        default=8,
        help="how many pages of a multi-step application to walk (1 disables stepping)",
    )
    parser.add_argument("--slow-mo", type=int, default=0, help="delay every browser action by N ms, to watch it work")
    parser.add_argument(
        "--step-pause",
        type=float,
        default=0,
        help="seconds to wait on each filled step before advancing, so you can read it",
    )
    parser.add_argument("--highlight", action="store_true", help="outline each filled field in green")
    args = parser.parse_args()

    config = load_config(args.config)
    urls = read_urls(args.urls)
    if not urls:
        sys.exit(f"{args.urls} has no URLs in it.")

    resume = args.resume or (Path(config["resumePath"]).expanduser() if config.get("resumePath") else None)
    if resume is not None:
        resume = resume.expanduser()
        if not resume.exists():
            sys.exit(f"Resume not found: {resume}")

    injector = build_injector()
    if args.highlight:
        config["settings"] = {**config["settings"], "highlightFilled": True}
    payload = build_payload(config, resume, args.dry_run, args.overwrite)

    run_dir = args.out / datetime.now().strftime("%Y-%m-%d_%H%M%S")
    run_dir.mkdir(parents=True, exist_ok=True)

    print(f"{len(urls)} URL(s) · profile {args.profile_dir} · output {run_dir}")
    print("Nothing is ever submitted. Review each tab yourself before sending.\n")

    results = []
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(args.profile_dir),
            headless=False,  # headless trips bot detection and makes sign-in impossible
            slow_mo=args.slow_mo,
            channel=args.channel,
            viewport={"width": 1400, "height": 1000},
            args=["--disable-blink-features=AutomationControlled"],
        )
        context.set_default_timeout(args.timeout)

        for index, url in enumerate(urls, start=1):
            print(f"[{index}/{len(urls)}] {url}")
            record: dict = {"url": url}
            page = context.new_page()

            try:
                page.goto(url, wait_until="domcontentloaded", timeout=args.timeout)
            except (PlaywrightError, PlaywrightTimeout) as err:
                print(f"   could not open: {str(err).splitlines()[0]}")
                record["error"] = str(err).splitlines()[0]
                results.append(record)
                continue

            page.wait_for_timeout(1500)  # let client-rendered forms mount

            reason = needs_human(page)
            if reason:
                decision = wait_for_human(page, reason)
                if decision == "skip":
                    print("   skipped")
                    record["skipped"] = reason
                    results.append(record)
                    continue
                if decision == "quit":
                    record["skipped"] = "user quit"
                    results.append(record)
                    break

            if open_application_form(page):
                print("   clicked through to the application form")
                # Clicking Apply often lands on a sign-in wall.
                reason = needs_human(page)
                if reason:
                    decision = wait_for_human(page, reason)
                    if decision == "skip":
                        print("   skipped")
                        record["skipped"] = reason
                        results.append(record)
                        continue
                    if decision == "quit":
                        record["skipped"] = "user quit"
                        results.append(record)
                        break

            # --- walk the application, one step per iteration -------------------
            record["steps"] = []
            aborted = False

            for step in range(1, args.max_steps + 1):
                prefix = "  " if args.max_steps == 1 else f"   step {step}:"
                signature_before = page_signature(page)

                reports = fill_frames(page, injector, payload)
                entries = [entry for report in reports for entry in report["entries"]]
                step_record = {
                    "step": step,
                    "url": page.url,
                    "entries": entries,
                    "counts": summarise(entries),
                }

                if resume is not None and not args.dry_run:
                    attached = attach_resume(page, resume)
                    if attached:
                        step_record["resume"] = attached

                if not entries:
                    print(f"{prefix} no fillable fields found")
                else:
                    parts = [f"{count} {status}" for status, count in sorted(step_record["counts"].items())]
                    print(f"{prefix} {' · '.join(parts)}")
                    for entry in entries:
                        if entry["status"] in ("failed", "manual", "no-data", "no-match"):
                            print(f"       - {entry['question']}: {entry.get('note', entry['status'])}")
                    for line in step_record.get("resume", []):
                        print(f"       - resume: {line}")

                shot = run_dir / f"{index:02d}-{step:02d}.png"
                try:
                    page.screenshot(path=str(shot), full_page=True)
                    step_record["screenshot"] = shot.name
                except PlaywrightError:
                    pass

                record["steps"].append(step_record)

                # Advancing writes partial data to the employer's system, so a dry run
                # deliberately inspects one page only.
                if args.dry_run:
                    if step == 1:
                        control, label = find_advance_control(page)
                        if control is not None:
                            print(f"       (multi-step form: '{label}' not clicked in dry-run mode)")
                    break

                if args.step_pause:
                    page.wait_for_timeout(int(args.step_pause * 1000))

                control, label = find_advance_control(page)
                if control is None:
                    print("       final step — review and submit yourself")
                    record["outcome"] = "reached final step"
                    break

                try:
                    control.click(timeout=10000)
                    page.wait_for_load_state("domcontentloaded", timeout=args.timeout)
                    page.wait_for_timeout(1200)  # let client-rendered steps mount
                except (PlaywrightError, PlaywrightTimeout) as err:
                    print(f"       could not click '{label}': {str(err).splitlines()[0]}")
                    record["outcome"] = f"stuck on step {step}"
                    break

                print(f"       clicked '{label}'")

                # A step change can land on a sign-in wall partway through.
                reason = needs_human(page)
                if reason:
                    decision = wait_for_human(page, reason)
                    if decision != "continue":
                        record["outcome"] = f"{decision} at step {step + 1} ({reason})"
                        aborted = decision == "quit"
                        break

                if page_signature(page) == signature_before and page.url == step_record["url"]:
                    # Same fields, same URL: the button did not advance anything. Usually a
                    # validation error we cannot satisfy. Stop rather than loop.
                    print("       form did not advance — likely a validation error needing you")
                    record["outcome"] = f"blocked on step {step}"
                    break
            else:
                record["outcome"] = f"stopped at the --max-steps limit of {args.max_steps}"
                print(f"       reached --max-steps ({args.max_steps}); stopping")

            results.append(record)
            if aborted:
                break

        (run_dir / "report.json").write_text(json.dumps(results, indent=2))
        print(f"\nReport: {run_dir / 'report.json'}")
        print("Tabs are left open and nothing was submitted.")
        if sys.stdin.isatty():
            input("Review them, then press Enter to close the browser: ")
        context.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
