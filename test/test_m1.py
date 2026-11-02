#!/usr/bin/env python3
"""
test/test_m1.py — automated checks for milestone M1 (skeleton).

Starts test/server.py, launches Chromium with the extension in ../evbc loaded, and walks
through Start → refresh → service-worker restart → Stop → review → Download → Discard.
Prints one PASS/FAIL line per check.

Needs:  pip install playwright   (and a Chromium; set EVBC_CHROMIUM=/path/to/chrome if
Playwright's own browser isn't installed). Extensions need a visible browser window, so on
a machine without a screen run it under xvfb:   xvfb-run -a python3 test/test_m1.py
"""
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "evbc")
PORT = 8080
BASE = f"http://localhost:{PORT}"

results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS  " if ok else "FAIL  ") + name + (f"   [{detail}]" if detail and not ok else ""))


def start_server():
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "test", "server.py"), str(PORT)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + "/api/item", timeout=1)
            return proc
        except Exception:
            time.sleep(0.1)
    proc.kill()
    raise RuntimeError("test server did not start")


def main():
    server = start_server()
    profile = tempfile.mkdtemp(prefix="evbc-profile-")
    page_errors = []
    try:
        with sync_playwright() as p:
            launch = dict(headless=False, args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
            exe = os.environ.get("EVBC_CHROMIUM") or ("/opt/pw-browsers/chromium" if os.path.exists("/opt/pw-browsers/chromium") else None)
            if exe and os.path.isdir(exe):  # /opt/pw-browsers/chromium may be a folder of versions
                found = [os.path.join(dp, "chrome") for dp, _, fs in os.walk(exe) if "chrome" in fs]
                exe = found[0] if found else None
            if exe:
                launch["executable_path"] = exe
            ctx = p.chromium.launch_persistent_context(profile, **launch)
            ctx.on("dialog", lambda d: d.accept())  # auto-answer "OK" to confirm() prompts

            sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
            ext_id = sw.url.split("/")[2]
            check("Extension loads and its service worker starts", sw.url.endswith("/service-worker.js"))

            def get_sw():
                live = [w for w in ctx.service_workers if ext_id in w.url]
                return live[-1] if live else ctx.wait_for_event("serviceworker")

            def storage():
                return get_sw().evaluate("chrome.storage.session.get(null)")

            def rec_keys():
                return sorted(k for k in storage() if k.startswith("rec:"))

            def badge(tab_id):
                return get_sw().evaluate(f"chrome.action.getBadgeText({{tabId: {tab_id}}})")

            def tab_id_for(url_part):
                tabs = get_sw().evaluate("chrome.tabs.query({})")
                return next(t["id"] for t in tabs if url_part in (t.get("url") or ""))

            def open_popup(tab_id):
                pg = ctx.new_page()
                pg.on("pageerror", lambda e: page_errors.append(f"popup: {e}"))
                pg.goto(f"chrome-extension://{ext_id}/popup.html?tabId={tab_id}")
                pg.wait_for_function("[...document.querySelectorAll('section')].some(s => !s.hidden)")
                return pg

            def visible_view(pg):
                return pg.evaluate("[...document.querySelectorAll('section')].find(s => !s.hidden)?.id")

            # ---- the fixture itself works (no extension involvement in M1) -------------
            tab_a = ctx.pages[0] if ctx.pages else ctx.new_page()
            tab_a.on("pageerror", lambda e: None)  # fixture item 8 throws on purpose
            tab_a.goto(BASE + "/?tab=A")
            statuses = tab_a.evaluate("""async () => {
                const s = async (u, o) => { try { return (await fetch(u, o)).status } catch { return 'neterr' } };
                return [await s('/api/item'), await s('/api/item', {method:'PUT', body:'{}'}), await s('http://localhost:1/'),
                        await s('/api/xhr-bad', {method:'POST', body:'{}'}), await s('/api/soft-fail'), await s('/api/big'),
                        await s('/api/record', {method:'PUT', body:'{}'}), await s('/frame.html')];
            }""")
            check("Fixture server returns the planned statuses", statuses == [200, 500, "neterr", 400, 200, 200, 200, 200], str(statuses))
            for bid in ["btn-1", "btn-2", "btn-3", "btn-4", "btn-5", "btn-6", "btn-7", "btn-8", "btn-9", "btn-10",
                        "btn-nested", "btn-13", "btn-save", "btn-16", "btn-stopprop"]:
                tab_a.click("#" + bid)
            tab_a.wait_for_timeout(800)
            logtxt = tab_a.inner_text("#log")
            check("Fixture buttons all run (result log has 15 entries)", len(logtxt.strip().splitlines()) >= 15, logtxt)
            check("Fixture logic bug: record still says MY after saving SG-or-other",
                  "record now says MY" in logtxt, logtxt)
            check("Fixture click counter counts page clicks", int(tab_a.inner_text("#click-counter")) >= 15)
            check("Recording off: no rec:* keys in storage (AC-01, M1 part)", rec_keys() == [], str(rec_keys()))
            tab_a.goto(BASE + "/?tab=A")

            tab_b = ctx.new_page()
            tab_b.goto(BASE + "/?tab=B")
            tab_other = ctx.new_page()
            tab_other.goto(f"http://127.0.0.1:{PORT}/?tab=notlisted")  # 127.0.0.1 is NOT in the host list
            id_a, id_b, id_other = tab_id_for("tab=A"), tab_id_for("tab=B"), tab_id_for("tab=notlisted")

            # ---- FR-02: not an enoVestor page --------------------------------------------
            pg = open_popup(id_other)
            check("Popup on a non-enoVestor page says 'Open an enoVestor page' (FR-02)",
                  visible_view(pg) == "view-nohost" and "Open an enoVestor page" in pg.inner_text("body"))
            pg.close()

            # ---- Start with the live-data warning ------------------------------------------
            pg = open_popup(id_a)
            check("Popup on the fixture shows Start (idle)", visible_view(pg) == "view-idle")
            pg.click("#btn-start")
            check("Start shows the IRS Live warning first (FR-03a)", visible_view(pg) == "view-warning")
            check("Warning's Start is disabled until 'I understand' is ticked", pg.is_disabled("#btn-warning-start"))
            pg.check("#chk-understand")
            pg.click("#btn-warning-start")
            pg.wait_for_selector("#view-recording:not([hidden])")
            check("After Start the popup shows Recording + the refresh hint (FR-01, FR-03)",
                  pg.is_visible("#rec-just-started") and pg.is_visible("#btn-refresh"))
            meta = storage().get(f"rec:{id_a}:meta", {})
            check("rec:<tabA>:meta is status=recording in storage.session", meta.get("status") == "recording", str(meta))
            check("Only tab A has a recording record (AC-09 partial)", rec_keys() == [f"rec:{id_a}:meta"], str(rec_keys()))
            check("REC badge on tab A only (FR-04)", badge(id_a) == "REC" and badge(id_b) == "", f"A={badge(id_a)!r} B={badge(id_b)!r}")
            pg.wait_for_timeout(2100)
            check("Popup timer counts up", pg.inner_text("#rec-elapsed") >= "00:02", pg.inner_text("#rec-elapsed"))
            pg.close()

            pg = open_popup(id_b)
            check("Popup on tab B says recording is in another tab (one at a time)", visible_view(pg) == "view-other")
            pg.close()

            # ---- Refresh page for me (FR-03) keeps state and badge --------------------------
            pg = open_popup(id_a)
            with tab_a.expect_navigation():
                pg.click("#btn-refresh")
            pg.close()
            tab_a.wait_for_load_state()
            tab_a.wait_for_timeout(300)
            check("After 'Refresh page for me': still recording and badge still REC",
                  storage()[f"rec:{id_a}:meta"]["status"] == "recording" and badge(id_a) == "REC", repr(badge(id_a)))

            # ---- Service worker restart loses nothing (SPEC §5.2) ---------------------------
            old_sw = get_sw()
            old_sw.evaluate("self.__evbcMarker = 'old'")
            cdp = ctx.new_cdp_session(tab_b)
            cdp.send("ServiceWorker.enable")
            cdp.send("ServiceWorker.stopAllWorkers")
            time.sleep(1)
            pg = open_popup(id_a)  # this message wakes a fresh service worker
            new_sw = get_sw()
            fresh = new_sw.evaluate("typeof self.__evbcMarker") == "undefined"
            check("Service worker really restarted", fresh)
            check("After SW restart the popup still shows Recording", visible_view(pg) == "view-recording")

            # ---- Stop → review page ---------------------------------------------------------
            with ctx.expect_page() as review_info:
                pg.click("#btn-stop")
            review = review_info.value
            review.on("pageerror", lambda e: page_errors.append(f"review: {e}"))
            review.wait_for_selector("#content:not([hidden])")
            check("Stop opens review.html?tabId=<tab A> in a new tab (FR-06)", f"review.html?tabId={id_a}" in review.url, review.url)
            meta = storage()[f"rec:{id_a}:meta"]
            check("Stopped: status=stopped, stopReason=user", meta["status"] == "stopped" and meta["stopReason"] == "user", str(meta))
            check("Stop clears the badge", badge(id_a) == "", repr(badge(id_a)))
            preview = review.inner_text("#preview")
            check("Review preview has the report header", "Format:        EVBC-TXT v1" in preview and "Stop reason:   user" in preview, preview[:300])
            check("Review shows Start URL of tab A", "tab=A" in review.inner_text("#s-url"))

            with review.expect_download() as dl_info:
                review.click("#btn-download")
            dl = dl_info.value
            check("Download file name is enovestor-bug_YYYYMMDD-HHmmss.txt (FR-32)",
                  re.fullmatch(r"enovestor-bug_\d{8}-\d{6}\.txt", dl.suggested_filename) is not None, dl.suggested_filename)
            content = open(dl.path(), encoding="utf-8").read()
            check("Downloaded file starts with the report header",
                  content.startswith("==================== enoVestor Bug Capture ====================\n"))
            check("Downloaded file uses LF line endings only", "\r" not in content)

            # ---- Stopped state in popup, start again (FR-09) --------------------------------
            pg = open_popup(id_a)
            check("Popup shows the stopped capture with Open review / Discard", visible_view(pg) == "view-stopped")
            pg.click("#btn-start-again")  # confirm() is auto-accepted
            pg.wait_for_selector("#view-recording:not([hidden])")
            check("Start again: no second warning this session, old capture replaced",
                  storage()[f"rec:{id_a}:meta"]["status"] == "recording")
            with ctx.expect_page() as review_info:
                pg.click("#btn-stop")
            review2 = review_info.value
            review2.wait_for_selector("#content:not([hidden])")
            review2.click("#btn-discard")  # confirm() auto-accepted
            review2.wait_for_selector("#missing:not([hidden])")
            check("Discard deletes rec:<tab>:* from storage (FR-33)", rec_keys() == [], str(rec_keys()))

            check("No JavaScript errors on the popup or review pages", not page_errors, "; ".join(page_errors))
            ctx.close()
    finally:
        server.kill()

    passed = sum(results)
    print(f"\n{passed}/{len(results)} checks passed")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
