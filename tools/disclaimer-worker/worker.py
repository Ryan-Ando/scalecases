"""Scale Cases local disclaimer worker.

Runs on this PC only (127.0.0.1:43128) and does the heavy lifting for the Disclaimers tab:
disclaimer library, folder browsing, date sorting, rendering jobs (image + video), review
previews, approve/reject into the chosen destination, and output history.

Start:   python worker.py            (or the Startup shortcut created by install.ps1)
Data:    %LOCALAPPDATA%\\ScaleCasesDisclaimers   (library, settings, history, jobs, staging)
"""
import os, sys, json, uuid, time, shutil, threading, subprocess, queue, string
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
import uvicorn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import disclaimer_image as dimg
import disclaimer_video as dvid

VERSION = 1
PORT = 43128
ORIGINS = ["https://scalecases-client.onrender.com", "http://localhost:5173", "http://127.0.0.1:5173"]
DATA = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "ScaleCasesDisclaimers")
STAGING = os.path.join(DATA, "staging")
PREVIEWS = os.path.join(DATA, "previews")
INBOX = os.path.join(DATA, "inbox")          # copies of files dropped onto the tab
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_EXT = {".mp4", ".mov", ".m4v"}
for d in (DATA, STAGING, PREVIEWS, INBOX):
    os.makedirs(d, exist_ok=True)

DEFAULT_SETTINGS = {
    "tags": ["LSS CA", "CA LSS", "LSS CO", "CO LSS", "C-L"],
    "out_folder": "new disclaimer",
    "recent_parents": [],
}

lock = threading.RLock()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load(name, default):
    p = os.path.join(DATA, name)
    if not os.path.exists(p):
        return default
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def save(name, data):
    p = os.path.join(DATA, name); tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, p)


state = {
    "disclaimers": load("disclaimers.json", []),
    "settings": {**DEFAULT_SETTINGS, **load("settings.json", {})},
    "history": load("history.json", []),
    "jobs": load("jobs.json", []),
}
# anything that was mid-flight when the worker last stopped is stale
for j in state["jobs"]:
    for it in j["items"]:
        if it["status"] in ("queued", "running"):
            it["status"] = "error"; it["error"] = "worker restarted before this item finished"
save("jobs.json", state["jobs"])


def persist(*names):
    with lock:
        for n in names:
            save({"disclaimers": "disclaimers.json", "settings": "settings.json",
                  "history": "history.json", "jobs": "jobs.json"}[n], state[n])


app = FastAPI(title="Scale Cases disclaimer worker")
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def private_network(request: Request, call_next):
    # Chrome's Private Network Access preflight needs this header on loopback services
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


def run_item(job, item):
    item["status"] = "running"; item["started"] = now(); item["error"] = None
    persist("jobs")
    try:
        if not ffmpeg_ok() and item["kind"] == "video":
            raise RuntimeError("ffmpeg/ffprobe not found on PATH")
        ext = os.path.splitext(item["out_name"])[1]
        item["staging"] = os.path.join(STAGING, f"{job['id']}_{item['idx']}{ext}")
        fn = dimg.run_image if item["kind"] == "image" else dvid.run_video
        res = fn(item["src"], item["text"], item["staging"], item.get("overrides") or {})
        item["result"] = res
        item["flags"] = list(res.get("flags", []))
        item["log"] = list(res.get("log", []))
        make_previews(item)
        item["status"] = "review"
    except Exception as e:
        item["status"] = "error"; item["error"] = str(e)
        item["log"] = (item.get("log") or []) + [f"ERROR {e}"]
    item["finished"] = now()
    persist("jobs")


def runner():
    while True:
        jid, idx = work_q.get()
        try:
            with lock:
                job = next((j for j in state["jobs"] if j["id"] == jid), None)
                item = job["items"][idx] if job else None
            if item and item["status"] == "queued":
                run_item(job, item)
        except Exception as e:
            print("runner error", e, file=sys.stderr)
        finally:
            work_q.task_done()


threading.Thread(target=runner, daemon=True).start()


# ───────────────────────────── routes: status, library, settings ─────────────────────────────

@app.get("/health")
def health():
    return {"version": VERSION, "ok": True, "ffmpeg": ffmpeg_ok(), "data": DATA,
            "queued": sum(1 for j in state["jobs"] for i in j["items"] if i["status"] in ("queued", "running"))}


@app.get("/state")
def get_state():
    return {"disclaimers": state["disclaimers"], "settings": state["settings"]}


