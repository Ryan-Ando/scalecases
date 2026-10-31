"""Scale Cases local disclaimer worker.

Runs on this machine only (127.0.0.1:43128) and does the heavy lifting for the Disclaimers tab:
disclaimer library, folder browsing, date sorting, rendering jobs (image + video), review
previews, approve/reject into the chosen destination, and output history.

Start:   python worker.py   (installed for everyday use by the site's setup downloads, client/public/setup/;
         this process also serves the local creative library on 127.0.0.1:43127, see library_helper.py)

Data:    everything the tab shows (library, settings, history, jobs, staged renders, previews,
         drag-and-drop inbox) lives in the SHARED Drive folder  ScaleCases/Disclaimers  (a Shared
         Drive or My Drive) so everyone who uses it sees the same thing; see "per-machine sync" below.
         The only machine-local file is local.json (this machine's library root) in
         %LOCALAPPDATA%\\ScaleCasesDisclaimers (Windows) / ~/Library/Application Support/ScaleCasesDisclaimers (macOS).
         Until Drive is available the worker falls back to that local folder and moves the data
         into the shared folder the first time it appears.
"""
import os, sys, json, uuid, time, shutil, threading, subprocess, queue, string, platform
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
import uvicorn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import disclaimer_image as dimg
import disclaimer_video as dvid
import library_helper

VERSION = 4
PORT = int(os.environ.get("SC_DISCLAIMER_PORT") or 43128)
LIBRARY_PORT = int(os.environ.get("SC_LIBRARY_PORT") or 43127)     # creative library for Ads Tracking / Relaunch; 0 = off
ORIGINS = ["https://scalecases-client.onrender.com", "http://localhost:5173", "http://127.0.0.1:5173"]
IS_WIN = sys.platform.startswith("win")
IS_MAC = sys.platform == "darwin"
MACHINE = os.environ.get("SC_DISCLAIMER_MACHINE") or platform.node() or ("pc" if IS_WIN else "mac")
SYNC_DIR = "sync"           # inside the shared data folder: sync/<store>/<machine id>.json, one writer per file
_default_local = (os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "ScaleCasesDisclaimers") if IS_WIN
                  else os.path.expanduser("~/Library/Application Support/ScaleCasesDisclaimers") if IS_MAC
                  else os.path.expanduser("~/.scalecases-disclaimers"))
LOCAL = os.environ.get("SC_DISCLAIMER_DATA") or _default_local      # machine-local: local.json + fallback data
SHARED_REL = os.path.join("ScaleCases", "Disclaimers")                # inside the library root (a Google Shared Drive or "My Drive")
os.makedirs(LOCAL, exist_ok=True)
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_EXT = {".mp4", ".mov", ".m4v"}

DEFAULT_SETTINGS = {                 # shared (synced) settings
    "tags": ["LSS CA", "CA LSS", "LSS CO", "CO LSS", "C-L"],
    "out_folder": "new disclaimer",
    "recent_parents": [],
}
DEFAULT_LOCAL = {                    # machine-local settings
    "library_root": "",      # this machine's path to the synced ad library (a Shared Drive or "My Drive"); "{root}" in paths expands to it
    "machine_id": "",        # stable id for this machine's sync files (host names can change)
    "creative_root": "",     # the creative library folder; blank = the newest "20xx B2C" folder in the library root
}


def drive_roots():
    """Google Drive for desktop folders on this machine: every Shared Drive first, then My Drive."""
    import glob
    shared, mine = [], []
    if IS_WIN:
        for c in string.ascii_uppercase:
            shared += sorted(glob.glob(f"{c}:\\Shared drives\\*")); mine.append(f"{c}:\\My Drive")
        home = os.path.expanduser("~")
        mine += [os.path.join(home, "Google Drive", "My Drive"), os.path.join(home, "My Drive")]
    else:
        for acct in sorted(glob.glob(os.path.expanduser("~/Library/CloudStorage/GoogleDrive-*"))):
            shared += sorted(glob.glob(os.path.join(acct, "Shared drives", "*"))); mine.append(os.path.join(acct, "My Drive"))
        mine += [os.path.expanduser("~/Google Drive/My Drive"), os.path.expanduser("~/Google Drive")]
    return [r for r in shared + mine if os.path.isdir(r)]


def guess_library_root():
    """The Drive folder that holds ScaleCases/Disclaimers (a Shared Drive both partners use, or
    My Drive), else one holding the ad library ("2026 B2C"), else the first Drive folder."""
    roots = drive_roots()
    for r in roots:
        if os.path.isdir(os.path.join(r, SHARED_REL)):
            return r
    for r in roots:
        try:
            if any(e.is_dir() and e.name[:2] == "20" and e.name.upper().endswith("B2C") for e in os.scandir(r)):
                return r
        except OSError:
            pass
    return roots[0] if roots else ""


def library_root():
    return state["local"].get("library_root") or ""


def resolve_path(p):
    """Expand the {root} (library root) and {data} (shared data folder) placeholders with this
    machine's paths and normalise separators."""
    p = (p or "").strip()
    if not p:
        return ""
    for key, base in (("{root}", library_root()), ("{data}", DATA)):
        if p.startswith(key):
            rest = p[len(key):].replace("\\", "/").lstrip("/")
            p = os.path.join(base, *rest.split("/")) if rest else base
            break
    return os.path.abspath(p) if p else ""


