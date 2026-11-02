/*
 * popup.js — logic for the popup window (SPEC §11, FR-01 to FR-09).
 *
 * The popup is short-lived: Chrome destroys it as soon as it loses focus. So it keeps nothing
 * important itself. Every time it opens it asks the service worker "what is the state of this
 * tab?" and draws the matching screen. Buttons just send a message to the service worker.
 *
 * Testing note: normally the popup works on the tab you are looking at. For automated tests,
 * opening popup.html?tabId=123 as a normal page makes it act on tab 123 instead.
 */

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

let tabId = null;        // the tab this popup is about
let state = null;        // last answer from the service worker
let justStarted = false; // true right after the user pressed Start in this popup

function send(msg) {
  return chrome.runtime.sendMessage(Object.assign({ tabId }, msg));
}

function showError(text) {
  $("error").textContent = text || "";
  $("error").hidden = !text;
}

/* Shows exactly one view (one <section>). */
function show(viewId) {
  for (const s of document.querySelectorAll("section")) s.hidden = s.id !== viewId;
}

function mmss(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
}

/* Draws the right screen for the current state. */
function render() {
  const s = state;
  if (s.meta && s.meta.status === "recording") {
    show("view-recording");
    $("rec-elapsed").textContent = mmss(Date.now() - s.meta.startedAt);
    $("rec-events").textContent = s.meta.eventCount;
    $("rec-just-started").hidden = !justStarted;
    return;
  }
  if (s.otherRecording) {
    show("view-other");
    $("other-title").textContent = s.otherRecording.title || "(untitled tab)";
    return;
  }
  if (s.meta && s.meta.status === "stopped") {
    show("view-stopped");
    $("stopped-reason").textContent = s.meta.stopReason || "user";
    return;
  }
  if (!s.canRecord) { show("view-nohost"); return; }
  show("view-idle");
  $("idle-old-capture").hidden = !s.otherStopped;
}

async function refreshState() {
  const res = await send({ type: "status" });
  if (!res || !res.ok) { showError("Couldn't read the recording state: " + (res && res.error)); return; }
  state = res;
  render();
}

/* Start: first the live-data warning (once per browser session), then the actual start.
 * If an older capture exists, ask before deleting it (FR-09). */
async function doStart() {
  showError("");
  let res = await send({ type: "start" });
  if (res && res.needConfirm) {
    const yes = confirm("Starting a new recording will delete the previous capture.\n\nHave you already downloaded it?");
    if (!yes) return;
    res = await send({ type: "start", confirmDiscard: true });
  }
  if (!res || !res.ok) {
    const why = {
      not_enovestor: "This page is not an enoVestor page.",
      already_recording: "A recording is already running in another tab.",
      warning_not_acknowledged: "Please tick “I understand” first.",
    }[res && res.error] || (res && res.error);
    showError("Couldn't start: " + why);
    await refreshState();
    return;
  }
  justStarted = true;
  await refreshState();
}

function onStartClicked() {
  if (state.liveWarningAck) { doStart(); return; }
  $("chk-understand").checked = false;
  $("btn-warning-start").disabled = true;
  show("view-warning");
}

/* --- button wiring ------------------------------------------------------------------- */
$("btn-start").addEventListener("click", onStartClicked);
$("btn-start-again").addEventListener("click", onStartClicked);
$("chk-understand").addEventListener("change", (e) => { $("btn-warning-start").disabled = !e.target.checked; });
$("btn-warning-start").addEventListener("click", async () => {
  await send({ type: "ackWarning" });
  state.liveWarningAck = true;
  await doStart();
});
$("btn-warning-cancel").addEventListener("click", render);

$("btn-refresh").addEventListener("click", () => chrome.tabs.reload(tabId)); // FR-03
$("btn-stop").addEventListener("click", async () => {
  const res = await send({ type: "stop" });
  if (!res || !res.ok) { showError("Couldn't stop: " + (res && res.error)); return; }
  // The service worker opens the review page; the popup is no longer needed.
  window.close();
});

$("btn-open-review").addEventListener("click", async () => { await send({ type: "openReview" }); window.close(); });
$("btn-idle-open-review").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "openReview", tabId: state.otherStopped.tabId });
  window.close();
});
$("btn-discard").addEventListener("click", async () => {
  if (!confirm("Delete this capture? Make sure you have downloaded it first.")) return;
  await send({ type: "discard" });
  justStarted = false;
  await refreshState();
});
$("btn-goto-other").addEventListener("click", async () => {
  const other = await chrome.tabs.get(state.otherRecording.tabId);
  await chrome.tabs.update(other.id, { active: true });
  await chrome.windows.update(other.windowId, { focused: true });
  window.close();
});

/* --- start-up -------------------------------------------------------------------------- */
(async () => {
  if (params.has("tabId")) {
    tabId = Number(params.get("tabId"));
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab ? tab.id : null;
  }
  if (tabId == null) { show("view-nohost"); return; }
  await refreshState();
  // Keep the clock smooth (redrawn 4× a second from the stored start time) and re-ask the
  // service worker once a second for the event count, while the popup is open.
  const recording = () => state && state.meta && state.meta.status === "recording";
  setInterval(() => {
    if (recording()) $("rec-elapsed").textContent = mmss(Date.now() - state.meta.startedAt);
  }, 250);
  setInterval(() => { if (recording()) refreshState(); }, 1000);
})();
