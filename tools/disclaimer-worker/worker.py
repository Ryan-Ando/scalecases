"""Scale Cases local disclaimer worker.

Runs on this machine only (127.0.0.1:43128) and does the heavy lifting for the Disclaimers tab:
disclaimer library, folder browsing, date sorting, rendering jobs (image + video), review
previews, approve/reject into the chosen destination, and output history.

Start:   python worker.py            (Windows: install.ps1 startup shortcut; macOS: install.sh launchd agent)

Data:    everything the tab shows (library, settings, history, jobs, staged renders, previews,
         drag-and-drop inbox) lives in the SHARED folder  <My Drive>/ScaleCases/Disclaimers
         so it syncs through Google Drive and the PC and the Mac see the same thing.
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

VERSION = 3
PORT = int(os.environ.get("SC_DISCLAIMER_PORT") or 43128)
ORIGINS = ["https://scalecases-client.onrender.com", "http://localhost:5173", "http://127.0.0.1:5173"]
IS_WIN = sys.platform.startswith("win")
IS_MAC = sys.platform == "darwin"
MACHINE = os.environ.get("SC_DISCLAIMER_MACHINE") or platform.node() or ("pc" if IS_WIN else "mac")
_default_local = (os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "ScaleCasesDisclaimers") if IS_WIN
                  else os.path.expanduser("~/Library/Application Support/ScaleCasesDisclaimers") if IS_MAC
                  else os.path.expanduser("~/.scalecases-disclaimers"))
LOCAL = os.environ.get("SC_DISCLAIMER_DATA") or _default_local      # machine-local: local.json + fallback data
SHARED_REL = os.path.join("ScaleCases", "Disclaimers")                # inside the library root (Google Drive "My Drive")
os.makedirs(LOCAL, exist_ok=True)
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_EXT = {".mp4", ".mov", ".m4v"}

DEFAULT_SETTINGS = {                 # shared (synced) settings
    "tags": ["LSS CA", "CA LSS", "LSS CO", "CO LSS", "C-L"],
    "out_folder": "new disclaimer",
    "recent_parents": [],
}
DEFAULT_LOCAL = {                    # machine-local settings
    "library_root": "",      # this machine's path to the synced ad library (Google Drive "My Drive"); "{root}" in paths expands to it
}


def guess_library_root():
    """Best guess for the Google Drive mirror folder on this machine."""
    cands = []
    if IS_WIN:
        cands += [f"{c}:\\My Drive" for c in string.ascii_uppercase]
        cands += [os.path.join(os.path.expanduser("~"), "Google Drive", "My Drive"), os.path.join(os.path.expanduser("~"), "My Drive")]
    else:
        import glob
        cands += sorted(glob.glob(os.path.expanduser("~/Library/CloudStorage/GoogleDrive-*/My Drive")))
        cands += [os.path.expanduser("~/Google Drive/My Drive"), os.path.expanduser("~/Google Drive")]
    for c in cands:
        if os.path.isdir(c):
            return c
    return ""


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
_seen = {}          # file name -> (mtime_ns, size) of the copy we last read or wrote
state = {"local": {**DEFAULT_LOCAL}, "disclaimers": [], "settings": {**DEFAULT_SETTINGS}, "history": [], "jobs": []}


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


def load(name):
    p = os.path.join(DATA, FILES[name])
    default = {} if name == "settings" else []
    data = _read_json(p, default) if os.path.exists(p) else default
    before = json.dumps(data, sort_keys=True)
    if name == "settings":
        data = {**DEFAULT_SETTINGS, **{k: v for k, v in data.items() if k in DEFAULT_SETTINGS}}
        data["recent_parents"] = [portable_path(x) for x in data.get("recent_parents") or []]
    if name == "jobs":
        data = [normalize_job(j) for j in data]
    state[name] = data; _seen[name] = _stat(p)
    if os.path.exists(p) and json.dumps(data, sort_keys=True) != before:
        save(name)        # older absolute paths were made portable; write them back so the other machine can use them


def save(name):
    p = os.path.join(DATA, FILES[name])
    _write_json(p, state[name]); _seen[name] = _stat(p)


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


def refresh():
    """Pick up changes the other machine synced through Drive: re-read any data file whose
    mtime/size differs from the copy we last read or wrote. Cheap (four stats), called per request."""
    with lock:
        if choose_data_dir():
            return
        for n, fn in FILES.items():
            p = os.path.join(DATA, fn)
            st = _stat(p)
            if st != _seen.get(n):
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

@app.get("/health")
def health():
    root = library_root()
    return {"version": VERSION, "ok": True, "ffmpeg": ffmpeg_ok(), "data": DATA, "shared": DATA != LOCAL, "local": LOCAL,
            "machine": MACHINE, "platform": sys.platform, "sep": os.sep,
            "library_root": root, "library_root_ok": bool(root) and os.path.isdir(root), "library_root_guess": guess_library_root(),
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
    print(f"Scale Cases disclaimer worker on http://127.0.0.1:{PORT}  (data: {DATA}{'' if DATA != LOCAL else ' — local only, Drive folder not found'})")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