def _under(p, base):
    if not p or not base:
        return False
    p = os.path.normcase(os.path.abspath(p)); b = os.path.normcase(os.path.abspath(base)).rstrip("\\/")
    return p == b or p.startswith(b + os.sep)


def portable_path(p):
    """Store paths under the library root as {root}/... and under the shared data folder as
    {data}/... so the same record works on both machines."""
    p = (p or "").strip()
    if not p or p.startswith("{root}") or p.startswith("{data}"):
        return p
    for key, base in (("{data}", DATA), ("{root}", library_root())):
        if _under(p, base):
            rest = os.path.abspath(p)[len(os.path.abspath(base).rstrip("\\/")):].replace("\\", "/").lstrip("/")
            return f"{key}/{rest}" if rest else key
    return p


lock = threading.RLock()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


FILES = {"disclaimers": "disclaimers.json", "settings": "settings.json", "history": "history.json", "jobs": "jobs.json"}
DATA = STAGING = PREVIEWS = INBOX = None
_seen = {}          # store -> stats of every file it was last merged from
_base = {}          # store -> {record id: json} as last merged or written, to tell which records this machine changed
_own = {}           # store -> {record id: record} this machine's sync file
state = {"local": {**DEFAULT_LOCAL}, "disclaimers": [], "settings": {**DEFAULT_SETTINGS}, "history": [], "jobs": []}

# Several people (and machines) share the data folder through Drive. Every machine writes ONLY its
# own file per store, sync/<store>/<machine id>.json, holding the latest copy of each record it
# changed (stamped "_u") plus tombstones for records it deleted. Reading merges every machine's
# file and the pre-sync <store>.json (dated by its mtime): newest "_u" wins per record, and for
# jobs per item, so two people approving different items of one job at once both stick. With one
# writer per file Drive never has to resolve a conflict.
ORDER = {"jobs": ("created", True), "history": ("ts", True), "disclaimers": ("created", False)}
JOBS_KEEP = 60


def _stat(p):
    try:
        st = os.stat(p); return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def _read_json(p, default):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write_json(p, data):
    tmp = p + f".{MACHINE}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, p)


def save_local():
    _write_json(os.path.join(LOCAL, "local.json"), state["local"])


def machine_id():
    if not state["local"].get("machine_id"):
        safe = "".join(c if c.isalnum() else "-" for c in MACHINE)[:30].strip("-") or "machine"
        state["local"]["machine_id"] = f"{safe}-{uuid.uuid4().hex[:6]}"
        save_local()
    return state["local"]["machine_id"]


def _store_dir(name):
    return os.path.join(DATA, SYNC_DIR, name)


def _sources(name):
    """(path, is_legacy) of every file that feeds a store."""
    out = [(os.path.join(DATA, FILES[name]), True)]
    d = _store_dir(name)
    if os.path.isdir(d):
        out += [(os.path.join(d, f), False) for f in sorted(os.listdir(d)) if f.endswith(".json")]
    return out


def _records(name, data):
    """A store's data as {id: record}. Settings become one record per key."""
    if name == "settings":
        return {k: {"id": k, "value": v} for k, v in (data or {}).items()}
    return {r["id"]: r for r in (data or []) if isinstance(r, dict) and r.get("id")}


def _newer(a, b):
    return (a.get("_u") or "") > (b.get("_u") or "")


def _merge_items(versions):
    """One job seen in several machines' files: newest copy of the job, with each item taken
    from whichever copy changed it last."""
    best = max(versions, key=lambda r: r.get("_u") or "")
    if best.get("_deleted"):
        return best
    items = {}
    for v in versions:
        for it in v.get("items") or []:
            cur = items.get(it.get("idx"))
            if cur is None or (it.get("_u") or "") > (cur.get("_u") or ""):
                items[it.get("idx")] = it
    return {**best, "items": [items[k] for k in sorted(items, key=lambda k: (k is None, k))]}


def _merged(name):
    versions = {}
    stats = {}
    for p, legacy in _sources(name):
        stats[p] = _stat(p)
        if legacy and not os.path.exists(p):
            continue
        data = _read_json(p, {} if name == "settings" else [])
        if legacy:
            # Written before per-machine sync: date its records by the file, so an older worker
            # still writing it is not drowned out by stale copies in the sync files
            stamp = datetime.fromtimestamp(os.path.getmtime(p), timezone.utc).isoformat(timespec="seconds")
            recs = {k: {**r, "_u": r.get("_u") or stamp} for k, r in _records(name, data).items()}
            if name == "jobs":
                for r in recs.values():
                    r["items"] = [{**it, "_u": it.get("_u") or stamp} for it in r.get("items") or []]
        else:
            recs = {r["id"]: r for r in (data.get("records") or {}).values()} if isinstance(data, dict) else {}
        for rid, r in recs.items():
            versions.setdefault(rid, []).append(r)
    out = {}
    for rid, vs in versions.items():
        r = _merge_items(vs) if name == "jobs" else max(vs, key=lambda r: r.get("_u") or "")
        if not r.get("_deleted"):
            out[rid] = r
    return out, stats


def _to_state(name, recs):
    if name == "settings":
        return {**DEFAULT_SETTINGS, **{k: r["value"] for k, r in recs.items() if k in DEFAULT_SETTINGS}}
    key, desc = ORDER[name]
    rows = sorted(recs.values(), key=lambda r: r.get(key) or "", reverse=desc)
    return rows[:JOBS_KEEP] if name == "jobs" else rows


def _snapshot(name):
    return {rid: json.dumps(r, sort_keys=True) for rid, r in _records(name, state[name]).items()}


