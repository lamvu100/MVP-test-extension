/*
 * service-worker.js — the extension's "back office" (SPEC §5).
 *
 * What it does in M1:
 *   - keeps the recording state of each tab (Start / Stop / Discard)
 *   - shows the red REC badge on the recorded tab only (FR-04)
 *   - opens the review page when recording stops (FR-06)
 *   - builds the report text for the review page (via format-txt.js)
 *
 * The most important rule (SPEC §5.2, CLAUDE.md hard rule 4):
 *   Chrome switches this worker OFF after ~30 seconds of quiet and starts it again on the next
 *   message. Anything kept only in a JavaScript variable here is wiped when that happens.
 *   Analogy: a receptionist who goes home whenever the lobby is empty — they must write
 *   everything in the ledger (chrome.storage.session), never keep it in their head.
 *   So every piece of state is read from / written to chrome.storage.session.
 *
 * chrome.storage.session lives in the browser's memory: it survives this worker restarting
 * and the page reloading, and it is wiped when the browser closes (captures are meant to be
 * temporary).
 *
 * Storage keys:
 *   rec:<tabId>:meta        – the recording record for one tab (see newMeta below)
 *   rec:<tabId>:chunk:<n>   – batches of events (from M2)
 *   ui:liveWarningAck       – true once the user ticked "I understand" this browser session (FR-03a)
 *
 * One recording at a time (agreed change F): only one tab may be recording, and starting a new
 * recording deletes any older stopped capture (after the popup asks the user to confirm). This
 * keeps us well under the 10 MB storage.session limit.
 */

importScripts("config.js", "format-txt.js");

const KEY_ACK = "ui:liveWarningAck";
const metaKey = (tabId) => `rec:${tabId}:meta`;
const recPrefix = (tabId) => `rec:${tabId}:`;
const META_KEY_RE = /^rec:(\d+):meta$/;

/* ------------------------------------------------------------------------------------------
 * Serial queue per tab (SPEC §5.2 point 5).
 * Two messages for the same tab (e.g. "stop" arriving while a batch of events is being saved)
 * must not interleave their read-then-write steps, or one would overwrite the other.
 * Each tab gets a promise chain: each job starts only after the previous one finished.
 * Losing this Map when the worker sleeps is harmless — it only orders work in progress,
 * it holds no data.
 * ---------------------------------------------------------------------------------------- */
const queues = new Map();
function enqueue(tabId, job) {
  const prev = queues.get(tabId) || Promise.resolve();
  const next = prev.catch(() => {}).then(job);
  queues.set(tabId, next.catch(() => {}));
  return next;
}

/* ------------------------------------------------------------------------------------------
 * Host check (FR-02). Turns a match pattern such as "https://irs.enovestor.com/*" into a test.
 * Like Chrome's own patterns, a pattern without a port matches any port (localhost:8080).
 * ---------------------------------------------------------------------------------------- */
function urlMatchesPattern(url, pattern) {
  const m = /^(https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!m) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== m[1] + ":") return false;
  if (u.hostname !== m[2]) return false; // u.hostname has no port, so any port is accepted
  const pathRe = new RegExp("^" + m[3].split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return pathRe.test(u.pathname + u.search);
}
function isRecordableUrl(url) {
  return !!url && EVBC_CONFIG.hostPatterns.some((p) => urlMatchesPattern(url, p));
}

/* ------------------------------------------------------------------------------------------
 * Browser details for the report header (FR-21, the parts the background can see).
 * Window and screen size need the page and are added with the page hooks later.
 * ---------------------------------------------------------------------------------------- */
