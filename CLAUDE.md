# CLAUDE.md — enoVestor Bug Capture Extension

## What this project is
A Chromium (Chrome / Edge / Brave) Manifest V3 extension that records what a user does while they reproduce a bug in IRS Live (`https://irs.enovestor.com/`): clicks, field changes, API calls, errors, 🐞 bug markers and region screenshots. The output is a `.txt` report, or a `.zip` if there are screenshots.

**The full requirements are in `SPEC.md`. It is the source of truth.** Read it before any work. If something you are about to do conflicts with SPEC.md, stop and ask.

## About the owner
- Will is a Business Analyst, not a JavaScript developer. He reviews behaviour, not code style.
- Explain decisions in plain language, with a short real-life analogy when a concept is non-obvious (e.g. MAIN vs ISOLATED world, service-worker lifecycle, CSS px vs device px).
- Comment the code heavily: every file starts with a block explaining its role, and non-obvious lines explain *why*.

## Hard rules
1. **Plain JavaScript only.** No build step, no bundler, no framework, no npm packages, no CDN scripts. The folder must load as-is via "Load unpacked".
2. **No outbound network calls** from extension code. Ever.
3. **Never break IRS.** It is a live financial system. Follow SPEC.md §7 (wrapper safety rules) exactly: try/catch everything, preserve native behaviour, never block.
4. **Never store or keep state only in service-worker memory.** Use `chrome.storage.session` (events) and IndexedDB (screenshots), and `chrome.alarms` for timers (SPEC §5.2).
5. Don't add permissions beyond SPEC.md §12 NFR-02 without asking Will first.
6. All tunables live in `config.js`.

## How to work
- Build **one milestone at a time** (SPEC.md §16: M1 → M2 → M3 → M4 → M4b → M5 → M6). Don't start the next milestone until Will says so.
- Before coding a milestone, give a short plan: the files you will create or change, and how Will can test it.
- Test against `test/fixture.html` (served by `test/server.py`), never against IRS Live during development.
- After each milestone, report:
  1. What was built
  2. **How Will tests it by hand**, as numbered click-by-click steps (load/reload the extension, open the fixture, which buttons to press, what to look for)
  3. Which acceptance criteria (AC-xx) it covers, and whether they pass
  4. Anything that differs from SPEC.md, and why
- If a spec requirement turns out to be impossible or a bad idea in practice, say so plainly and propose an alternative. Don't silently work around it.
- Use git: commit at the end of each milestone, with a message naming the milestone, and push the branch.

## Working in Claude Code on the web (cloud session)
- You run in a cloud VM. Will tests the extension on **his own computer**, so the hand-test steps must start with getting the code: "download this branch as a ZIP from GitHub (or pull it), unzip it to the **same folder** as last time, go to the extensions page and press ⟳". The first time, use Load unpacked.
- **Test it yourself before handing over:** if the VM has Chromium + Playwright, run the fixture acceptance tests with the extension loaded (`launch_persistent_context` with `--disable-extensions-except` / `--load-extension`; extensions need headed or new-headless mode, so use `xvfb-run` if needed). Report which ACs you verified automatically and which need Will's manual check (e.g. AC-19 on a real Windows laptop with display scaling).
- **Never try to reach `irs.enovestor.com`** from the cloud session. All testing uses the local fixture.
- Never commit bug capture outputs (`enovestor-bug_*`): they contain real investor data. `.gitignore` covers this; don't weaken it.

## Useful facts
- Reload the extension after code changes: extensions page → ⟳ on the extension card. Content-script changes also need the page refreshed.
- Service worker logs: extensions page → "service worker" link → Console.
- Content-script / page logs: DevTools on the page itself.