def load(name):
    recs, stats = _merged(name)
    data = _to_state(name, recs)
    if name == "settings":
        data["recent_parents"] = [portable_path(x) for x in data.get("recent_parents") or []]
    if name == "jobs":
        data = [normalize_job(j) for j in data]
    state[name] = data
    _seen[name] = stats
    # The base is what the files said, so normalising old absolute paths counts as a change to write back
    _base[name] = {rid: json.dumps(r, sort_keys=True) for rid, r in _records(name, _to_state(name, recs)).items()}
    _own[name] = (_read_json(os.path.join(_store_dir(name), machine_id() + ".json"), {}) or {}).get("records") or {}
    if _snapshot(name) != _base[name]:
        save(name)


def save(name):
    """Write the records this machine changed since the last merge into its own sync file."""
    stamp = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    cur = _records(name, state[name])
    base = _base.get(name, {})
    own = _own.setdefault(name, {})
    changed = False
    for rid, r in cur.items():
        if base.get(rid) == json.dumps(r, sort_keys=True):
            continue
        if name == "jobs":
            old = {it.get("idx"): json.dumps(it, sort_keys=True) for it in json.loads(base[rid]).get("items", [])} if rid in base else {}
            for it in r.get("items") or []:
                if old.get(it.get("idx")) != json.dumps(it, sort_keys=True):
                    it["_u"] = stamp
        r["_u"] = stamp
        own[rid] = json.loads(json.dumps(r)); changed = True
    for rid in base:
        if rid not in cur:
            own[rid] = {"id": rid, "_deleted": True, "_u": stamp}; changed = True
    if changed:
        d = _store_dir(name); os.makedirs(d, exist_ok=True)
        p = os.path.join(d, machine_id() + ".json")
        _write_json(p, {"machine": MACHINE, "records": own})
        _seen.setdefault(name, {})[p] = _stat(p)
    _base[name] = _snapshot(name)


def normalize_job(j):
    """Older jobs stored absolute machine paths; make them portable so the other machine can show,
    approve and re-render them."""
    for it in j.get("items", []):
        for k in ("src", "parent", "out_path", "staging"):
            if it.get(k): it[k] = portable_path(it[k])
        it.setdefault("machine", MACHINE)
    return j


def shared_dir():
    """The shared data folder inside the library root, if the library root exists on this machine."""
    root = library_root()
    return os.path.join(root, SHARED_REL) if root and os.path.isdir(root) else ""


def choose_data_dir():
    """Shared folder when Drive is available, else the local folder. Switching to the shared
    folder for the first time moves this machine's existing data into it."""
    global DATA, STAGING, PREVIEWS, INBOX
    want = shared_dir() or LOCAL
    if want == DATA:
        return False
    if want != LOCAL:
        try:
            os.makedirs(want, exist_ok=True)
        except OSError:
            want = LOCAL
            if want == DATA: return False
    old = DATA
    DATA = want; STAGING = os.path.join(DATA, "staging"); PREVIEWS = os.path.join(DATA, "previews"); INBOX = os.path.join(DATA, "inbox")
    for d in (STAGING, PREVIEWS, INBOX):
        os.makedirs(d, exist_ok=True)
    if DATA != LOCAL and _read_json(os.path.join(LOCAL, FILES["disclaimers"]), []) and not _read_json(os.path.join(DATA, FILES["disclaimers"]), []):
        migrate_local_into_shared()      # this machine has a library and the shared folder has none yet
    for n in FILES:
        load(n)
    if old is not None:
        print(f"data folder is now {DATA}", file=sys.stderr)
    return True


def migrate_local_into_shared():
    """First switch to Drive on a machine that already has a local library: copy it across.
    Paths in the copied records are made portable by normalize_job / portable_path on load."""
    for n, fn in FILES.items():
        src = os.path.join(LOCAL, fn); dst = os.path.join(DATA, fn)
        if os.path.exists(src) and (n == "disclaimers" or not os.path.exists(dst)):
            shutil.copy2(src, dst)       # never clobber a file the other machine already wrote
    for sub in ("staging", "previews", "inbox"):
        src = os.path.join(LOCAL, sub)
        if os.path.isdir(src):
            shutil.copytree(src, os.path.join(DATA, sub), dirs_exist_ok=True)
    # staging/inbox paths in copied jobs pointed at the local folder; rewrite them to the shared one
    jobs = _read_json(os.path.join(DATA, FILES["jobs"]), [])
    for j in jobs:
        for it in j.get("items", []):
            for k in ("src", "staging"):
                v = it.get(k) or ""
                if v and _under(v, LOCAL):
                    it[k] = "{data}/" + os.path.abspath(v)[len(os.path.abspath(LOCAL).rstrip("\\/")):].replace("\\", "/").lstrip("/")
    _write_json(os.path.join(DATA, FILES["jobs"]), jobs)
    print(f"moved local disclaimer data into the shared folder {DATA}", file=sys.stderr)


_root_checked = [0.0]


def follow_moved_root():
    """If the shared folder is gone from this machine's library root (e.g. moved from My Drive
    into a Shared Drive) but exists in another Drive folder, switch the library root there.
    Checked at most every 30 s."""
    if time.time() - _root_checked[0] < 30:
        return False
    _root_checked[0] = time.time()
    root = library_root()
    if root and os.path.isdir(os.path.join(root, SHARED_REL)):
        return False
    g = guess_library_root()
    if g and g != root and os.path.isdir(os.path.join(g, SHARED_REL)):
        print(f"library root moved: {root} -> {g}", file=sys.stderr)
        state["local"]["library_root"] = g; save_local()
        if "creative_library" in globals():
            threading.Thread(target=creative_library.scan, daemon=True).start()
        return True
    return False