async function collectBrowserEnv() {
  const env = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  try {
    const uad = navigator.userAgentData;
    if (uad) {
      const hi = await uad.getHighEntropyValues(["fullVersionList", "platformVersion"]);
      const list = hi.fullVersionList || uad.brands || [];
      // Pick the real brand, not "Chromium" or the deliberately fake "Not=A?Brand" entry.
      const pick = (name) => list.find((b) => b.brand === name);
      const brand = pick("Google Chrome") || pick("Microsoft Edge") || pick("Brave") || pick("Opera") ||
        list.find((b) => !/not.?a.?brand/i.test(b.brand) && b.brand !== "Chromium") || pick("Chromium");
      let os = uad.platform || "?";
      // Windows 11 reports platformVersion 13 or higher; Windows 10 reports lower.
      if (os === "Windows" && hi.platformVersion) os = parseInt(hi.platformVersion, 10) >= 13 ? "Windows 11" : "Windows 10";
      const shortVer = brand ? brand.version.split(".").slice(0, 2).join(".") : "?";
      env.browser = (brand ? brand.brand.replace("Google ", "").replace("Microsoft ", "") : "Chromium") + " " + shortVer + " / " + os;
    } else {
      env.browser = navigator.userAgent;
    }
  } catch {
    env.browser = navigator.userAgent;
  }
  return env;
}

/* ------------------------------------------------------------------------------------------
 * Storage helpers
 * ---------------------------------------------------------------------------------------- */
async function getMeta(tabId) {
  const got = await chrome.storage.session.get(metaKey(tabId));
  return got[metaKey(tabId)] || null;
}
async function setMeta(tabId, meta) {
  await chrome.storage.session.set({ [metaKey(tabId)]: meta });
}
/* All recording records, as [{tabId, meta}] */
async function allMetas() {
  const everything = await chrome.storage.session.get(null);
  const out = [];
  for (const [k, v] of Object.entries(everything)) {
    const m = META_KEY_RE.exec(k);
    if (m) out.push({ tabId: Number(m[1]), meta: v });
  }
  return out;
}
/* Deletes rec:<tabId>:* (meta + event chunks). Screenshots (IndexedDB) are added in M4b. */
async function deleteCapture(tabId) {
  const everything = await chrome.storage.session.get(null);
  const keys = Object.keys(everything).filter((k) => k.startsWith(recPrefix(tabId)));
  if (keys.length) await chrome.storage.session.remove(keys);
}

/* ------------------------------------------------------------------------------------------
 * Badge (FR-04). Passing tabId makes the badge appear on THAT tab only.
 * ---------------------------------------------------------------------------------------- */
async function showRecBadge(tabId) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#d62828" });
    await chrome.action.setBadgeText({ tabId, text: "REC" });
  } catch { /* tab may have closed; nothing to show */ }
}
async function clearBadge(tabId) {
  try { await chrome.action.setBadgeText({ tabId, text: "" }); } catch { /* tab gone */ }
}

/* Opens review.html for a tab, right next to it (FR-06). A separate tab is used because a
 * popup closes the moment it loses focus, which would throw away a half-typed note. */
async function openReview(tabId) {
  const url = chrome.runtime.getURL(`review.html?tabId=${tabId}`);
  let opts = { url };
  try {
    const t = await chrome.tabs.get(tabId);
    opts = { url, index: t.index + 1, windowId: t.windowId, openerTabId: tabId };
  } catch { /* recorded tab already closed: just open a normal new tab */ }
  await chrome.tabs.create(opts);
}

/* ------------------------------------------------------------------------------------------
 * Message handlers
 * ---------------------------------------------------------------------------------------- */

/* status: everything the popup needs to decide what to show. */
async function handleStatus(tabId) {
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { /* closed */ }
  const metas = await allMetas();
  const own = metas.find((x) => x.tabId === tabId);
  const otherRec = metas.find((x) => x.tabId !== tabId && x.meta.status === "recording");
  const otherStopped = metas.find((x) => x.tabId !== tabId && x.meta.status === "stopped");
  let otherTitle = null;
  if (otherRec) { try { otherTitle = (await chrome.tabs.get(otherRec.tabId)).title; } catch {} }
  const ack = (await chrome.storage.session.get(KEY_ACK))[KEY_ACK] === true;
  return {
    ok: true,
    tabId,
    canRecord: !!tab && isRecordableUrl(tab.url),
    meta: own ? own.meta : null,
    otherRecording: otherRec ? { tabId: otherRec.tabId, title: otherTitle, startedAt: otherRec.meta.startedAt } : null,
    otherStopped: otherStopped ? { tabId: otherStopped.tabId, stoppedAt: otherStopped.meta.stoppedAt } : null,
    liveWarningAck: ack,
  };
}