@app.post("/disclaimers")
async def add_disclaimer(req: Request):
    b = await req.json()
    name = (b.get("name") or "").strip(); text = " ".join((b.get("text") or "").split())
    if not name or not text:
        raise HTTPException(400, "name and text are required")
    if any(d["name"].lower() == name.lower() for d in state["disclaimers"]):
        raise HTTPException(400, "a disclaimer with that name already exists")
    d = {"id": uuid.uuid4().hex[:12], "name": name, "text": text, "version": 1, "parent": (b.get("parent") or "").strip(),
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
            d["parent"] = (b["parent"] or "").strip()
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
    return state["settings"]


def remember_parent(parent):
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
    return {"path": dest, "name": name, "kind": kind_of(name), "size": os.path.getsize(dest)}


# ───────────────────────────── routes: filesystem ─────────────────────────────

@app.get("/fs")
def fs(path: str = ""):
    if not path:
        drives = [f"{c}:\\" for c in string.ascii_uppercase if os.path.exists(f"{c}:\\")]
        return {"path": "", "parent": None, "dirs": drives, "files": []}
    path = os.path.abspath(path)
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
    if parent == path or len(path) <= 3: parent = ""
    return {"path": path, "parent": parent, "dirs": dirs, "files": files}


@app.get("/diff")
def diff(parent: str):
    parent = os.path.abspath(parent)
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
    parent = os.path.abspath(b.get("parent") or ""); apply = bool(b.get("apply"))
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
    return {"job_id": job_id, "idx": idx, "src": src, "name": name, "kind": kind_of(src), "parent": parent,
            "disclaimer_id": disc["id"], "disclaimer_name": disc["name"], "version": disc["version"],
            "text": disc["text"], "out_name": out_name, "out_path": out_path, "staging": None,
            "status": "queued", "result": None, "log": [], "previews": [], "flags": [],
            "overrides": overrides or {}, "error": None, "created": now()}


@app.post("/jobs")
async def create_job(req: Request):
    b = await req.json()
    files = [os.path.abspath(f) for f in b.get("files") or []]
    targets = b.get("targets") or []
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
            items.append(build_item(jid, len(items), f, os.path.abspath(t["parent"]), disc, overrides))
        remember_parent(os.path.abspath(t["parent"]))
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
            if it.get("staging") and os.path.exists(it["staging"]):
                try: os.remove(it["staging"])
                except OSError: pass
        shutil.rmtree(os.path.join(PREVIEWS, jid), ignore_errors=True)
        state["jobs"].remove(job); persist("jobs")
    return {"ok": True}


@app.post("/jobs/{jid}/items/{idx}/approve")
def approve(jid: str, idx: int):
    job = find_job(jid); item = job["items"][idx]
    if item["status"] != "review":
        raise HTTPException(400, f"item is {item['status']}, not awaiting review")
    if not item.get("staging") or not os.path.exists(item["staging"]):
        raise HTTPException(400, "staged output is missing; re-render it")
    if os.path.abspath(item["out_path"]) == os.path.abspath(item["src"]):
        raise HTTPException(400, "output would overwrite the source")
    os.makedirs(os.path.dirname(item["out_path"]), exist_ok=True)
    shutil.move(item["staging"], item["out_path"])
    item["staging"] = None; item["status"] = "approved"; item["approved"] = now()
    rec = {"id": uuid.uuid4().hex[:10], "job_id": jid, "idx": idx, "out_path": item["out_path"], "src": item["src"],
           "name": item["out_name"], "parent": item["parent"], "disclaimer_id": item["disclaimer_id"],
           "disclaimer_name": item["disclaimer_name"], "version": item["version"], "kind": item["kind"],
           "method": (item["result"] or {}).get("method"), "flags": item["flags"], "overrides": item["overrides"], "ts": now()}
    with lock:
        state["history"] = [h for h in state["history"] if h["out_path"].lower() != item["out_path"].lower()]
        state["history"].insert(0, rec); persist("history", "jobs")
    return item


@app.post("/jobs/{jid}/items/{idx}/reject")
def reject(jid: str, idx: int):
    job = find_job(jid); item = job["items"][idx]
    if item.get("staging") and os.path.exists(item["staging"]):
        try: os.remove(item["staging"])
        except OSError: pass
    item["staging"] = None; item["status"] = "rejected"
    persist("jobs")
    return item


@app.post("/jobs/{jid}/items/{idx}/rerender")
async def rerender(jid: str, idx: int, req: Request):
    b = await req.json(); job = find_job(jid); item = job["items"][idx]
    if item["status"] in ("queued", "running"):
        raise HTTPException(400, "item is still running")
    if item.get("staging") and os.path.exists(item["staging"]):
        try: os.remove(item["staging"])
        except OSError: pass
    item["overrides"] = b.get("overrides") or {}
    disc = next((d for d in state["disclaimers"] if d["id"] == item["disclaimer_id"]), None)
    if disc:
        item["text"] = disc["text"]; item["version"] = disc["version"]
    item["status"] = "queued"; item["result"] = None; item["previews"] = []; item["flags"] = []; item["log"] = []; item["error"] = None
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
                    "stale": bool(d and h["version"] < d["version"]), "exists": os.path.exists(h["out_path"]),
                    "src_exists": os.path.exists(h["src"])})
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
        if not disc or not os.path.isfile(h["src"]): continue
        items.append(build_item(jid, len(items), h["src"], h["parent"], disc, h.get("overrides") or {}, out_name=h["name"]))
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
    print(f"Scale Cases disclaimer worker on http://127.0.0.1:{PORT}  (data: {DATA})")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