def refresh():
    """Pick up changes other machines synced through Drive: re-merge a store whenever any of its
    files changed since the last merge. Cheap (a few stats), called per request."""
    with lock:
        follow_moved_root()
        if choose_data_dir():
            return
        for n in FILES:
            stats = _seen.get(n) or {}
            paths = [p for p, _ in _sources(n)]
            if set(paths) != set(stats) or any(_stat(p) != stats.get(p) for p in paths):
                load(n)


state["local"] = {**DEFAULT_LOCAL, **_read_json(os.path.join(LOCAL, "local.json"), {})}
# settings.json used to hold library_root; carry it over once
_old_settings = _read_json(os.path.join(LOCAL, "settings.json"), {})
if not state["local"].get("library_root") and _old_settings.get("library_root"):
    state["local"]["library_root"] = _old_settings["library_root"]
if not state["local"].get("library_root") or not os.path.isdir(state["local"]["library_root"]):
    g = guess_library_root()
    if g: state["local"]["library_root"] = g
save_local()
choose_data_dir()
# anything THIS machine was rendering when the worker last stopped is stale; the other machine's items are left alone
_stale = False
for j in state["jobs"]:
    for it in j["items"]:
        if it["status"] in ("queued", "running") and it.get("machine", MACHINE) == MACHINE:
            it["status"] = "error"; it["error"] = "worker restarted before this item finished"; _stale = True
if _stale:
    save("jobs")


def persist(*names):
    with lock:
        for n in names:
            save(n)


app = FastAPI(title="Scale Cases disclaimer worker")
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def private_network(request: Request, call_next):
    # Chrome's Private Network Access preflight needs this header on loopback services
    if request.method != "OPTIONS":
        refresh()          # pick up anything the other machine synced through Drive
    resp = await call_next(request)
    resp.headers["Access-Control-Allow-Private-Network"] = "true"
    resp.headers["Cache-Control"] = "no-store"
    return resp


# ───────────────────────────── helpers ─────────────────────────────

def ffmpeg_ok():
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def kind_of(path):
    ext = os.path.splitext(path)[1].lower()
    return "image" if ext in IMAGE_EXT else "video" if ext in VIDEO_EXT else None


def date_code(name):
    return name[:4] if len(name) >= 4 and name[:4].isdigit() else None


def output_name(src_name, disc_name, tags):
    """Keep the name when a state tag sits in its tail (last two dash-separated segments, so
    '…-CA LSS-img' and '…-1-C-L' both count); otherwise append ' - <disclaimer name>'."""
    stem, ext = os.path.splitext(src_name)
    segs = [s.strip() for s in stem.split("-")]
    tail = "-".join(segs[-2:]).upper()
    for t in tags:
        t = (t or "").strip().upper()
        if not t:
            continue
        i = tail.find(t)
        while i != -1:
            before = tail[i - 1] if i > 0 else " "
            after = tail[i + len(t)] if i + len(t) < len(tail) else " "
            if not before.isalnum() and not after.isalnum():
                return src_name
            i = tail.find(t, i + 1)
    return f"{stem} - {disc_name}{ext}"


def find_disclaimer(did):
    for d in state["disclaimers"]:
        if d["id"] == did:
            return d
    raise HTTPException(404, "disclaimer not found")


def find_job(jid):
    for j in state["jobs"]:
        if j["id"] == jid:
            return j
    raise HTTPException(404, "job not found")


def public_job(j):
    return j


# ───────────────────────────── previews ─────────────────────────────

def ffmpeg_frame_crop(src, n, crop, scale_w, out_png):
    x, y, w, h = crop
    vf = f"select='eq(n,{n})',crop={w}:{h}:{x}:{y},scale={scale_w}:-1"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-vf", vf, "-fps_mode", "passthrough",
                    "-frames:v", "1", out_png], check=True, capture_output=True)


def make_previews(item):
    """Before/after crops around the disclaimer band (and the first clean frame for video)."""
    from PIL import Image
    res = item["result"]; src = item["src"]; out = item["staging"]
    pdir = os.path.join(PREVIEWS, item["job_id"], str(item["idx"]))
    shutil.rmtree(pdir, ignore_errors=True); os.makedirs(pdir, exist_ok=True)
    previews = []
    W, H = res["W"], res["H"]
    if res["kind"] == "image":
        y0, y1 = res["band"]
        cy0 = max(0, y0 - int(H * 0.06)); cy1 = min(H, y1 + int(H * 0.02) + 1)
        for tag, path in (("before", src), ("after", out)):
            im = Image.open(path).convert("RGB")
            im.crop((0, cy0, W, cy1)).save(os.path.join(pdir, f"{tag}.png")); previews.append(tag)
        im = Image.open(out).convert("RGB"); im.thumbnail((420, 420)); im.save(os.path.join(pdir, "full.png")); previews.append("full")
    else:
        for i, rg in enumerate(res["ranges"]):
            y0, y1 = rg["band"]
            cy0 = max(0, y0 - int(H * 0.05)); cy1 = min(H, y1 + int(H * 0.03) + 1)
            crop = (0, cy0, W, cy1 - cy0)
            mid = (rg["a"] + rg["b"]) // 2
            frames = [("before", src, mid), ("after", out, mid), ("last", out, rg["b"])]
            if rg["b"] + 1 < res["frames"]:
                frames.append(("next", out, rg["b"] + 1))
            for tag, path, n in frames:
                name = f"r{i}_{tag}"
                try:
                    ffmpeg_frame_crop(path, n, crop, 720, os.path.join(pdir, name + ".png")); previews.append(name)
                except subprocess.CalledProcessError:
                    pass
        if res["ranges"]:
            rg = res["ranges"][0]; mid = (rg["a"] + rg["b"]) // 2
            try:
                ffmpeg_frame_crop(out, mid, (0, 0, W, H), 420, os.path.join(pdir, "full.png")); previews.append("full")
            except subprocess.CalledProcessError:
                pass
    item["previews"] = previews


