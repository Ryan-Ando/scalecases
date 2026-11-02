"""Helper routes for the site's Video Edits tab (see video_edit.py for the project format).
Media is served only when the project's timeline or versions reference it, so the endpoints can't
be used to read arbitrary files from this computer."""
import os, threading, time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

import video_edit as ve

_jobs = {}            # project → {"kind", "state": running|done|error, "error", "started", "result"}
_probe_cache = {}     # path → (mtime, info)


def _project(name):
    try:
        pdir = ve.project_dir(name)
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(400, str(e))
    if not os.path.isfile(os.path.join(pdir, "timeline.json")):
        raise HTTPException(404, "project not found")
    return pdir


def _probe(path):
    try:
        m = os.path.getmtime(path)
    except OSError:
        return {"exists": False}
    hit = _probe_cache.get(path)
    if hit and hit[0] == m:
        return hit[1]
    try:
        info = {"exists": True, **ve.probe(path)}
    except Exception as e:     # unreadable media: report it, don't fail the page
        info = {"exists": True, "error": str(e)}
    _probe_cache[path] = (m, info)
    return info


def _referenced(pdir, src):
    """The resolved path of `src` if the project uses it (timeline items or a draft), else 403."""
    tl = ve.read_json(os.path.join(pdir, "timeline.json"), {})
    srcs = {x.get("src") for k in ("video", "overlays", "audio") for x in tl.get(k, [])}
    srcs |= {v.get("file") for v in ve.read_json(os.path.join(pdir, "versions.json"), []) if v.get("file")}
    if src not in srcs:
        raise HTTPException(403, "not part of this project")
    path = ve.resolve_src(pdir, src)
    if not os.path.isfile(path):
        raise HTTPException(404, "file missing (still syncing from Drive?)")
    return path


def _run(project, kind, fn):
    if _jobs.get(project, {}).get("state") == "running":
        raise HTTPException(409, f"a {_jobs[project]['kind']} is already running for this project")
    job = {"kind": kind, "state": "running", "error": None, "started": time.time(), "result": None}
    _jobs[project] = job

    def go():
        try:
            job["result"] = fn()
            job["state"] = "done"
        except Exception as e:
            job["state"], job["error"] = "error", str(e)
    threading.Thread(target=go, daemon=True).start()
    return job


def make_router(cache_dir):
    r = APIRouter(prefix="/edits")

    @r.get("")
    def projects():
        return {"root": ve.edits_root(), "library": ve.library_dir(), "machine": ve.MACHINE,
                "projects": ve.list_projects(), "rules": ve.read_rules()}

    @r.get("/{name}")
    def project(name: str):
        pdir = _project(name)
        tl = ve.read_json(os.path.join(pdir, "timeline.json"), {})
        sources = {}
        for k in ("video", "overlays", "audio"):
            for x in tl.get(k, []):
                if x.get("src") and x["src"] not in sources:
                    sources[x["src"]] = _probe(ve.resolve_src(pdir, x["src"]))
        try:
            duration = ve.timeline_duration(tl)
        except Exception:
            duration = 0
        return {"name": name, "timeline": tl, "duration": duration, "sources": sources,
                "versions": ve.read_json(os.path.join(pdir, "versions.json"), []), "notes": ve.load_notes(pdir),
                "job": _jobs.get(name), "machine": ve.MACHINE}

    @r.get("/{name}/file")
    def file(name: str, src: str):
        path = _referenced(_project(name), src)
        return FileResponse(path, headers={"Cache-Control": "private, max-age=60"})

    @r.get("/{name}/thumb")
    def thumb(name: str, src: str, t: float = 0):
        path = _referenced(_project(name), src)
        out = ve.thumbnail(path, max(0.0, t), cache_dir)
        if not os.path.isfile(out):
            raise HTTPException(404, "no frame there")
        return FileResponse(out, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})

    @r.get("/{name}/wave")
    def wave(name: str, src: str):
        return {"pps": 20, "peaks": ve.waveform(_referenced(_project(name), src), cache_dir)}

    @r.post("/{name}/notes")
    async def add_note(name: str, req: Request):
        b = await req.json()
        if not (b.get("text") or "").strip():
            raise HTTPException(400, "write the note first")
        try:
            return ve.add_note(_project(name), b["text"], t=b.get("t"), version=b.get("version"), kind=b.get("kind", "fix"), author=b.get("author"))
        except ValueError as e:
            raise HTTPException(400, str(e))

    @r.post("/{name}/notes/{note_id}")
    async def edit_note(name: str, note_id: str, req: Request):
        b = await req.json()
        allowed = {k: b[k] for k in ("status", "rule_status", "rule", "reply", "text") if k in b}
        try:
            return ve.update_note(_project(name), note_id, **allowed)
        except KeyError as e:
            raise HTTPException(404, str(e))

    @r.post("/{name}/render")
    async def render(name: str, req: Request):
        b = await req.json() if (await req.body()) else {}
        pdir = _project(name)
        return _run(name, "draft render", lambda: ve.render_version(pdir, b.get("note") or "Rendered from the Video Edits tab"))

    @r.post("/{name}/export")
    async def export(name: str, req: Request):
        b = await req.json()
        pdir = _project(name)
        return _run(name, "final export", lambda: ve.export_final(pdir, (b.get("name") or "").strip()))

    @r.post("/{name}/cleanup")
    def cleanup(name: str):
        return {"removed": ve.cleanup_drafts(_project(name))}

    return r