/* start (FR-02, FR-03a, FR-05, FR-09). */
async function handleStart(tabId, confirmDiscard) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return { ok: false, error: "tab_not_found" }; }
  if (!isRecordableUrl(tab.url)) return { ok: false, error: "not_enovestor" };

  const ack = (await chrome.storage.session.get(KEY_ACK))[KEY_ACK] === true;
  if (!ack) return { ok: false, error: "warning_not_acknowledged" };

  const metas = await allMetas();
  if (metas.some((x) => x.meta.status === "recording")) return { ok: false, error: "already_recording" };
  // Any stopped-but-not-discarded capture (this tab or another) is deleted on Start,
  // but only after the user confirmed in the popup.
  if (metas.length && !confirmDiscard) return { ok: false, needConfirm: true };
  for (const x of metas) await deleteCapture(x.tabId);

  const meta = {
    status: "recording",
    startedAt: Date.now(),
    stoppedAt: null,
    stopReason: null,
    url: tab.url,
    eventCount: 0,
    bytes: 0,
    nextSeq: 0,
    extVersion: chrome.runtime.getManifest().version,
    env: await collectBrowserEnv(),
  };
  await setMeta(tabId, meta);
  await showRecBadge(tabId);
  return { ok: true, meta };
}

/* stop (FR-06). `reason` is "user" now; M3 adds time_limit / size_limit / event_limit / tab_closed. */
async function handleStop(tabId, reason) {
  const meta = await getMeta(tabId);
  if (!meta || meta.status !== "recording") return { ok: false, error: "not_recording" };
  meta.status = "stopped";
  meta.stoppedAt = Date.now();
  meta.stopReason = reason || "user";
  await setMeta(tabId, meta);
  await clearBadge(tabId);
  await openReview(tabId);
  return { ok: true, meta };
}

async function handleDiscard(tabId) {
  const meta = await getMeta(tabId);
  if (meta && meta.status === "recording") return { ok: false, error: "still_recording" };
  await deleteCapture(tabId);
  return { ok: true };
}

/* getCapture: the review page asks for the record + events. Events arrive in M2. */
async function handleGetCapture(tabId) {
  const meta = await getMeta(tabId);
  if (!meta) return { ok: false, error: "no_capture" };
  return { ok: true, meta, events: [] };
}

async function handleBuildTxt(tabId, report) {
  const meta = await getMeta(tabId);
  if (!meta) return { ok: false, error: "no_capture" };
  return { ok: true, txt: formatTxt({ meta, events: [], report: report || {} }), fileStamp: evbcFileStamp(meta.startedAt) };
}

/* Only the extension's own pages (popup, review page) may control recording.
 * Content scripts running inside a web page also share our extension id, so we check the
 * sender's URL instead: it must be one of our chrome-extension:// pages. */
function isFromExtensionPage(sender) {
  return typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg.type !== "string") return { ok: false, error: "bad_message" };
    if (!isFromExtensionPage(sender)) return { ok: false, error: "not_allowed" };
    const tabId = Number(msg.tabId);
    switch (msg.type) {
      case "status": return handleStatus(tabId);
      case "ackWarning":
        await chrome.storage.session.set({ [KEY_ACK]: true });
        return { ok: true };
      case "start": return enqueue(tabId, () => handleStart(tabId, !!msg.confirmDiscard));
      case "stop": return enqueue(tabId, () => handleStop(tabId, "user"));
      case "discard": return enqueue(tabId, () => handleDiscard(tabId));
      case "openReview": await openReview(tabId); return { ok: true };
      case "getCapture": return handleGetCapture(tabId);
      case "buildTxt": return handleBuildTxt(tabId, msg.report);
      default: return { ok: false, error: "unknown_type" };
    }
  })().then(sendResponse, (err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // tells Chrome we will answer asynchronously
});

/* Chrome resets a tab's own badge when the tab loads a new page, so the REC badge would
 * disappear after the recommended refresh. Put it back whenever a recording tab starts loading. */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  const meta = await getMeta(tabId);
  if (meta && meta.status === "recording") await showRecBadge(tabId);
});