# ───────────────────────────── job runner ─────────────────────────────

work_q = queue.Queue()


def current_item(jid, idx):
    """Re-find the item in the latest state (a Drive sync may have replaced the dicts)."""
    refresh()
    job = next((j for j in state["jobs"] if j["id"] == jid), None)
    return (job, job["items"][idx]) if job and idx < len(job["items"]) else (None, None)


def update_item(jid, idx, **fields):
    with lock:
        job, item = current_item(jid, idx)
        if item is None:
            return None
        item.update(fields); persist("jobs")
        return item


def run_item(jid, idx, item):
    update_item(jid, idx, status="running", started=now(), error=None, machine=MACHINE)
    fields = {}
    try:
        if not ffmpeg_ok() and item["kind"] == "video":
            raise RuntimeError("ffmpeg/ffprobe not found on PATH")
        src = resolve_path(item["src"])
        if not os.path.isfile(src):
            raise RuntimeError("source file is not on this machine yet (Drive still syncing?)")
        ext = os.path.splitext(item["out_name"])[1]
        staging = os.path.join(STAGING, f"{jid}_{idx}{ext}")
        fn = dimg.run_image if item["kind"] == "image" else dvid.run_video
        res = fn(src, item["text"], staging, item.get("overrides") or {})
        work = {**item, "src": src, "staging": staging, "result": res}
        make_previews(work)
        fields = {"staging": portable_path(staging), "result": res, "flags": list(res.get("flags", [])),
                  "log": list(res.get("log", [])), "previews": work["previews"], "status": "review"}
    except Exception as e:
        fields = {"status": "error", "error": str(e), "log": (item.get("log") or []) + [f"ERROR {e}"]}
    update_item(jid, idx, finished=now(), **fields)


def runner():
    while True:
        jid, idx = work_q.get()
        try:
            with lock:
                job, item = current_item(jid, idx)
                item = dict(item) if item else None
            if item and item["status"] == "queued":
                run_item(jid, idx, item)
        except Exception as e:
            print("runner error", e, file=sys.stderr)
        finally:
            work_q.task_done()


threading.Thread(target=runner, daemon=True).start()


# ───────────────────────────── routes: status, library, settings ─────────────────────────────

def creative_root():
    """The ad library the Ads Tracking / Relaunch tabs list: the chosen folder, else the newest
    "20xx B2C" folder in the library root."""
    chosen = resolve_path(state["local"].get("creative_root"))
    if chosen:
        return chosen
    # The library root first, then every other Drive folder (the folders may be mid-move)
    for root in [library_root()] + drive_roots():
        try:
            found = sorted((e.name for e in os.scandir(root) if e.is_dir() and e.name[:2] == "20" and e.name.upper().endswith("B2C")), reverse=True)
        except OSError:
            continue
        if found:
            return os.path.join(root, found[0])
    return ""


creative_library = library_helper.Library(creative_root, ORIGINS, port=LIBRARY_PORT)


@app.get("/health")
def health():
    root = library_root()
    return {"version": VERSION, "ok": True, "ffmpeg": ffmpeg_ok(), "data": DATA, "shared": DATA != LOCAL, "local": LOCAL,
            "machine": MACHINE, "platform": sys.platform, "sep": os.sep,
            "library_root": root, "library_root_ok": bool(root) and os.path.isdir(root), "library_root_guess": guess_library_root(),
            "creative_root": creative_library.root, "creative_files": len(creative_library.files), "creative_error": creative_library.error,
            "queued": sum(1 for j in state["jobs"] for i in j["items"] if i["status"] in ("queued", "running"))}


@app.get("/state")
def get_state():
    discs = [{**d, "parent_resolved": resolve_path(d.get("parent"))} for d in state["disclaimers"]]
    return {"disclaimers": discs, "settings": {**state["settings"], **state["local"]}, "sep": os.sep, "platform": sys.platform}


@app.get("/export")
def export_library():
    return {"version": VERSION, "exported": now(), "disclaimers": state["disclaimers"],
            "settings": {"tags": state["settings"]["tags"], "out_folder": state["settings"]["out_folder"]}}


