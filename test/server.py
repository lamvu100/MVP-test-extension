#!/usr/bin/env python3
"""
test/server.py — tiny local web server for the test fixture (SPEC §15).

Serves fixture.html and frame.html from this folder, plus fake API endpoints that return
the status codes the tests need (200, 400, 500, slow 2 s, a big body, a "logic bug" record).
Nothing here talks to enoVestor. Python's standard library only; nothing to install.

Run it:
    python3 test/server.py          (macOS / Linux)
    py test\\server.py              (Windows)
Then open http://localhost:8080/ . Stop it with Ctrl+C.

Optional: a different port as the first argument, e.g.  python3 test/server.py 8081
"""
import json
import os
import secrets
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

# The "logic bug" record (fixture item 15). PUT says success but never changes it.
RECORD = {"id": 42, "name": "Nguyen Van A", "tin": "S1234567A", "country": "MY"}


def big_payload():
    """A JSON body of roughly 30 KB, to test the 20 KB truncation (item 13)."""
    rows = [{"row": i, "investor": f"Investor {i:04d}", "note": "x" * 40} for i in range(400)]
    return {"success": True, "rows": rows}


class Handler(SimpleHTTPRequestHandler):
    # Serve files from the test/ folder no matter where the command was started from.
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)

    # Never let the browser cache: each reload should show the current fixture.
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    def send_json(self, status, obj, delay=0.0):
        if delay:
            time.sleep(delay)
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # A correlation id, like real servers often send (FR-22).
        self.send_header("X-Request-Id", secrets.token_hex(8))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n).decode("utf-8", "replace") if n else ""

    # ---- routes ------------------------------------------------------------------------
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/fake-route"):  # /fake-route so a reload after pushState still works
            self.path = "/fixture.html"
            return super().do_GET()
        if path == "/api/item":
            return self.send_json(200, {"id": 1, "name": "Fixture item", "status": "active"})
        if path == "/api/xhr-json":
            return self.send_json(200, {"id": 7, "kind": "xhr-json", "values": [1, 2, 3]})
        if path == "/api/soft-fail":
            return self.send_json(200, {"success": False, "error": "Validation failed"})
        if path == "/api/big":
            return self.send_json(200, big_payload())
        if path == "/api/slow":
            return self.send_json(200, {"slow": True, "waitedSeconds": 2}, delay=2.0)
        if path == "/api/record":
            return self.send_json(200, RECORD)
        if path == "/api/frame-fail":
            return self.send_json(500, {"error": "Frame endpoint failed"})
        return super().do_GET()

    def do_PUT(self):
        path = self.path.split("?", 1)[0]
        self.read_body()
        if path == "/api/item":
            return self.send_json(500, {"success": False, "error": "Internal Server Error", "detail": "Simulated failure"})
        if path == "/api/record":
            # The bug: report success, but do NOT change RECORD.
            return self.send_json(200, {"success": True})
        return self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        self.read_body()
        if path == "/api/xhr-bad":
            return self.send_json(400, {"errors": [{"field": "amount", "message": "Amount must be positive"}]})
        if path == "/api/frame-fail":
            return self.send_json(500, {"error": "Frame endpoint failed"})
        return self.send_json(404, {"error": "Not found"})


if __name__ == "__main__":
    # 127.0.0.1 = only this computer can reach the fixture (not the office network).
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Test fixture running at http://localhost:{PORT}/   (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
