"""Read-only local creative library for the Ads Tracking and Relaunch tabs (127.0.0.1:43127).

A Python port of the old Node helper (tools/creative-library/helper.mjs), run inside the
disclaimer worker so one install covers both. Same API and file ids, so the site is unchanged:
  GET /manifest      the library's media files (ids, names, folders, state, date)
  GET /preview/<id>  one file, with Range support for video
It rescans once a minute, skips symbolic links and hidden files, never writes, and answers only
the Scale Cases site origins on loopback.
"""
import hashlib, json, os, re, sys, threading, time
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
         ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime"}
STATES = set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK "
             "OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split())


def scan_library(root):
    base = os.path.realpath(root)
    m = re.search(r"20\d{2}", os.path.basename(base))
    if not m:
        raise ValueError("The library folder must include its year, such as 2026 B2C.")
    year = int(m.group(0))
    files, paths = [], {}

    def visit(d):
        try:
            entries = sorted(os.scandir(d), key=lambda e: e.name)
        except OSError:
            return
        for e in entries:
            if e.is_symlink() or e.name.startswith("."):
                continue
            if e.is_dir(follow_symlinks=False):
                visit(e.path); continue
            ext = os.path.splitext(e.name)[1].lower()
            if not e.is_file(follow_symlinks=False) or ext not in TYPES:
                continue
            rel = os.path.relpath(e.path, base).replace(os.sep, "/")
            parts = rel.split("/")
            folders = parts[:-1]
            state = next((p.upper() for p in folders if p.upper() in STATES), None)
            code = next((mm.group(1) for p in folders for mm in [re.match(r"^(\d{4})(?:\D|$)", p)] if mm), None) \
                or (lambda mm: mm.group(1) if mm else None)(re.match(r"^(\d{4})(?:\D|$)", e.name))
            day = None
            if code:
                try:
                    day = date(year, int(code[:2]), int(code[2:])).isoformat()
                except ValueError:
                    pass
            fid = hashlib.sha256(rel.encode("utf-8")).hexdigest()[:24]
            files.append({"id": fid, "name": e.name[:-len(ext)], "relativePath": rel, "folder": "/".join(folders), "date": day,
                          "state": state, "kind": "image" if TYPES[ext].startswith("image/") else "video"})
            paths[fid] = (e.path, TYPES[ext])

    visit(base)
    files.sort(key=lambda f: f["relativePath"].lower())
    return base, files, paths


class Library:
    def __init__(self, get_root, origins, port=43127, interval=60):
        self.get_root, self.origins, self.port, self.interval = get_root, origins, port, interval
        self.root = None; self.base = None; self.files = []; self.paths = {}; self.error = None; self.scanned_at = None
        self._lock = threading.Lock()

    def scan(self):
        root = self.get_root()
        try:
            if not root or not os.path.isdir(root):
                raise ValueError("Creative library folder not found on this computer (looked for a \"20xx B2C\" folder in Google Drive).")
            base, files, paths = scan_library(root)
            with self._lock:
                self.root, self.base, self.files, self.paths, self.error = root, base, files, paths, None
        except Exception as e:      # keep serving the last good scan
            with self._lock:
                self.root, self.error = root, str(e)
        self.scanned_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def _loop(self):
        while True:
            time.sleep(self.interval)
            self.scan()

    def start(self):
        lib = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _guard(self):
                origin = self.headers.get("Origin")
                if origin not in lib.origins or self.headers.get("Host") != f"127.0.0.1:{lib.port}":
                    self.send_response(403); self.end_headers(); self.wfile.write(b"Not allowed"); return False
                return True

            def _common(self):
                self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin"))
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Range")
                self.send_header("Access-Control-Allow-Private-Network", "true")
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")

            def do_OPTIONS(self):
                if not self._guard(): return
                self.send_response(204); self._common(); self.end_headers()

            def _not_allowed(self):
                if not self._guard(): return
                self.send_response(405); self._common(); self.end_headers()

            do_POST = do_PUT = do_DELETE = do_PATCH = _not_allowed

            def do_GET(self):
                if not self._guard(): return
                if self.path == "/manifest":
                    with lib._lock:
                        body = json.dumps({"version": 1, "library": os.path.basename(lib.root or ""), "scannedAt": lib.scanned_at,
                                           "error": lib.error, "files": lib.files}).encode()
                    self.send_response(200); self._common(); self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body); return
                m = re.match(r"^/preview/([a-f0-9]{24})$", self.path or "")
                with lib._lock:
                    entry = lib.paths.get(m.group(1)) if m else None; base = lib.base
                if not entry:
                    self.send_response(404); self._common(); self.end_headers(); return
                full, ctype = entry
                try:
                    # Recheck the resolved target: a file or folder may have become a link since scanning
                    real = os.path.realpath(full)
                    if os.path.commonpath([real, base]) != base or not os.path.isfile(real):
                        raise OSError("outside library")
                    size = os.path.getsize(real); start, end = 0, size - 1
                    rng = self.headers.get("Range")
                    status = 200
                    if rng:
                        mm = re.match(r"^bytes=(\d+)-(\d*)$", rng)
                        if not mm:
                            self.send_response(416); self._common(); self.end_headers(); return
                        start = int(mm.group(1)); end = min(int(mm.group(2)), end) if mm.group(2) else end
                        if start > end or start >= size:
                            self.send_response(416); self._common(); self.end_headers(); return
                        status = 206
                    self.send_response(status); self._common()
                    if status == 206:
                        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                    self.send_header("Accept-Ranges", "bytes"); self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(max(0, end - start + 1))); self.end_headers()
                    with open(real, "rb") as f:
                        f.seek(start); left = end - start + 1
                        while left > 0:
                            chunk = f.read(min(1 << 20, left))
                            if not chunk: break
                            self.wfile.write(chunk); left -= len(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except OSError:
                    self.send_response(404); self._common(); self.end_headers()

        try:
            server = ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        except OSError as e:
            print(f"creative library: port {self.port} is busy ({e}); is the old Node helper still running?", file=sys.stderr)
            return None
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        # First scan in the background: a big library on Drive takes a while and must not hold up the worker
        threading.Thread(target=lambda: (self.scan(), self._loop()), daemon=True).start()
        return server