@app.post("/import")
async def import_library(req: Request):
    """Merge an exported library: new names are added, existing names get the imported text
    (a new version if it differs) and the imported destination."""
    b = await req.json()
    added = updated = 0
    with lock:
        for d in b.get("disclaimers") or []:
            name = (d.get("name") or "").strip(); text = " ".join((d.get("text") or "").split())
            if not name or not text: continue
            cur = next((x for x in state["disclaimers"] if x["name"].lower() == name.lower()), None)
            if cur:
                if text != cur["text"]:
                    cur["version"] += 1; cur["text"] = text; cur["versions"].append({"version": cur["version"], "text": text, "ts": now()})
                if d.get("parent"): cur["parent"] = d["parent"]
                cur["updated"] = now(); updated += 1
            else:
                state["disclaimers"].append({"id": uuid.uuid4().hex[:12], "name": name, "text": text, "version": 1, "parent": d.get("parent") or "",
                                             "versions": [{"version": 1, "text": text, "ts": now()}], "created": now(), "updated": now()}); added += 1
        s = b.get("settings") or {}
        if s.get("tags"): state["settings"]["tags"] = sorted(set(state["settings"]["tags"]) | set(s["tags"]))
        if s.get("out_folder"): state["settings"]["out_folder"] = s["out_folder"]
        persist("disclaimers", "settings")
    return {"added": added, "updated": updated}


@app.post("/disclaimers")
async def add_disclaimer(req: Request):
    b = await req.json()
    name = (b.get("name") or "").strip(); text = " ".join((b.get("text") or "").split())
    if not name or not text:
        raise HTTPException(400, "name and text are required")
    if any(d["name"].lower() == name.lower() for d in state["disclaimers"]):
        raise HTTPException(400, "a disclaimer with that name already exists")
    d = {"id": uuid.uuid4().hex[:12], "name": name, "text": text, "version": 1, "parent": portable_path(b.get("parent")),
         "versions": [{"version": 1, "text": text, "ts": now()}], "created": now(), "updated": now()}
    with lock:
        state["disclaimers"].append(d); persist("disclaimers")
    return d


@app.put("/disclaimers/{did}")
async def edit_disclaimer(did: str, req: Request):
    b = await req.json(); d = find_disclaimer(did)
    with lock:
        if "name" in b and b["name"].strip():
            d["name"] = b["name"].strip()
        if "parent" in b:
            d["parent"] = portable_path(b["parent"])
        if "text" in b:
            text = " ".join((b["text"] or "").split())
            if text and text != d["text"]:
                d["version"] += 1; d["text"] = text
                d["versions"].append({"version": d["version"], "text": text, "ts": now()})
        d["updated"] = now(); persist("disclaimers")
    return d


@app.delete("/disclaimers/{did}")
def delete_disclaimer(did: str):
    d = find_disclaimer(did)
    with lock:
        state["disclaimers"].remove(d); persist("disclaimers")
    return {"ok": True}


@app.put("/settings")
async def put_settings(req: Request):
    b = await req.json()
    with lock:
        for k in ("tags", "out_folder", "recent_parents"):
            if k in b: state["settings"][k] = b[k]
        persist("settings")
        if "library_root" in b:
            state["local"]["library_root"] = (b["library_root"] or "").strip() or guess_library_root()
            save_local(); choose_data_dir()
    return {**state["settings"], **state["local"]}


def remember_parent(parent):
    parent = portable_path(parent)
    rp = [p for p in state["settings"]["recent_parents"] if p.lower() != parent.lower()]
    state["settings"]["recent_parents"] = [parent] + rp[:9]
    persist("settings")


@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    """Receive a file dropped onto the tab. Browsers never reveal the original path, so the
    copy in the inbox becomes the source for rendering, history and regeneration."""
    name = os.path.basename(file.filename or "")
    if not name or not kind_of(name):
        raise HTTPException(400, f"unsupported file type: {name or 'unnamed'}")
    folder = os.path.join(INBOX, uuid.uuid4().hex[:8]); os.makedirs(folder)
    dest = os.path.join(folder, name)
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f, 1 << 20)
    return {"path": portable_path(dest), "name": name, "kind": kind_of(name), "size": os.path.getsize(dest)}


# ───────────────────────────── routes: filesystem ─────────────────────────────

@app.get("/fs")
def fs(path: str = ""):
    if not path:
        if IS_WIN:
            roots = [f"{c}:\\" for c in string.ascii_uppercase if os.path.exists(f"{c}:\\")]
        else:
            roots = [os.path.expanduser("~")] + sorted(os.path.join("/Volumes", v) for v in (os.listdir("/Volumes") if os.path.isdir("/Volumes") else [])) + ["/"]
        lr = library_root()
        if lr and os.path.isdir(lr): roots.insert(0, lr)
        return {"path": "", "parent": None, "dirs": roots, "files": [], "sep": os.sep}
    path = resolve_path(path)
    if not os.path.isdir(path):
        raise HTTPException(404, "folder not found")
    dirs, files = [], []
    try:
        for e in sorted(os.scandir(path), key=lambda e: e.name.lower()):
            if e.name.startswith(".") or e.name.startswith("$"): continue
            try:
                if e.is_dir(): dirs.append(e.name)
                elif e.is_file() and kind_of(e.name): files.append({"name": e.name, "kind": kind_of(e.name), "size": e.stat().st_size})
            except OSError:
                pass
    except PermissionError:
        raise HTTPException(403, "no access to that folder")
    parent = os.path.dirname(path.rstrip("\\/"))
    if parent == path or (IS_WIN and len(path) <= 3) or path == "/": parent = ""
    return {"path": path, "parent": parent, "dirs": dirs, "files": files, "sep": os.sep}


