/*
 * format-txt.js — turns a finished capture into the plain-text report (SPEC §10).
 *
 * It is a "pure function": data in, text out. It reads nothing, stores nothing and sends
 * nothing. That makes it easy to test and safe to load in two places:
 *   - the service worker (via importScripts) answers the review page's "buildTxt" request
 *   - the review page could also call it directly if ever needed
 *
 * M1 STATUS: only the header and the empty section skeleton are produced. The timeline,
 * API details, snapshots etc. are filled in from M2 onwards, and M5 makes the whole layout
 * match §10 exactly. Section headings already use the final wording so the file layout
 * stays stable.
 */

/* Pads a number with leading zeros: pad(7, 2) → "07". */
function evbcPad(n, width) {
  return String(n).padStart(width, "0");
}

/* "+07:00" style offset for a given moment (local time zone of this browser). */
function evbcUtcOffset(ms) {
  // getTimezoneOffset() is minutes BEHIND UTC (Hanoi gives -420), so flip the sign.
  const off = -new Date(ms).getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return sign + evbcPad(Math.floor(abs / 60), 2) + ":" + evbcPad(abs % 60, 2);
}

/* Full ISO 8601 local time with milliseconds and offset: 2026-11-02T10:57:39.880+07:00 */
function evbcIsoLocal(ms) {
  const d = new Date(ms);
  return (
    d.getFullYear() + "-" + evbcPad(d.getMonth() + 1, 2) + "-" + evbcPad(d.getDate(), 2) +
    "T" + evbcPad(d.getHours(), 2) + ":" + evbcPad(d.getMinutes(), 2) + ":" + evbcPad(d.getSeconds(), 2) +
    "." + evbcPad(d.getMilliseconds(), 3) + evbcUtcOffset(ms)
  );
}

/* Timeline time: local 10:57:39.880 */
function evbcClock(ms) {
  const d = new Date(ms);
  return evbcPad(d.getHours(), 2) + ":" + evbcPad(d.getMinutes(), 2) + ":" +
    evbcPad(d.getSeconds(), 2) + "." + evbcPad(d.getMilliseconds(), 3);
}

/* File-name stamp: 20261102-105739 (local time), used for enovestor-bug_<stamp>.txt */
function evbcFileStamp(ms) {
  const d = new Date(ms);
  return d.getFullYear() + evbcPad(d.getMonth() + 1, 2) + evbcPad(d.getDate(), 2) + "-" +
    evbcPad(d.getHours(), 2) + evbcPad(d.getMinutes(), 2) + evbcPad(d.getSeconds(), 2);
}

/* A section heading line, e.g. "==================== Summary ====================" */
function evbcHeading(title) {
  return "==================== " + title + " ====================";
}

/*
 * Main entry point.
 *   capture.meta   – the rec:<tabId>:meta record (start/stop time, reason, URL, env …)
 *   capture.events – the recorded events (always [] in M1)
 *   capture.report – the user's answers from the review page (empty in M1; added in M5)
 * Returns the whole report as one string with LF line endings.
 */
function formatTxt(capture) {
  const meta = capture.meta || {};
  const events = capture.events || [];
  const env = meta.env || {};
  const L = []; // lines

  const endMs = meta.stoppedAt || Date.now();
  const seconds = meta.startedAt ? ((endMs - meta.startedAt) / 1000).toFixed(1) : "?";

  L.push(evbcHeading("enoVestor Bug Capture"));
  L.push("Format:        EVBC-TXT v1");
  L.push("Captured:      " + (meta.startedAt ? evbcIsoLocal(meta.startedAt) : "?") + "  →  " +
    (meta.stoppedAt ? evbcIsoLocal(meta.stoppedAt) : "(still recording)") + "  (" + seconds + " s)");
  L.push("Stop reason:   " + (meta.stopReason || "-"));
  L.push("Start URL:     " + (meta.url || "?"));
  L.push("Timezone:      " + (env.timezone || "?") + " (UTC" + (meta.startedAt ? evbcUtcOffset(meta.startedAt) : "?") + ")");
  L.push("Browser:       " + (env.browser || "?"));
  // Window/screen size can only be measured inside the page; that arrives with the page hooks (M2/M4).
  L.push("Window:        " + (env.window || "(not captured yet)"));
  L.push("Extension:     v" + (meta.extVersion || "?"));
  L.push("");

  L.push(evbcHeading("Reported by user"));
  L.push("(The review-page questions are added in milestone M5.)");
  L.push("");

  L.push(evbcHeading("Summary"));
  L.push("Events: " + events.length + "   API calls: 0   Bug markers: 0   Screenshots: 0");
  L.push("Technical signals (may be unrelated): none");
  L.push("");
  L.push('Bug markers: none (user did not mark the moment; see "Instead" above)');
  L.push("");

  L.push(evbcHeading("Timeline"));
  L.push(events.length ? "" : "(no events captured — event capture starts in milestone M2)");
  L.push("");

  L.push(evbcHeading("End"));
  return L.join("\n") + "\n";
}
