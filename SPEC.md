# SPEC — enoVestor Bug Capture Extension (MVP)

> **Audience:** Claude Code (implementer) and Will (owner / reviewer).
> **Status:** v1.0 — ready to build — 2026-11-02 (v0.2: user-marked bug moments; error detection demoted to hints. v0.3: user-selected region screenshots, zip output when screenshots exist)
> **Owner:** Will (Business Analyst)
> **Target for MVP:** IRS **Live** only (`https://irs.enovestor.com/`). UAT and enoVestor Web are deferred.
> **Placeholders:** none blocking. Frames on other domains, if any, get added to the host list when found (§13).

---

## 1. Purpose

When a user hits a bug in enoVestor Web, Will has to ask them for a screen recording, which button they clicked, what data they entered, and the API requests and responses. This extension replaces that back-and-forth.

**In the MVP the extension captures *symptoms only*.** It does not diagnose root cause, and it does not talk to Jira or any server.

**The user decides what the bug is, not the extension.** There are two kinds of bug:
- **Technical errors:** an error toast, a 4xx/5xx response, a console exception. These leave signals the extension can detect.
- **Logic bugs:** the operation *succeeds* technically, but the result is not what the user expected (wrong value, wrong status, record not updated). These leave **no** error signal.

The error toasts in enoVestor cannot all be identified in advance, and logic bugs have none. So the design rests on the **user marking the moment** they see the bug (FR-24), together with **expected vs actual** in their own words (FR-31). Automatically detected errors are shown only as *technical signals* that may or may not be related.

## 2. Users and workflow

**Users:** the Hanoi team. They install the extension locally (Load unpacked) on Chrome, Edge, or Brave.

**Workflow (capture on redo):**

```
Bug happens (not captured)
 → user opens extension popup → [Start recording]  → red "REC" badge appears
 → user refreshes the page (recommended; popup tells them to)
 → user redoes the same steps
 → the moment the wrong result / error appears: user presses [🐞 Mark bug] (popup button or Alt+Shift+B)
      → marker added to the timeline + text snapshot of the visible page saved
      (can be pressed more than once if the bug shows up at several steps)
 → optionally [📷 Screenshot] (popup button or Alt+Shift+S)
      → screen dims, user drags a box around the part that shows the bug → that area is saved as a PNG
      (any size, any number up to the limit; "whole visible screen" is also offered)
 → user clicks extension → [Stop recording]
 → Review page opens in a new tab: "What were you doing?", "What did you expect?", "What happened instead?",
   "Did the bug happen again this time?" (Yes / No / Something different)
 → [Download .txt] → user sends file to Will
```

## 3. Scope

### In scope (MVP)
- Start/Stop recording, scoped to **one tab**
- Capture: clicks, form-field changes, navigation (incl. SPA route changes), fetch + XHR (with bodies), console errors, uncaught exceptions, unhandled promise rejections, on-screen error messages
- Masking of credentials (§9)
- User-selected region screenshots (FR-40 to FR-50)
- Output: one `.txt` file in the fixed format (§10), or **one `.zip`** (txt + PNG screenshots) if any screenshots were taken (FR-49)
- Limits and auto-stop (§8)

### Out of scope (MVP)
- Jira integration
- Screen/video recording, DOM replay, automatic screenshots, annotation/drawing on screenshots, full-page (scrolling) screenshots
- PII redaction (capturing investor data is approved for the MVP; credentials are still masked)
- Server-side log correlation
- Always-on/background recording or rolling buffer
- Firefox / Safari
- Chrome Web Store publishing

## 4. Target platform

| Item | Value |
|---|---|
| Browsers | Chrome, Microsoft Edge, Brave (all Chromium) |
| Minimum Chromium version | **111** (needed for `"world": "MAIN"` content scripts) |
| Manifest | **V3** |
| Install method | Developer mode → Load unpacked (`chrome://extensions`, `edge://extensions`, `brave://extensions`) |
| Language | **Plain JavaScript, no build step, no framework, no npm dependencies.** The owner is not a JS developer: the folder must be loadable as-is, and the code must be readable and **heavily commented** (explain *why*, not just *what*). |
| External network calls | **None.** The extension must never send data anywhere. |

## 5. Architecture

### 5.1 Components

```
┌─────────────────────────────────────────────────────────────┐
│ enoVestor tab                                               │
│                                                             │
│  [MAIN world]  page-hooks.js   (runs at document_start)     │
│     wraps fetch / XHR / history / console, listens to       │
│     clicks, changes, errors, watches for error toasts       │
│        │  window.postMessage({source:"EVBC", ...})          │
│        ▼                                                    │
│  [ISOLATED world]  bridge.js   (runs at document_start)     │
│     validates messages, batches events, knows REC state,    │
│     tells page-hooks.js when recording is on/off            │
└────────┼────────────────────────────────────────────────────┘
         │ chrome.runtime.sendMessage (batched)
         ▼
┌─────────────────────────────────────────────────────────────┐
│ service-worker.js  (background)                             │
│   recording state, event storage (chrome.storage.session),  │
│   limits, auto-stop (chrome.alarms), badge, txt assembly    │
└────────┬────────────────────────────────────────────────────┘
         │
   popup.html/js  (Start / Stop, status)
   review.html/js (note, "same error?", Download .txt)
```

### 5.2 Why it is split this way (constraints Claude Code must respect)

1. **The page's own JavaScript is only reachable from the MAIN world.** Wrapping `window.fetch` and `XMLHttpRequest` has to happen in the page's JS context. An isolated-world content script has its own separate copy of `window` and cannot see the page's fetch calls. MAIN-world scripts **cannot** use `chrome.*` APIs, so they relay through `bridge.js` using `window.postMessage`.

2. **The hooks must be installed at `document_start`, on every matching page, all the time.** The page's code can grab its own reference to `fetch` early, so if the wrapper is installed later, calls through that reference are missed. `page-hooks.js` is therefore always loaded, but it **only records while recording is on**. When recording is off it passes everything straight through (no cloning of bodies, no listeners doing work beyond a flag check).