@app.get("/diff")
def diff(parent: str):
    parent = resolve_path(parent)
    if not os.path.isdir(parent):
        raise HTTPException(404, "folder not found")
    out_folder = state["settings"]["out_folder"]
    out_root = os.path.join(parent, out_folder)
    items = []
    for sub in sorted(os.listdir(parent)):
        sp = os.path.join(parent, sub)
        if not os.path.isdir(sp) or sub.lower() == out_folder.lower(): continue
        for f in sorted(os.listdir(sp)):
            fp = os.path.join(sp, f)
            if not os.path.isfile(fp) or not kind_of(f): continue
            stem = os.path.splitext(f)[0].lower()
            od = os.path.join(out_root, sub)
            done = []
            if os.path.isdir(od):
                for g in os.listdir(od):
                    gs = os.path.splitext(g)[0].lower()
                    if gs == stem or gs.startswith(stem + " - "):
                        done.append(os.path.join(od, g))
            items.append({"path": fp, "name": f, "folder": sub, "kind": kind_of(f), "done": bool(done), "outputs": done})
    loose = [f for f in os.listdir(parent) if os.path.isfile(os.path.join(parent, f)) and kind_of(f)]
    return {"parent": parent, "out_root": out_root, "items": items, "loose": loose,
            "done": sum(1 for i in items if i["done"]), "total": len(items)}


@app.post("/sort")
async def sort_by_date(req: Request):
    b = await req.json()
    parent = resolve_path(b.get("parent") or ""); apply = bool(b.get("apply"))
    if not os.path.isdir(parent):
        raise HTTPException(404, "folder not found")
    out_folder = state["settings"]["out_folder"].lower()
    plan = []
    for root, dirs, files in os.walk(parent):
        dirs[:] = [d for d in dirs if d.lower() != out_folder]
        for f in files:
            if not kind_of(f): continue
            src = os.path.join(root, f); code = date_code(f)
            if not code:
                plan.append({"from": src, "to": None, "status": "skip (no date prefix)"}); continue
            dest_dir = os.path.join(parent, code)
            if os.path.abspath(root) == os.path.abspath(dest_dir): continue
            dest = os.path.join(dest_dir, f)
            if os.path.exists(dest):
                plan.append({"from": src, "to": dest, "status": "collision (not moved)"})
            else:
                plan.append({"from": src, "to": dest, "status": "move"})
    removed = []
    if apply:
        for p in plan:
            if p["status"] != "move": continue
            os.makedirs(os.path.dirname(p["to"]), exist_ok=True)
            shutil.move(p["from"], p["to"]); p["status"] = "moved"
        for root, dirs, files in os.walk(parent, topdown=False):
            if os.path.abspath(root) == os.path.abspath(parent): continue
            if out_folder in root.lower(): continue
            if not os.listdir(root):
                os.rmdir(root); removed.append(root)
    return {"parent": parent, "plan": plan, "removed": removed,
            "moves": sum(1 for p in plan if p["status"] in ("move", "moved")),
            "collisions": sum(1 for p in plan if p["status"].startswith("collision"))}


# ───────────────────────────── routes: jobs ─────────────────────────────

def build_item(job_id, idx, src, parent, disc, overrides, out_name=None):
    name = os.path.basename(src)
    tags = state["settings"]["tags"]
    out_name = out_name or output_name(name, disc["name"], tags)
    code = date_code(name) or "unsorted"
    out_path = os.path.join(parent, state["settings"]["out_folder"], code, out_name)
    return {"job_id": job_id, "idx": idx, "src": portable_path(src), "name": name, "kind": kind_of(src), "parent": portable_path(parent),
            "disclaimer_id": disc["id"], "disclaimer_name": disc["name"], "version": disc["version"],
            "text": disc["text"], "out_name": out_name, "out_path": portable_path(out_path), "staging": None,
            "status": "queued", "result": None, "log": [], "previews": [], "flags": [],
            "overrides": overrides or {}, "error": None, "created": now(), "machine": MACHINE}


@app.post("/jobs")
async def create_job(req: Request):
    b = await req.json()
    files = [resolve_path(f) for f in b.get("files") or []]
    targets = [{**t, "parent": resolve_path(t.get("parent"))} for t in (b.get("targets") or [])]
    overrides = b.get("overrides") or {}
    if not files or not targets:
        raise HTTPException(400, "files and targets are required")
    for f in files:
        if not os.path.isfile(f): raise HTTPException(400, f"not a file: {f}")
        if not kind_of(f): raise HTTPException(400, f"unsupported file type: {f}")
    for t in targets:
        if not os.path.isdir(t.get("parent") or ""): raise HTTPException(400, f"destination folder not found: {t.get('parent')}")
        find_disclaimer(t.get("disclaimer_id"))
    jid = uuid.uuid4().hex[:10]
    items = []
    for t in targets:
        disc = find_disclaimer(t["disclaimer_id"])
        for f in files:
            items.append(build_item(jid, len(items), f, t["parent"], disc, overrides))
        remember_parent(t["parent"])
    job = {"id": jid, "created": now(), "items": items}
    with lock:
        state["jobs"].insert(0, job); state["jobs"] = state["jobs"][:60]; persist("jobs")
    for it in items:
        work_q.put((jid, it["idx"]))
    return job


@app.get("/jobs")
def list_jobs():
    return state["jobs"]


@app.get("/jobs/{jid}")
def get_job(jid: str):
    return find_job(jid)


@app.delete("/jobs/{jid}")
def delete_job(jid: str):
    job = find_job(jid)
    with lock:
        for it in job["items"]:
            stg = resolve_path(it.get("staging"))
            if stg and os.path.exists(stg):
                try: os.remove(stg)
                except OSError: pass
        shutil.rmtree(os.path.join(PREVIEWS, jid), ignore_errors=True)
        state["jobs"].remove(job); persist("jobs")
    return {"ok": True}


