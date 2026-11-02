/*
 * review.js — logic for the review page (FR-30 to FR-34).
 *
 * The page knows which capture to show from its address: review.html?tabId=<id>.
 * It asks the service worker for the capture and for the report text, then offers:
 *   - Download (FR-32): builds the file right here with a Blob + a temporary <a download> link.
 *     (The service worker can't do this: MV3 service workers have no URL.createObjectURL.)
 *   - Copy to clipboard (FR-34)
 *   - Discard (FR-33): deletes the capture from storage.
 */

const tabId = Number(new URLSearchParams(location.search).get("tabId"));
const $ = (id) => document.getElementById(id);

let txt = "";
let fileStamp = "";
let downloaded = false;

function send(msg) {
  return chrome.runtime.sendMessage(Object.assign({ tabId }, msg));
}

function flash(text) {
  $("msg").textContent = text;
  setTimeout(() => { if ($("msg").textContent === text) $("msg").textContent = ""; }, 4000);
}

async function load() {
  const cap = await send({ type: "getCapture" });
  if (!cap || !cap.ok) { $("missing").hidden = false; $("content").hidden = true; return; }
  const m = cap.meta;

  const secs = ((m.stoppedAt || Date.now()) - m.startedAt) / 1000;
  $("s-duration").textContent = secs.toFixed(1) + " s";
  $("s-events").textContent = String(cap.events.length);
  $("s-markers").textContent = "0";
  $("s-signals").textContent = "none";
  $("s-reason").textContent = m.status === "recording" ? "(still recording)" : m.stopReason;
  $("s-url").textContent = m.url;

  const built = await send({ type: "buildTxt", report: {} });
  if (built && built.ok) {
    txt = built.txt;
    fileStamp = built.fileStamp;
    $("preview").textContent = txt.split("\n").slice(0, 200).join("\n");
  }
  $("content").hidden = false;
}

$("btn-download").addEventListener("click", () => {
  // A Blob is an in-memory file. createObjectURL gives it a temporary address, and clicking an
  // <a download="name"> pointing at that address makes the browser save it. Nothing leaves the PC.
  const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "enovestor-bug_" + fileStamp + ".txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000); // free the memory once the save has started
  downloaded = true;
  flash("Downloaded " + a.download);
});

$("btn-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(txt);
    flash("Copied to clipboard");
  } catch (e) {
    flash("Copy failed: " + e.message);
  }
});

$("btn-discard").addEventListener("click", async () => {
  const q = downloaded ? "Delete this capture from the browser?" : "You haven't downloaded this capture yet. Delete it anyway?";
  if (!confirm(q)) return;
  const res = await send({ type: "discard" });
  if (res && res.ok) { $("content").hidden = true; $("missing").hidden = false; }
  else flash("Couldn't discard: " + (res && res.error));
});

load();