3. **The service worker is not a long-running process.** Chrome kills an idle MV3 service worker after about 30 seconds. **Never keep recording state or events only in service-worker memory.** All state goes in `chrome.storage.session`, which lives in the browser's memory, survives service-worker restarts and page reloads, and is cleared when the browser closes. Timers must use `chrome.alarms`, not `setTimeout`.

4. **The page can reload mid-recording** (after a save, a login redirect, or the user's recommended refresh). On every page load, `bridge.js` asks the service worker "is this tab recording?" and, if so, tells `page-hooks.js` to switch on. Events from before the reload are already in storage, so nothing is lost.

5. **Storage writes must not be O(n²).** Do not read-modify-write one growing array on every event. Use **append-only chunks**: `bridge.js` batches events (flush every 500 ms or 50 events, and on `pagehide`). The service worker writes each batch to its own key `rec:<tabId>:chunk:<seq>` and keeps a small `rec:<tabId>:meta` record (start time, event count, byte estimate, next seq). Writes for a tab must go through a serial queue (a promise chain) so the order is preserved.

6. **Recording state per tab** lives in `rec:<tabId>:meta`: `{ status: "recording"|"stopped", startedAt, stoppedAt, stopReason, url, eventCount, bytes, nextSeq, extVersion }`.

### 5.3 Message protocol

- MAIN → ISOLATED: `window.postMessage({ source: "EVBC", kind: "event", event }, "*")`
- ISOLATED → MAIN: `window.postMessage({ source: "EVBC_CTRL", recording: true|false }, "*")`
- `bridge.js` must ignore messages where `event.source !== window`, or where `data.source` or the shape is wrong.
- ISOLATED → SW: `{ type: "events", batch: [...] }`, `{ type: "getState" }`
- Popup → SW: `{ type: "start", tabId }`, `{ type: "stop", tabId }`, `{ type: "status", tabId }`
- Review page → SW: `{ type: "buildTxt", tabId, note, sameError }` → returns the txt string

## 6. Functional requirements

Priority uses MoSCoW: **M** = Must, **S** = Should, **C** = Could.

### Recording control
| ID | Requirement | P |
|---|---|---|
| FR-01 | Popup shows the current tab's status: *Not recording* / *Recording — mm:ss, N events*. | M |
| FR-02 | **Start recording** is only enabled on pages matching the enoVestor host patterns (§14: `https://irs.enovestor.com/*`). On other pages the popup says "Open enoVestor first". | M |
| FR-03 | On Start, the popup shows: "Refresh the page, then repeat the steps that caused the error." It also offers a **[Refresh page for me]** button, which calls `chrome.tabs.reload(tabId)`. | M |
| FR-03a | **Live-data warning:** the first screen after Start shows, in amber: "⚠ This is IRS **Live**. Repeating steps that *save, submit, approve, send or delete* will change real data again (e.g. a second submission, a second email to an investor). Only redo those steps if it is safe, or stop at the step just before and describe the rest." The user must tick "I understand" once per browser session before recording starts. | M |
| FR-04 | While recording, the extension icon shows a red **REC** badge for that tab only (`chrome.action.setBadgeText({tabId})`). | M |
| FR-05 | Recording is scoped to the tab where Start was pressed. Other tabs are never captured. | M |
| FR-06 | **Stop recording** ends capture, clears the badge, and opens `review.html?tabId=<id>` in a new tab. (A separate tab is used because popups close as soon as they lose focus, which would throw away a half-typed note.) | M |
| FR-07 | If the recorded tab is closed while recording, auto-stop with reason `tab_closed` and open the review page. | M |
| FR-08 | If the tab navigates to a non-enoVestor host while recording, keep recording (capture resumes when it comes back), and log a `NAV` event with the host only. | S |
| FR-09 | Only one recording per tab at a time. Starting again after a download discards the previous capture (with a confirm prompt in the popup). | M |

### Capture (all in `page-hooks.js`, active only while recording)
| ID | Requirement | P |
|---|---|---|
| FR-10 | **fetch**: wrap `window.fetch`. Record method, URL, request headers, request body, status, status text, response headers, response body (via `response.clone()`), duration (ms), and the network error message if the fetch rejects. The wrapper must return the **original** promise behaviour to the app. | M |
| FR-11 | **XHR**: wrap `XMLHttpRequest.prototype.open / setRequestHeader / send`. Record the same fields as FR-10. Body: if `responseType` is `""` or `"text"`, use `responseText`; if `"json"`, use `JSON.stringify(xhr.response)`; for `blob`/`arraybuffer`/`document`, write `[binary/<type>, N bytes]`. | M |
| FR-12 | Request bodies: strings as-is; `URLSearchParams` → string; `FormData` → `key=value` lines (files as `[file name, size]`); `Blob`/`ArrayBuffer` → `[binary N bytes]`. | M |
| FR-13 | Flag an API call as a **technical signal** (`!`) if the status is ≥ 400, it threw a network error, or the response JSON has a top-level `success:false`, `isSuccess:false`, or a non-empty `error`/`errors` field. These are hints only. A flagged call is not assumed to be *the* bug, and a capture with no flags may still contain one (a logic bug). | M |
| FR-14 | **Clicks**: listen in the capture phase (`document.addEventListener("click", h, true)`) so the app's `stopPropagation` can't hide them. Record the **label** (first non-empty of: `aria-label`, `innerText` trimmed to 80 chars, `value`, `title`, `alt`), the **selector** (`#id` if present; else `[data-testid=…]`; else `tag.class1.class2` for up to 3 ancestor levels), and the page path. If the click lands on a child of a button or link, use the nearest `button, a, [role=button], input[type=submit]` ancestor. | M |
| FR-15 | **Field changes**: listen to `change` (capture phase). Record the field's label (from `<label for>`, `aria-label`, `placeholder`, or `name`), selector, and the new value. **Password fields are always `[MASKED]`.** Use `change`, not `input`, so we get one event per field and not one per keystroke. | M |
| FR-16 | **Navigation**: record the initial page load, and wrap `history.pushState` / `replaceState`, plus `popstate` and `hashchange`, to catch SPA route changes. | M |
| FR-17 | **Console**: wrap `console.error` (M) and `console.warn` (S). Record the arguments, serialized safely (handle `Error` objects with their stack, handle circular objects, truncate to 4 KB). Always call the original. | M |
| FR-18 | **Uncaught errors**: listen to `window` `error` (message, source, line, col, stack) and `unhandledrejection` (reason + stack). | M |
| FR-19 | **On-screen messages (best effort)**: a `MutationObserver` on `document.documentElement` (childList + subtree) records the text of added nodes matching generic message patterns: `[role="alert"]`, `[role="status"]`, `[aria-live]`, `[class*="error" i]`, `[class*="toast" i]`, `[class*="alert" i]`, `[class*="notification" i]`, `[class*="snackbar" i]`, `[class*="message" i]`. Record **success messages too** (a "Saved successfully" toast right before a user marker is key evidence for a logic bug). Classify as `error` if the element or its classes or text match `/error|fail|invalid|denied|exception/i`, otherwise `info`. Skip the same text appearing again within 2 s. `CONFIG.extraMessageSelectors` lets Will add known selectors later, but nothing depends on it. | S |
| FR-20 | Every event gets `t` (epoch ms, from `Date.now()`) and `seq` (a counter local to the page). The service worker sorts by `t`, then by arrival order. | M |
| FR-21 | Environment header: user agent, browser brand and version (from `navigator.userAgentData` if available), OS, screen and window size, timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`), extension version, the URL when recording started. | M |
| FR-22 | Capture correlation-ID-looking response headers if present (`x-request-id`, `x-correlation-id`, `traceparent`, `request-id`) and show them on the timeline line. They are free to capture now and very useful later. | S |
| FR-23 | Supplement with `chrome.webRequest` (metadata only: URL, method, status, type) for requests the page hooks can't see (form posts, the app's own service worker, iframes), and show them as `NET` lines. | C |

### Bug markers (user-identified bug moments)
| ID | Requirement | P |
|---|---|---|
| FR-24 | While recording, the user can press **🐞 Mark bug** (big button in the popup) or the keyboard shortcut **Alt+Shift+B** (`chrome.commands`; the user can rebind it at `chrome://extensions/shortcuts`, `edge://extensions/shortcuts`, `brave://extensions/shortcuts`). Each press adds a `BUG` marker event with the timestamp and a running number (🐞1, 🐞2 …). It can be pressed multiple times. | M |
| FR-25 | On each marker, capture a **text snapshot of the visible page**: page path and title, then the `innerText` of the main content area (`main`, `[role=main]`, or else `body`), plus the label/value pairs of visible form fields (masking rules apply), truncated to 20 KB. Tables keep their rows on separate lines (`innerText` does this by default). This is how Will sees *what the user saw* when the result was wrong. | M |
| FR-26 | After a marker, the popup (if open) shows "🐞1 marked at 10:58:06" plus an optional one-line text box, "What's wrong here?". If filled in, it is attached to that marker. | S |
| FR-27 | ~~Automatic full screenshot on marker~~ Superseded in v0.3 by user-selected screenshots (FR-40 onwards). After a 🐞 marker, the popup offers **[📷 Add screenshot]** (FR-40). | — |
| FR-28 | If the user stops recording with **zero** markers, the review page shows a gentle prompt: "You didn't mark the bug moment. Please describe where it happened in 'What happened instead?'." Do not block the download. | M |

### Screenshots (user-selected region)

How it works: Chrome can only photograph the **whole visible part of the tab** (`chrome.tabs.captureVisibleTab`), the way a camera photographs a whole monitor. So "choose an area" means: (1) the user draws a box on an overlay, (2) the overlay is removed, (3) the whole visible tab is photographed, (4) the photo is **cropped** to the box.

| ID | Requirement | P |
|---|---|---|
| FR-40 | **Trigger:** a **[📷 Screenshot]** button in the popup, or shortcut **Alt+Shift+S** (`chrome.commands`, rebindable). Only works while the tab is recording; otherwise it is ignored, as in AC-16. The popup button sends the request and then calls `window.close()`, so the popup doesn't cover the page. Right after a 🐞 marker, the popup also shows **[📷 Add screenshot]**. | M |
| FR-41 | **Selection overlay:** a semi-transparent dark layer covers the visible viewport, with a crosshair cursor. The user drags to draw a rectangle; the area inside is shown undimmed, with a live size label (`640 × 320`). On mouse-up, a small toolbar appears next to the box: **[✓ Capture] [↺ Redraw] [⛶ Whole screen] [✕ Cancel]**. Keyboard: **Enter** = capture, **Esc** = cancel. A box smaller than 8 × 8 px counts as a misclick (stay in drawing mode). Top hint bar: "Drag to select the area that shows the bug · Esc to cancel". | M |
| FR-42 | **Isolation from the app:** the overlay lives in a **closed Shadow DOM** on a host element appended to `document.documentElement`, with `position: fixed; inset: 0; z-index: 2147483647`. The app's CSS can't style it, and its CSS can't leak into the app. Every pointer, mouse, keyboard and wheel event on the overlay calls `stopPropagation()` + `preventDefault()`, so **the app never receives the clicks used for selecting** (otherwise a drag could press a button underneath). While the overlay is open, page scrolling is blocked, so the box stays aligned with the content. The extension's own click/change recorder (FR-14, FR-15) **ignores events from the overlay host**, so selecting doesn't pollute the timeline. Lives in `screenshot-overlay.js` (isolated world). | M |
| FR-43 | **Capture sequence:** on Capture → remove the overlay → wait **2 × `requestAnimationFrame` + 50 ms** (so the browser has actually repainted the page without the overlay; otherwise the dark layer ends up in the photo) → send `{ type: "captureRegion", rect, viewport: {innerWidth, innerHeight}, dpr }` to the service worker → SW calls `chrome.tabs.captureVisibleTab(windowId, { format: "png" })`. Chrome allows at most **2 captures per second**: the SW serializes requests and retries once after 600 ms if it hits the quota error. | M |
| FR-44 | **Crop and scale (precision matters):** the captured image is in *device pixels*, while the selection box is in *CSS pixels*. They differ under Windows display scaling (125 %/150 % are common on laptops) and browser zoom. Compute `scale = image.width / viewport.innerWidth` from the real image; **don't rely on `devicePixelRatio` alone**. Crop `rect × scale` (rounded, clamped to the image bounds) in the service worker with `createImageBitmap` + `OffscreenCanvas` → `convertToBlob({ type: "image/png" })`. Keep native resolution, so text stays sharp. | M |
| FR-45 | **Storage:** screenshots are **not** put in `chrome.storage.session`, whose 10 MB quota is shared with events. Store PNG blobs in **IndexedDB** (extension origin), DB `evbc`, store `shots`, key `<tabId>:<n>`. Clear them on: Discard, Start of a new recording in that tab, and `chrome.runtime.onStartup`. That keeps the same "gone after browser restart" behaviour as the rest of the capture. | M |
| FR-46 | **Timeline event:** each screenshot adds a `SHOT` event: number, time, size in px (CSS), page path, file name, optional caption, and **linked marker**, meaning the latest 🐞 within the previous 60 s, if any ("for 🐞1"). | M |
| FR-47 | **Confirmation + caption:** after capture, show a small in-page toast (same Shadow DOM, bottom-right, 5 s): "📷 Screenshot 1 saved", with a one-line box "Add a note (optional)". Enter saves the caption. Typing in that box is ignored by the recorder. | S |
| FR-48 | **Review page:** show screenshot thumbnails with number, time, size and caption. Clicking one opens it full size. Each has a **[🗑 Remove]** button. | S |
| FR-49 | **Packaging:** with **no** screenshots → download the `.txt` as before. With **≥ 1** screenshot → download **one** `enovestor-bug_YYYYMMDD-HHmmss.zip` containing `report.txt` + `screenshot-1.png`, `screenshot-2.png`, … The txt refers to the PNGs by these names. Build the zip in the review page with a small hand-written **store-only zip writer** (`zip-store.js`: CRC-32 + local file headers + central directory, no compression; PNGs are already compressed, so nothing is lost). **No libraries.** The point of one file is that screenshots can't get separated from the report when forwarded. | M |
| FR-50 | **Limits:** max **10 screenshots** per recording (the 📷 button shows "Limit reached" after that). If the captured PNG is larger than 4 MB, re-encode it as JPEG at quality 0.9 and note `(jpeg)` in the txt. | M |

### Review & output
| ID | Requirement | P |
|---|---|---|
| FR-30 | The review page shows: duration, event count, **number of bug markers**, and the technical signals (flagged API calls, console/uncaught errors, on-screen error messages). | M |
| FR-31 | Inputs: **"What were you doing?"** (optional), **"What did you expect to happen?"** (required), **"What happened instead?"** (required), and **"Did the bug happen again during this recording?"**: Yes / No / Something different happened (required). The download button stays disabled until the required fields are filled in. | M |
| FR-32 | **[Download]** saves `enovestor-bug_YYYYMMDD-HHmmss.txt`, or `.zip` if there are screenshots (FR-49) (local time), in the format of §10. Build the file in the review page with a `Blob` plus an `<a download>` element (the page is a normal extension page, so this works; MV3 service workers have no `URL.createObjectURL`). | M |
| FR-33 | After download, a **[Discard capture]** button deletes `rec:<tabId>:*` from storage **and that tab's screenshots from IndexedDB**. Captures are also lost when the browser closes, which is expected behaviour, and the review page states this. | M |
| FR-34 | A **[Copy to clipboard]** button for the same text. | S |

## 7. Wrapper safety rules (non-negotiable)

These hooks run inside a production financial app. Breaking it is worse than missing a capture.

1. **Never throw into the app.** Every hook body is wrapped in `try/catch`. On an internal failure, fall back to the original call and skip the capture.
2. **Preserve semantics exactly.** fetch returns the same `Response` object (capture from a `.clone()`). XHR keeps all native behaviour, including `this` binding, and `arguments` are passed through with `.apply`. History methods return the original return value.
3. **Never block.** Body reading and serialization happen asynchronously after the response is handed back to the app.
4. **Idempotent install.** Guard with `if (window.__EVBC_INSTALLED__) return;` so double injection can't double-wrap.
5. **Near-zero cost when not recording.** When the flag is off, wrappers call through immediately.

## 8. Limits

| Limit | Value | Behaviour |
|---|---|---|
| Max duration | 15 min | Auto-stop via `chrome.alarms`, reason `time_limit` |
| Max total stored size | 5 MB (estimate as JSON length) | Auto-stop, reason `size_limit` |
| Max events | 3,000 | Auto-stop, reason `event_limit` |
| Request/response body | 20 KB each | Truncate; append `…[truncated, original N bytes]` |
| Console arg / error text | 4 KB | Truncate |
| Screenshots | 10 per recording; > 4 MB → JPEG 0.9 | Stored in IndexedDB, **not** counted in the 5 MB event cap (FR-45, FR-50) |

`chrome.storage.session` has a 10 MB quota. The 5 MB cap leaves headroom. On auto-stop: clear the badge, show a system notification only if the `notifications` permission is already justified (otherwise skip it), and open the review page. The stop reason is printed in the txt header.

## 9. Masking (always on)

| What | Rule |
|---|---|
| Request/response headers | Mask the values of `authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `x-csrf-token`, `x-xsrf-token`, `proxy-authorization` (case-insensitive) → `[MASKED]` |
| JSON body keys (any depth) | Mask the values of keys matching `/pass(word)?|pwd|secret|token|otp|pin|api[-_]?key|refresh/i` → `"[MASKED]"`. If a body isn't valid JSON, leave it as-is. |
| URL query params | Mask the values of params matching the same regex |
| Form fields | `input[type=password]` is always masked |

Masking happens **at capture time in `page-hooks.js`**, so unmasked credentials never reach storage. Investor data (names, TINs, addresses) is **not** masked in the MVP. That decision was approved by the owner.

## 10. Output format (`.txt`) — fixed layout

Plain UTF-8 text, LF line endings, max ~110 columns where practical. Timestamps in the timeline are **local time with milliseconds**; the header shows full ISO 8601 with offset (the Hanoi team is on UTC+7, Singapore on UTC+8, and servers are likely UTC). The layout must stay stable because a later phase will parse it.

```
==================== enoVestor Bug Capture ====================
Format:        EVBC-TXT v1
Captured:      2026-11-02T10:57:39.880+07:00  →  2026-11-02T10:58:20.114+07:00  (40.2 s)
Stop reason:   user
Start URL:     https://irs.enovestor.com/investors/12345/edit
Timezone:      Asia/Bangkok (UTC+07:00)
Browser:       Chrome 141.0 / Windows 11
Window:        1536x864 (screen 1920x1080)
Extension:     v0.1.0

==================== Reported by user ====================
Bug happened again:  Yes
Doing:         Updating investor TIN and country of tax residence
Expected:      Country of tax residence shows "Singapore" after saving
Instead:       Save says success but country still shows "Malaysia"

==================== Summary ====================
Events: 25   API calls: 9   Bug markers: 1   Screenshots: 1
Technical signals (may be unrelated): flagged API 1, console errors 1, uncaught 0, on-screen errors 0

Bug markers:
  🐞1 [10:58:09.402]  "country didn't change"
      Last 3 API calls before marker:  #7 PUT /api/investors/12345 → 200   #8 GET /api/investors/12345 → 200
                                       #9 GET /api/lookups/countries → 200

Technical signals (may be unrelated):
  [10:57:44.210] API !  GET /api/notifications → 404 (51 ms)  #3
  [10:57:44.300] CON !  TypeError: Cannot read properties of undefined (reading 'count')

==================== Timeline ====================
[10:57:40.112] NAV     load  /investors/12345/edit
[10:57:41.530] API     GET  /api/investors/12345 → 200 (182 ms)  #1
[10:57:44.210] API !   GET  /api/notifications → 404 (51 ms)  #3
[10:57:44.300] CON !   TypeError: Cannot read properties of undefined (reading 'count')
[10:57:52.801] CHANGE  "TIN" (input#tin) = "S1234567A"
[10:57:55.120] CHANGE  "Country of tax residence" (select#taxCountry) = "SG"
[10:58:05.004] CLICK   "Save" (button#btn-save)
[10:58:05.020] API     PUT  /api/investors/12345 → 200 (241 ms)  #7  req-id: 9f2c…
[10:58:05.300] UI      "Saved successfully"  (div.toast-success)
[10:58:05.310] API     GET  /api/investors/12345 → 200 (160 ms)  #8
[10:58:09.402] 🐞 BUG 1  "country didn't change"   → see Snapshot 🐞1
[10:58:14.880] 📷 SHOT 1  screenshot-1.png  612×148 px  /investors/12345/edit  for 🐞1  "country field after save"

==================== API details ====================
(Order: calls in the "last 3 before a 🐞 marker" first, then flagged calls, then the rest in time order.)
---------- #7  PUT https://irs.enovestor.com/api/investors/12345  → 200 OK  (241 ms)  [before 🐞1] ----------
Request headers:
  Content-Type: application/json
  Authorization: [MASKED]
Request body:
  {"tin":"S1234567A","taxCountry":"SG"}
Response headers:
  x-request-id: 9f2c…
Response body:
  {"success":true}

---------- #8  GET https://irs.enovestor.com/api/investors/12345  → 200 OK  (160 ms)  [before 🐞1] ----------
Response body:
  {"id":12345,"tin":"S1234567A","taxCountry":"MY", ...}

---------- #3  GET https://irs.enovestor.com/api/notifications  → 404 Not Found  (51 ms) ! ----------
...

==================== Page snapshots at bug markers ====================
---------- 🐞1  [10:58:09.402]  /investors/12345/edit — "Edit Investor" ----------
Form fields:
  TIN: S1234567A
  Country of tax residence: Malaysia
  ...
Visible text:
  Investor Details
  Name   Nguyen Van A
  ...

==================== Screenshots ====================
screenshot-1.png  [10:58:14.880]  612×148 px (1224×296 image px, scale 2.00)  for 🐞1  "country field after save"

==================== Errors detail ====================
[10:57:44.300] console.error
  TypeError: Cannot read properties of undefined (reading 'count')
    at ... (stack)

==================== End ====================
```

Rules:
- `!` marks technical signals (FR-13, plus console/uncaught errors and on-screen messages classified `error`). They are labelled "may be unrelated" everywhere. Do not use stronger wording such as "Failures" or "Root cause".
- **Bug markers come first** in the Summary, because they are the user's own statement of where the bug is. For each marker, list the last 3 API calls before it, since the evidence is usually just before the moment the user noticed.
- If there are no markers, the Summary says: `Bug markers: none (user did not mark the moment; see "Instead" above)`.
- Under each 🐞 marker in the Summary, list its linked screenshots (`📷 screenshot-1.png`).
- The **Screenshots** section is omitted when there are none. When there are, the txt is named `report.txt` inside the zip (FR-49).
- On timeline lines, API paths are shown without the host if they're the same origin; otherwise the full URL.
- API calls are numbered `#n` in time order, and `#n` links the timeline to API details.
- In **API details**, calls among the last 3 before any 🐞 marker are listed first (tagged `[before 🐞n]`), then flagged calls (`!`), then the rest in time order. In the logic-bug example, the evidence is #8 returning `taxCountry: "MY"` right after a successful PUT of `"SG"`.
- JSON bodies are pretty-printed with a 2-space indent if they're valid JSON and under 20 KB after formatting; otherwise raw.
- Long single-line values are not wrapped (to keep them easy to copy).

## 11. UI

**Popup (≈ 300 px wide)**
- Not on enoVestor: "Open an enoVestor page to record." (Start disabled)
- Idle: **[● Start recording]** plus one line of help text.
- Just started: "Recording. Refresh the page, then repeat the steps." **[Refresh page for me]** **[■ Stop]**
- Recording: elapsed timer, event count, markers count, a big **[🐞 Mark bug]** button (with the shortcut shown under it: "or press Alt+Shift+B"), a **[📷 Screenshot]** button ("or press Alt+Shift+S", with a counter such as `2/10`), and **[■ Stop]**. When there are zero markers, show the hint "Press 🐞 the moment you see the wrong result."
- A capture already stopped but not discarded: **[Open review page]** **[Discard]**

**Review page:** the summary counts (FR-30), the inputs (FR-31), screenshot thumbnails (FR-48), the buttons (FR-32 to FR-34), and a read-only preview of the first ~200 lines of the txt.

No styling framework. Simple, readable CSS. English UI text.

## 12. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-01 | No outbound network requests from extension code. No analytics. No remote code. |
| NFR-02 | Minimal permissions: `storage`, `alarms`, `tabs` (to read the tab URL in the popup and listen to `onRemoved`), `activeTab` (needed for `captureVisibleTab`; it is granted by the user's popup click or shortcut press. If capture fails in testing because the grant was lost, report it to Will before widening permissions), plus `host_permissions` for `https://irs.enovestor.com/*` (IRS Live only for MVP) and `http://localhost/*` (for the test fixture). Add `webRequest` only if FR-23 is built. |
| NFR-03 | With recording off, app behaviour and performance are indistinguishable from having no extension. |
| NFR-04 | Works identically on Chrome, Edge, and Brave (current stable versions). |
| NFR-05 | Every file starts with a comment block explaining its role in the architecture (§5). Non-obvious lines (MAIN vs ISOLATED world, why `clone()`, why the capture phase, why chunks) are commented. |
| NFR-06 | All tunables (limits, selectors, mask regexes, host patterns) live in **one** file: `config.js`. This file is used by both worlds, so it must be plain JS with no `chrome.*` calls. |

## 13. Project structure

```
evbc/
├── manifest.json
├── config.js              # all tunables (§14)
├── page-hooks.js          # MAIN world, document_start
├── bridge.js              # ISOLATED world, document_start
├── service-worker.js      # background: state, storage, limits, badge
├── format-txt.js          # pure function: (meta, events, env, note, sameError) → string
├── screenshot-overlay.js  # ISOLATED world: selection overlay + toast in closed Shadow DOM (FR-41, FR-42, FR-47)
├── shots-db.js            # tiny IndexedDB wrapper for screenshot blobs (FR-45); used by SW + review page
├── zip-store.js           # store-only zip writer, CRC-32, no deps (FR-49)
├── popup.html / popup.js / popup.css
├── review.html / review.js / review.css
├── icons/ (16, 32, 48, 128 png — simple placeholder)
├── test/
│   ├── fixture.html       # local test page (see §15)
│   └── serve.sh           # e.g. `python3 -m http.server 8080` from test/
└── README.md              # install (Chrome/Edge/Brave), use, troubleshoot
```

`manifest.json` content_scripts (sketch):

```json
"content_scripts": [
  { "matches": ["https://irs.enovestor.com/*", "http://localhost/*"],
    "js": ["config.js", "page-hooks.js"], "run_at": "document_start",
    "world": "MAIN", "all_frames": true, "match_origin_as_fallback": true },
  { "matches": ["https://irs.enovestor.com/*", "http://localhost/*"],
    "js": ["config.js", "bridge.js"], "run_at": "document_start",
    "all_frames": true, "match_origin_as_fallback": true },
  { "matches": ["https://irs.enovestor.com/*", "http://localhost/*"],
    "js": ["screenshot-overlay.js"], "run_at": "document_idle",
    "all_frames": false }
]
```

**Frame support is on by default (decided v0.3).**
- `all_frames: true` runs the hooks and the bridge in **every frame** whose address matches the IRS host, as well as in the main page. `match_origin_as_fallback: true` also covers frames with no real address of their own (`about:blank`, `srcdoc`, `blob:`) created by an IRS page.
- The screenshot overlay runs in the **top frame only** (`all_frames: false`). The screenshot is taken of the whole visible tab anyway, frames included.
- Every event carries `frame`: `"top"`, or the frame's path (e.g. `/reports/viewer`). The service worker gets `sender.frameId` and `sender.url` and adds them. In the txt timeline, events from a frame get the suffix `[frame: /reports/viewer]`.
- Recording state is per **tab**: when a tab is recording, all its frames record.
- FR-25 page snapshot: the top frame collects its own text, then asks each child frame (via the service worker, `chrome.tabs.sendMessage(tabId, msg, { frameId })`) for its snapshot. Each frame's text appears under its own `--- frame: <path> ---` heading.
- **Frames on other domains** (e.g. a report server) are not covered until that domain is added to `hostPatterns` and the manifest. During the first real use, if the extension sees an `<iframe>` whose `src` is on another domain, it writes one `FRAME` line to the timeline (`FRAME  not captured: https://other-host/... (domain not in host list)`) so the gap is visible rather than silent.

Keyboard shortcut for the marker (FR-24):

```json
"commands": {
  "mark-bug": {
    "suggested_key": { "default": "Alt+Shift+B" },
    "description": "Mark the bug moment (while recording)"
  },
  "take-screenshot": {
    "suggested_key": { "default": "Alt+Shift+S" },
    "description": "Select an area to screenshot (while recording)"
  }
}
```

The service worker handles `chrome.commands.onCommand`. It applies the marker to the **active tab only if that tab is recording**; otherwise it ignores the press (and briefly sets the badge to `—`). The page-text snapshot (FR-25) is requested from `bridge.js` → `page-hooks.js` with a message, so it runs in the page.

## 14. Configuration and placeholders

`config.js`:

```js
const EVBC_CONFIG = {
  // MVP: IRS Live only. UAT + enoVestor Web are deferred; add them here AND in manifest.json matches/host_permissions.
  hostPatterns: ["https://irs.enovestor.com/*"],

  // Optional. Known message/toast selectors can be added here later. Nothing depends on this (FR-19 uses generic patterns).
  extraMessageSelectors: [],
  screenshots: { maxCount: 10, jpegAboveBytes: 4_000_000, jpegQuality: 0.9, minBoxPx: 8, linkToMarkerWithinSec: 60 },
  snapshotMaxBytes: 20_000,    // FR-25

  limits: { maxMinutes: 15, maxBytes: 5_000_000, maxEvents: 3000, maxBodyBytes: 20_000, maxTextBytes: 4_000 },
  maskHeaders: ["authorization","cookie","set-cookie","x-api-key","x-auth-token","x-csrf-token","x-xsrf-token","proxy-authorization"],
  maskKeyRegex: "pass(word)?|pwd|secret|token|otp|pin|api[-_]?key|refresh",
  correlationHeaders: ["x-request-id","x-correlation-id","traceparent","request-id"],
};
```

| Placeholder | Question | Owner |
|---|---|---|
| `[TBD-1]` | ✅ Resolved: IRS Live `https://irs.enovestor.com/` only. UAT and enoVestor Web deferred to a later phase. | Will |
| ~~`[TBD-2]`~~ | ~~Error-toast selector~~ Dropped in v0.2: toasts can't all be identified, and logic bugs have none. Replaced by user markers (FR-24). | — |
| `[TBD-3]` | ✅ Resolved: frame support on by default (§13). Open only if a frame on another domain is found; then add that domain. | Will |

## 15. Test fixture and acceptance criteria

Claude Code must build `test/fixture.html` (served from `http://localhost:8080`), so everything can be verified without enoVestor. It needs buttons that:

1. `fetch` GET → 200 JSON
2. `fetch` PUT with a JSON body that contains `password` and `token` keys → 500 with a JSON error body
3. `fetch` to an unreachable port (network error)
4. XHR POST → 400 with a JSON body (`responseType` `""`)
5. XHR GET with `responseType = "json"`
6. A `fetch` that returns 200 with `{"success": false, "error": "Validation failed"}`
7. `console.error(new Error("boom"))` and `console.error` with a circular object
8. `throw new Error("uncaught")` from a `setTimeout`, and `Promise.reject(new Error("rejected"))`
9. Inject a toast `<div class="toast-error">Unexpected error</div>` after 300 ms
10. `history.pushState` to `/fake-route`
11. A button containing a nested `<span>` (tests FR-14 ancestor resolution)
12. A text input, a password input, a `<select>`, a checkbox (for FR-15)
13. A button that returns a 200 response with a body larger than 20 KB (truncation)
14. A "Reload page" link (tests capture across a reload)
15. **Logic-bug scenario:** a small form with "Country" `<select>` + [Save]. Save sends a PUT that returns **200** and shows a `div.toast-success` "Saved successfully", then re-fetches the record, which comes back with the **old** country. The page shows the old value. There is no error anywhere, only the wrong result.
16. A `div.some-random-class` message "Operation failed" injected after 300 ms, to test the generic error classification in FR-19 without a known selector.
17. A **page-received-clicks counter**: a document-level click listener in the fixture that counts clicks and shows the count. Used to prove the screenshot overlay never lets clicks through (AC-21).
18. A **calibration grid**: a 400 × 200 px box with 1 px lines every 50 px and corner labels, at a known position. Used to check crop accuracy (AC-18, AC-19).
19. A **same-origin iframe** (`/frame.html` served by the fixture server) with its own button that makes a fetch → 500 and a text input. Used for AC-25.

Mock the endpoints with a tiny local server (Python `http.server` subclass in `test/server.py` is fine), or with `fetch` to `data:`/`blob:` where a real status code isn't needed. The mock server must be able to return 400, 500, and slow (2 s) responses.

**Acceptance criteria**

| ID | Given / When / Then |
|---|---|
| AC-01 | Given recording is **off**, when every fixture button is clicked, then the app behaves normally and storage has no `rec:*` keys. |
| AC-02 | Given recording is on, when buttons 1–13 are clicked, then the txt contains a correct timeline line for each, in chronological order. |
| AC-03 | Given button 2, then `Authorization` (if sent), `password`, and `token` appear as `[MASKED]` everywhere in the txt, and the unmasked values appear **nowhere** in `chrome.storage.session` (check with DevTools → Application → Extension storage). |
| AC-04 | Given buttons 2, 3, 4, 6, then each is marked `!` and listed under "Technical signals (may be unrelated)". |
| AC-13 | Given scenario 15, when the user presses Alt+Shift+B after the wrong value shows, then the txt has a `🐞 BUG 1` timeline line after the success toast and the re-fetch; the Summary lists 🐞1 with the last 3 API calls before it; and the snapshot section shows the form field "Country" with the **old** value. |
| AC-14 | Given scenario 15 with **no** technical signals, then "Technical signals" says `none`, and the file still clearly points to the bug via the 🐞 marker and the Reported by user section. |
| AC-15 | Given the popup's 🐞 button is pressed 3 times, then markers 🐞1–🐞3 appear in order, each with its own snapshot. |
| AC-16 | Given Alt+Shift+B is pressed on a tab that is **not** recording, then nothing is captured and no error is thrown. |
| AC-18 | Given recording is on, when the user presses Alt+Shift+S and drags exactly around the calibration grid (item 18), then the saved PNG shows the whole grid with no more than **2 CSS px** of extra margin or clipping on any side, and the dimensions equal the box size × scale. |
| AC-19 | AC-18 still passes at browser zoom **125 %** and **80 %** (Ctrl + / Ctrl −), and on a Windows machine with display scaling at **150 %**. |
| AC-20 | The dimming overlay, hint bar, toolbar and toast **never appear** in any saved screenshot. |
| AC-21 | Given the click counter (item 17), when the user draws, redraws, cancels with Esc, and captures, then the counter **does not change**, and there are no `CLICK` events from the overlay in the timeline. |
| AC-22 | Given 2 screenshots, then Download produces **one** `.zip` that opens with the built-in Windows Explorer and macOS Finder unzip. It contains `report.txt` + `screenshot-1.png` + `screenshot-2.png`, and each PNG opens. With 0 screenshots, a plain `.txt` downloads. |
| AC-23 | "Whole screen" saves the full visible tab. The 11th screenshot is refused with "Limit reached". Alt+Shift+S on a tab that isn't recording does nothing. |
| AC-24 | After Discard, and after the browser is fully closed and reopened, no screenshot blobs remain in IndexedDB (DevTools → Application → IndexedDB on the extension's page). |
| AC-25 | Given the iframe (item 19), when the user clicks its button and changes its input, then the CLICK, CHANGE and API lines appear in the timeline with `[frame: /frame.html]`, and a 🐞 snapshot includes a `--- frame: /frame.html ---` section. |
| AC-17 | Given the review page with "Expected" or "Instead" empty, then Download is disabled. Given zero markers, the FR-28 prompt is shown and Download is still allowed once the required fields are filled. |
| AC-05 | Given recording is on, when the page is reloaded (button 14) and more buttons are clicked, then events from before **and** after the reload are all in the txt. |
| AC-06 | Given recording is on, when the service worker is stopped manually (`chrome://serviceworker-internals` or the "service worker" link on the extensions page → Stop), and more buttons are clicked, then no events are lost. |
| AC-07 | Given recording for 15 min (temporarily set `maxMinutes: 1` to test), then it auto-stops, the badge clears, the review page opens, and the header says `Stop reason: time_limit`. |
| AC-08 | Given the recorded tab is closed during recording, then the review page opens with `Stop reason: tab_closed` and all events. |
| AC-09 | Given recording in tab A, when buttons are clicked in tab B (also the fixture), then nothing from tab B is captured. |
| AC-10 | Given button 13, then the response body ends with `…[truncated, original N bytes]`. |
| AC-11 | The extension loads without errors and passes AC-02 on Chrome, Edge, **and** Brave. |
| AC-12 | Given a button that calls `e.stopPropagation()` in its own click handler, the click is still captured. |

**Should-have:** automate AC-01 to AC-10 with Playwright (Python), using `chromium.launch_persistent_context` with `--load-extension` / `--disable-extensions-except`. Extensions require a non-headless or new-headless Chromium.

## 16. Build plan for Claude Code

Build in this order, and **verify each milestone against the fixture before moving on**:

1. **M1 — Skeleton:** manifest, config, popup Start/Stop, per-tab state in `storage.session`, REC badge, review page with an empty txt. (AC-09 partial)
2. **M2 — Network capture:** fetch + XHR hooks, bridge batching, chunked storage. (AC-01, AC-02 partial, AC-05, AC-06)
3. **M3 — Masking + limits:** §8, §9, auto-stop, tab-closed handling. (AC-03, AC-07, AC-08, AC-10)
4. **M4 — UI events + bug markers:** clicks, changes, navigation, console, uncaught, message observer, 🐞 marker (popup + shortcut), page snapshot, frame support. (AC-02 full, AC-12, AC-15, AC-16, AC-25)
5. **M4b — Screenshots:** overlay, capture sequence, crop/scale, IndexedDB, toast/caption. (AC-18 to AC-21, AC-23, AC-24) Test AC-19 on a real Windows laptop with display scaling, not only on a 100 % monitor.
6. **M5 — txt formatter + review page + zip:** `format-txt.js` exactly per §10, the review page with expected/actual and thumbnails, and `zip-store.js`. (AC-04, AC-13, AC-14, AC-17, AC-22)
7. **M6 — Cross-browser pass + README.** (AC-11)

After each milestone, briefly summarise for Will: what was built, how to test it by hand, and anything that differs from this spec, with the reason.

## 17. Known limitations (state these in the README)

- **Reproducing on Live has side effects.** Redoing a save, submit, approval or send repeats it on real investor data. The extension cannot prevent this; FR-03a warns the user, and the README must state it in bold. Read-only steps (open, search, view, filter) are always safe to redo.
- The hooks run inside **IRS Live**, so the wrapper safety rules in §7 apply in full. Run AC-01 (no behaviour change when not recording) on Live with a read-only flow before the Hanoi team uses it.
- Captures only what happens **during the redo**. If the bug doesn't reproduce, the file shows a different (or clean) run. The "Did the bug happen again?" answer is the guard.
- The extension **does not know what a bug is**. Logic bugs (success shown, wrong result) leave no technical trace. The file is only as good as the user's 🐞 marker and their "expected vs instead" text. Technical signals are hints and can be unrelated noise.
- The page snapshot is **text only**. Visual problems (layout, wrong colour or highlight, an element hidden) won't show in it. Use 📷 screenshots for those.
- Screenshots cover only the **currently visible** part of the page. To show something lower down, scroll and take another screenshot (no full-page stitching in the MVP).
- Screenshots **cannot be masked**: they show exactly what's on screen, investor data included. That is acceptable under the MVP approval. Password fields already render as dots.
- If the wrong value is calculated in the browser rather than returned by the API, the API bodies will look correct. The snapshot is then the only evidence of what was shown.
- Requests not made via page-level fetch/XHR (classic form posts, the app's own service worker, WebSockets, frames on domains not in the host list) are not captured unless FR-23 is built.
- Captures are lost when the browser closes, by design.
- Shows symptoms only. Root cause usually needs server logs. Correlation IDs (FR-22), when present, are how to find them.

## 18. Later phases (not for this build — context only)

- **Phase 2:** create a Jira issue from the capture (REST API + attachment).
- **Phase 3:** optional PII redaction rules, and wider rollout beyond the Hanoi team.
- **Possible:** turn a captured click/API sequence into a Playwright regression test.