@app.post("/jobs/{jid}/items/{idx}/approve")
def approve(jid: str, idx: int):
    job = find_job(jid); item = job["items"][idx]
    if item["status"] != "review":
        raise HTTPException(400, f"item is {item['status']}, not awaiting review")
    staging = resolve_path(item.get("staging")); out_path = resolve_path(item["out_path"]); src = resolve_path(item["src"])
    if not staging or not os.path.exists(staging):
        raise HTTPException(400, "staged output is missing on this machine (Drive still syncing?); wait or re-render it")
    if os.path.abspath(out_path) == os.path.abspath(src):
        raise HTTPException(400, "output would overwrite the source")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    shutil.move(staging, out_path)
    item["staging"] = None; item["status"] = "approved"; item["approved"] = now()
    rec = {"id": uuid.uuid4().hex[:10], "job_id": jid, "idx": idx, "out_path": portable_path(out_path), "src": portable_path(src),
           "name": item["out_name"], "parent": portable_path(item["parent"]), "disclaimer_id": item["disclaimer_id"],
           "disclaimer_name": item["disclaimer_name"], "version": item["version"], "kind": item["kind"],
           "method": (item["result"] or {}).get("method"), "flags": item["flags"], "overrides": item["overrides"], "ts": now(), "machine": MACHINE}
    with lock:
        state["history"] = [h for h in state["history"] if resolve_path(h["out_path"]).lower() != out_path.lower()]
        state["history"].insert(0, rec); persist("history", "jobs")
    return item


@app.post("/jobs/{jid}/items/{idx}/reject")
def reject(jid: str, idx: int):
    job = find_job(jid); item = job["items"][idx]
    stg = resolve_path(item.get("staging"))
    if stg and os.path.exists(stg):
        try: os.remove(stg)
        except OSError: pass
    item["staging"] = None; item["status"] = "rejected"
    persist("jobs")
    return item


@app.post("/jobs/{jid}/items/{idx}/rerender")
async def rerender(jid: str, idx: int, req: Request):
    b = await req.json(); job = find_job(jid); item = job["items"][idx]
    if item["status"] in ("queued", "running"):
        raise HTTPException(400, "item is still running")
    stg = resolve_path(item.get("staging"))
    if stg and os.path.exists(stg):
        try: os.remove(stg)
        except OSError: pass
    item["overrides"] = b.get("overrides") or {}
    disc = next((d for d in state["disclaimers"] if d["id"] == item["disclaimer_id"]), None)
    if disc:
        item["text"] = disc["text"]; item["version"] = disc["version"]
    item["status"] = "queued"; item["result"] = None; item["previews"] = []; item["flags"] = []; item["log"] = []; item["error"] = None
    item["machine"] = MACHINE
    persist("jobs")
    work_q.put((jid, idx))
    return item


@app.get("/preview/{jid}/{idx}/{name}")
def preview(jid: str, idx: int, name: str):
    p = os.path.join(PREVIEWS, jid, str(idx), os.path.basename(name) + ".png")
    if not os.path.exists(p):
        raise HTTPException(404, "no preview")
    return FileResponse(p, media_type="image/png")


# ───────────────────────────── routes: history ─────────────────────────────

@app.get("/history")
def history(disclaimer_id: str = ""):
    cur = {d["id"]: d for d in state["disclaimers"]}
    out = []
    for h in state["history"]:
        if disclaimer_id and h["disclaimer_id"] != disclaimer_id: continue
        d = cur.get(h["disclaimer_id"])
        out.append({**h, "current_version": d["version"] if d else None,
                    "stale": bool(d and h["version"] < d["version"]), "exists": os.path.exists(resolve_path(h["out_path"])),
                    "src_exists": os.path.exists(resolve_path(h["src"]))})
    return out


@app.post("/history/regenerate")
async def regenerate(req: Request):
    b = await req.json(); ids = set(b.get("ids") or [])
    recs = [h for h in state["history"] if h["id"] in ids]
    if not recs:
        raise HTTPException(400, "nothing selected")
    jid = uuid.uuid4().hex[:10]; items = []
    for h in recs:
        disc = next((d for d in state["disclaimers"] if d["id"] == h["disclaimer_id"]), None)
        src = resolve_path(h["src"]); parent = resolve_path(h["parent"])
        if not disc or not os.path.isfile(src) or not os.path.isdir(parent): continue
        items.append(build_item(jid, len(items), src, parent, disc, h.get("overrides") or {}, out_name=h["name"]))
    if not items:
        raise HTTPException(400, "none of the selected outputs can be regenerated (source or disclaimer missing)")
    job = {"id": jid, "created": now(), "items": items, "regenerate": True}
    with lock:
        state["jobs"].insert(0, job); persist("jobs")
    for it in items:
        work_q.put((jid, it["idx"]))
    return job


@app.delete("/history/{hid}")
def delete_history(hid: str):
    with lock:
        state["history"] = [h for h in state["history"] if h["id"] != hid]; persist("history")
    return {"ok": True}


if __name__ == "__main__":
    if LIBRARY_PORT:
        creative_library.start()
    print(f"Scale Cases disclaimer worker on http://127.0.0.1:{PORT}  (data: {DATA}{'' if DATA != LOCAL else ' — local only, Drive folder not found'})")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
