"""Video edits: a timeline file per project, rendered with ffmpeg, reviewed in the site's Video Edits tab.

Projects live in the Shared Drive next to the ad library ("<drive>/Edits/<project>/"):
  timeline.json          the edit (schema below); the only thing Claude edits
  versions.json          every render: [{v, file, note, ts, machine, duration}]
  drafts/v<N>.mp4        low-res review renders; only the newest KEEP_DRAFTS are kept
  notes/<machine>.json   timestamped review notes, one file per machine (merged on read)
  sources/               clips, VO, music, images used by this project (any other path also works)
Approved lessons go to "<drive>/Edits/_editor/RULES.md", which the video-editor skill reads first.
Final exports go into the ad library: "<drive>/20xx B2C/<mmdd>/<name>.mp4".

timeline.json (times in seconds; x/y/w are fractions of the frame):
{
  "title": "Storytime 75k", "width": 1080, "height": 1920, "fps": 30, "duration": null,
  "video":    [{"id": "v1", "src": "sources/shot01.mp4", "start": 0, "in": 0, "out": 4.2, "speed": 1,
                "fit": "cover", "volume": 0, "label": "crash"}],              # images: give "dur" instead of in/out
  "overlays": [{"id": "o1", "src": "sources/check.png", "start": 34.4, "end": 37.7, "x": 0.5, "y": 0.45, "w": 0.8}],
  "captions": [{"id": "c1", "text": "I got rear-ended", "start": 0.2, "end": 1.9, "style": "caption"}],
  "audio":    [{"id": "a1", "src": "sources/vo.mp3", "start": 0, "in": 0, "out": null, "volume": 1,
                "fade_in": 0, "fade_out": 0, "label": "VO"}],
  "styles":   {"caption": {"size": 62, "bold": true, "color": "#ffffff", "stroke": 6, "stroke_color": "#000000",
                           "y": 0.7, "max_width": 0.86},
               "disclaimer": {"size": 26, "bold": true, "color": "#000000", "box": "#ffffffee", "pad": 14,
                              "radius": 14, "y": 0.95, "max_width": 0.92}},
  "loudnorm": true
}
Paths are relative to the project folder, absolute, or "{library}/..." (the 20xx B2C folder).

CLI (what Claude uses):  python video_edit.py where | list | new <name> [--title T] | render <project> --note "..." |
                         notes <project> [--all] | resolve <project> <note-id> --reply "..." |
                         propose <project> <note-id> --rule "..." | export <project> --name 1102-Title-1 | rules
"""
import glob, hashlib, json, os, platform, re, shutil, subprocess, sys, tempfile, threading, time, uuid
from datetime import datetime, timezone

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_REG = os.path.join(HERE, "fonts", "selawk.ttf")
FONT_BOLD = os.path.join(HERE, "fonts", "selawkb.ttf")
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
KEEP_DRAFTS = 3
DRAFT_WIDTH = 540
MACHINE = re.sub(r"[^A-Za-z0-9_-]+", "-", os.environ.get("SC_DISCLAIMER_MACHINE") or platform.node() or "pc")
DEFAULT_STYLES = {
    "caption": {"size": 62, "bold": True, "color": "#ffffff", "stroke": 6, "stroke_color": "#000000", "y": 0.7, "max_width": 0.86},
    "disclaimer": {"size": 26, "bold": True, "color": "#000000", "box": "#ffffffee", "pad": 14, "radius": 14, "y": 0.95, "max_width": 0.92},
    "title": {"size": 84, "bold": True, "color": "#ffffff", "stroke": 8, "stroke_color": "#000000", "y": 0.2, "max_width": 0.9},
}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ───────────────────────────── where things are ─────────────────────────────

def _drive_folders():
    """Shared drives first, then My Drive, on macOS (Google Drive for desktop) and Windows."""
    out = []
    home = os.path.expanduser("~")
    for acct in sorted(glob.glob(os.path.join(home, "Library", "CloudStorage", "GoogleDrive-*"))):
        out += sorted(glob.glob(os.path.join(acct, "Shared drives", "*"))) + [os.path.join(acct, "My Drive")]
    for letter in "GHIJKLMNOPQRSTUVWXYZ":
        base = f"{letter}:\\"
        if os.path.isdir(os.path.join(base, "Shared drives")):
            out += sorted(glob.glob(os.path.join(base, "Shared drives", "*"))) + [os.path.join(base, "My Drive")]
    return [d for d in out if os.path.isdir(d)]


def _libraries(folder):
    try:
        return sorted((e.name for e in os.scandir(folder) if e.is_dir() and re.match(r"^20\d{2}.*B2C$", e.name, re.I)), reverse=True)
    except OSError:
        return []


def drive_home():
    """The Drive folder holding the ad library (the Shared Drive "ScaleCases Cloud")."""
    if os.environ.get("SC_EDITS"):
        return os.path.dirname(os.path.abspath(os.environ["SC_EDITS"]))
    for d in _drive_folders():
        if os.path.isdir(os.path.join(d, "Edits")) or _libraries(d):
            return d
    return ""


def edits_root():
    if os.environ.get("SC_EDITS"):
        return os.path.abspath(os.environ["SC_EDITS"])
    home = drive_home()
    return os.path.join(home, "Edits") if home else ""


def library_dir():
    home = drive_home()
    libs = _libraries(home) if home else []
    return os.path.join(home, libs[0]) if libs else ""


def rules_path():
    return os.path.join(edits_root(), "_editor", "RULES.md")


def project_dir(name):
    root = edits_root()
    if not root:
        raise FileNotFoundError("Google Drive's ScaleCases Cloud folder was not found on this computer")
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9 _.-]{0,80}$", name or "") or ".." in name:
        raise ValueError("Project names use letters, numbers, spaces, dots, dashes and underscores")
    return os.path.join(root, name)


def resolve_src(pdir, src):
    if not src:
        raise ValueError("missing src")
    if src.startswith("{library}"):
        rest = src[len("{library}"):].lstrip("/\\")
        return os.path.join(library_dir(), *rest.replace("\\", "/").split("/"))
    return src if os.path.isabs(src) else os.path.join(pdir, *src.replace("\\", "/").split("/"))


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{uuid.uuid4().hex[:6]}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


# ───────────────────────────── projects, versions, notes ─────────────────────────────

def list_projects():
    root = edits_root()
    out = []
    if not root or not os.path.isdir(root):
        return out
    for e in sorted(os.scandir(root), key=lambda e: e.name.lower()):
        if not e.is_dir() or e.name.startswith(("_", ".")):
            continue
        tl = read_json(os.path.join(e.path, "timeline.json"), None)
        if tl is None:
            continue
        versions = read_json(os.path.join(e.path, "versions.json"), [])
        notes = load_notes(e.path)
        updated = max([v.get("ts", "") for v in versions] + [n.get("ts", "") for n in notes] + [""])
        out.append({"name": e.name, "title": tl.get("title") or e.name, "versions": len(versions),
                    "latest": versions[-1]["v"] if versions else None, "exported": any(v.get("export") for v in versions),
                    "open_notes": sum(1 for n in notes if n.get("status") == "open"),
                    "pending_rules": sum(1 for n in notes if n.get("rule_status") == "pending"), "updated": updated})
    return sorted(out, key=lambda p: p["updated"], reverse=True)


def new_project(name, title=None, width=1080, height=1920, fps=30):
    pdir = project_dir(name)
    if os.path.exists(os.path.join(pdir, "timeline.json")):
        raise FileExistsError(f"Project {name} already exists")
    for sub in ("sources", "drafts", "notes"):
        os.makedirs(os.path.join(pdir, sub), exist_ok=True)
    write_json(os.path.join(pdir, "timeline.json"), {"title": title or name, "width": width, "height": height, "fps": fps,
               "duration": None, "video": [], "overlays": [], "captions": [], "audio": [], "styles": DEFAULT_STYLES, "loudnorm": True})
    write_json(os.path.join(pdir, "versions.json"), [])
    return pdir


def load_notes(pdir):
    """Every machine's notes, newest copy of each note wins."""
    merged = {}
    for path in glob.glob(os.path.join(pdir, "notes", "*.json")):
        for n in read_json(path, []):
            if n.get("id") and (n["id"] not in merged or n.get("_u", "") > merged[n["id"]].get("_u", "")):
                merged[n["id"]] = n
    return sorted(merged.values(), key=lambda n: (n.get("version") or 0, n.get("t") or 0, n.get("ts", "")))


def save_note(pdir, note):
    """Write (add or update) one note into this machine's notes file."""
    path = os.path.join(pdir, "notes", f"{MACHINE}.json")
    mine = [n for n in read_json(path, []) if n.get("id") != note["id"]]
    note = {**note, "_u": datetime.now(timezone.utc).isoformat(timespec="microseconds")}
    write_json(path, mine + [note])
    return note


def add_note(pdir, text, t=None, version=None, kind="fix", author=None):
    if kind not in ("fix", "lesson"):
        raise ValueError("kind is fix or lesson")
    return save_note(pdir, {"id": uuid.uuid4().hex[:8], "version": version, "t": t, "text": text.strip(), "kind": kind,
                            "status": "open", "author": author or MACHINE, "ts": now(), "reply": None,
                            "rule": None, "rule_status": None})


def update_note(pdir, note_id, **fields):
    note = next((n for n in load_notes(pdir) if n["id"] == note_id), None)
    if not note:
        raise KeyError(f"no note {note_id}")
    note.update({k: v for k, v in fields.items() if v is not None})
    if fields.get("rule_status") == "approved" and note.get("rule"):
        append_rule(note["rule"], os.path.basename(pdir), note_id)
    return save_note(pdir, note)


def append_rule(rule, project, note_id):
    path = rules_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    head = "" if os.path.exists(path) else ("# Video editor rules\n\nLearned from review notes in the Video Edits tab. "
                                             "The video-editor skill reads this before every edit. Newest last.\n\n")
    with open(path, "a", encoding="utf-8") as f:
        f.write(f"{head}- {rule.strip()}  _(from {project}, note {note_id}, {now()[:10]})_\n")


def read_rules():
    try:
        with open(rules_path(), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


# ───────────────────────────── rendering ─────────────────────────────

def probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height",
                        "-of", "json", path], capture_output=True, text=True)
    if r.returncode:
        raise ValueError(f"can't read {path}: {r.stderr.strip()[:200]}")
    d = json.loads(r.stdout)
    streams = d.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), {})
    return {"duration": float(d.get("format", {}).get("duration") or 0), "audio": any(s.get("codec_type") == "audio" for s in streams),
            "width": v.get("width"), "height": v.get("height")}


def _rgba(c):
    c = (c or "#ffffff").lstrip("#")
    if len(c) == 6:
        c += "ff"
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4, 6))


def caption_png(text, style, W, H, scale, out):
    """One caption drawn to a transparent PNG; returns (x, y) where it goes on the frame."""
    # Plain text unless the style asks for an outline or a box (styles don't inherit from "caption")
    st = {"size": 48, "bold": True, "color": "#ffffff", "stroke": 0, "stroke_color": "#000000", "y": 0.7, "max_width": 0.86, **(style or {})}
    size = max(8, round(st["size"] * scale))
    font = ImageFont.truetype(st.get("font") or (FONT_BOLD if st.get("bold") else FONT_REG), size)
    stroke = round(st.get("stroke", 0) * scale)
    max_w = W * st.get("max_width", 0.86)
    lines = []
    for para in str(text).split("\n"):
        words, line = para.split(), ""
        for w in words:
            trial = f"{line} {w}".strip()
            if line and font.getlength(trial) + 2 * stroke > max_w:
                lines.append(line); line = w
            else:
                line = trial
        lines.append(line)
    gap = round(size * 0.18)
    boxes = [font.getbbox(l or " ", stroke_width=stroke) for l in lines]
    widths = [b[2] - b[0] for b in boxes]
    lh = max(b[3] - b[1] for b in boxes)
    pad = round(st.get("pad", 0) * scale) if st.get("box") else 0
    tw, th = max(widths) + 2 * pad, lh * len(lines) + gap * (len(lines) - 1) + 2 * pad
    img = Image.new("RGBA", (int(tw) + 2, int(th) + 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if st.get("box"):
        d.rounded_rectangle([0, 0, tw, th], radius=round(st.get("radius", 0) * scale), fill=_rgba(st["box"]))
    y = pad
    for l, b, w in zip(lines, boxes, widths):
        d.text(((tw - w) / 2 - b[0], y - b[1]), l, font=font, fill=_rgba(st["color"]),
               stroke_width=stroke, stroke_fill=_rgba(st.get("stroke_color", "#000000")))
        y += lh + gap
    img.save(out)
    x = round((W - img.width) / 2)
    yy = round(H * st.get("y", 0.7) - img.height / 2)
    return x, max(0, min(H - img.height, yy))


def timeline_duration(tl):
    ends = [0.0]
    for v in tl.get("video", []):
        ends.append(v.get("start", 0) + clip_len(v))
    for k in ("overlays", "captions"):
        ends += [x.get("end", 0) for x in tl.get(k, [])]
    for a in tl.get("audio", []):
        if a.get("out") is not None:
            ends.append(a.get("start", 0) + (a["out"] - a.get("in", 0)))
    return float(tl.get("duration") or max(ends))


def clip_len(v):
    if v.get("dur") is not None:
        return float(v["dur"])
    return (float(v["out"]) - float(v.get("in", 0))) / float(v.get("speed", 1) or 1)


def _even(n):
    return max(2, int(round(n / 2)) * 2)


def render(pdir, out, draft=True, log=None):
    """Render timeline.json to `out`. Draft = small and fast for review; final = full size."""
    tl = read_json(os.path.join(pdir, "timeline.json"), None)
    if tl is None:
        raise FileNotFoundError("timeline.json missing")
    W0, H0, fps = int(tl.get("width", 1080)), int(tl.get("height", 1920)), int(tl.get("fps", 30))
    scale = min(1.0, DRAFT_WIDTH / W0) if draft else 1.0
    W, H = _even(W0 * scale), _even(H0 * scale)
    D = timeline_duration(tl)
    if D <= 0:
        raise ValueError("The timeline is empty")
    styles = {**DEFAULT_STYLES, **(tl.get("styles") or {})}
    tmp = tempfile.mkdtemp(prefix="sc-edit-")
    args, filters, n = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"], [], 0
    filters.append(f"color=c=black:s={W}x{H}:r={fps}:d={D:.3f}[base0]")
    cur, step = "base0", 0
    audio_labels = []
    try:
        for v in sorted(tl.get("video", []), key=lambda v: v.get("start", 0)):
            src = resolve_src(pdir, v["src"])
            is_img = os.path.splitext(src)[1].lower() in IMAGE_EXT
            speed = float(v.get("speed", 1) or 1)
            length = clip_len(v)
            if is_img:
                args += ["-loop", "1", "-framerate", str(fps), "-t", f"{length:.3f}", "-i", src]
            else:
                args += ["-ss", f"{float(v.get('in', 0)):.3f}", "-t", f"{length * speed:.3f}", "-i", src]
            fit = ("scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black"
                   if v.get("fit") == "contain" else "scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}").format(W=W, H=H)
            start = float(v.get("start", 0))
            filters.append(f"[{n}:v]setpts=(PTS-STARTPTS)/{speed},{fit},fps={fps},setsar=1,format=yuv420p,setpts=PTS+{start:.3f}/TB[v{n}]")
            step += 1
            filters.append(f"[{cur}][v{n}]overlay=eof_action=pass:enable='between(t,{start:.3f},{start + length:.3f})'[base{step}]")
            cur = f"base{step}"
            if not is_img and float(v.get("volume", 0) or 0) > 0 and probe(src)["audio"]:
                tempo = f",atempo={speed}" if speed != 1 else ""
                ms = int(start * 1000)
                filters.append(f"[{n}:a]asetpts=PTS-STARTPTS{tempo},volume={float(v['volume'])},adelay={ms}|{ms}[a{n}]")
                audio_labels.append(f"[a{n}]")
            n += 1
        for o in tl.get("overlays", []):
            src = resolve_src(pdir, o["src"])
            s, e = float(o["start"]), float(o["end"])
            is_img = os.path.splitext(src)[1].lower() in IMAGE_EXT
            args += (["-loop", "1", "-framerate", str(fps), "-t", f"{e - s:.3f}", "-i", src] if is_img
                     else ["-ss", f"{float(o.get('in', 0)):.3f}", "-t", f"{e - s:.3f}", "-i", src])
            ow = _even(W * float(o.get("w", 0.5)))
            x = f"{W * float(o.get('x', 0.5)):.1f}-w/2"
            y = f"{H * float(o.get('y', 0.5)):.1f}-h/2"
            filters.append(f"[{n}:v]setpts=PTS-STARTPTS,scale={ow}:-2,format=rgba,setpts=PTS+{s:.3f}/TB[o{n}]")
            step += 1
            filters.append(f"[{cur}][o{n}]overlay=x={x}:y={y}:eof_action=pass:enable='between(t,{s:.3f},{e:.3f})'[base{step}]")
            cur = f"base{step}"
            n += 1
        for i, c in enumerate(tl.get("captions", [])):
            png = os.path.join(tmp, f"cap{i}.png")
            x, y = caption_png(c["text"], {**styles.get(c.get("style") or "caption", {}), **(c.get("override") or {})}, W, H, scale, png)
            s, e = float(c["start"]), float(c["end"])
            args += ["-loop", "1", "-framerate", str(fps), "-t", f"{e - s:.3f}", "-i", png]
            filters.append(f"[{n}:v]format=rgba,setpts=PTS-STARTPTS+{s:.3f}/TB[c{n}]")
            step += 1
            filters.append(f"[{cur}][c{n}]overlay=x={x}:y={y}:eof_action=pass:enable='between(t,{s:.3f},{e:.3f})'[base{step}]")
            cur = f"base{step}"
            n += 1
        for a in tl.get("audio", []):
            src = resolve_src(pdir, a["src"])
            seek = float(a.get("in", 0) or 0)
            dur = (float(a["out"]) - seek) if a.get("out") is not None else max(0.01, D - float(a.get("start", 0)))
            args += ["-ss", f"{seek:.3f}", "-t", f"{dur:.3f}", "-i", src]
            chain = [f"[{n}:a]asetpts=PTS-STARTPTS", f"volume={float(a.get('volume', 1))}"]
            if a.get("fade_in"):
                chain.append(f"afade=t=in:st=0:d={float(a['fade_in'])}")
            if a.get("fade_out"):
                chain.append(f"afade=t=out:st={max(0, dur - float(a['fade_out'])):.3f}:d={float(a['fade_out'])}")
            ms = int(float(a.get("start", 0)) * 1000)
            chain.append(f"adelay={ms}|{ms}")
            filters.append(",".join(chain) + f"[a{n}]")
            audio_labels.append(f"[a{n}]")
            n += 1
        if audio_labels:
            mix = f"{''.join(audio_labels)}amix=inputs={len(audio_labels)}:normalize=0:duration=longest"
            if tl.get("loudnorm", True) and not draft:
                mix += ",loudnorm=I=-14:TP=-1.5:LRA=11"
            filters.append(mix + f",apad,atrim=0:{D:.3f}[aout]")
        else:
            filters.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{D:.3f}[aout]")
        filters.append(f"[{cur}]null[vout]")
        script = os.path.join(tmp, "graph.txt")
        with open(script, "w", encoding="utf-8") as f:
            f.write(";\n".join(filters))
        enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28"] if draft else ["-c:v", "libx264", "-preset", "slow", "-crf", "18"]
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        part = out + ".part.mp4"
        tail = ["-map", "[vout]", "-map", "[aout]", "-t", f"{D:.3f}", *enc,
                "-pix_fmt", "yuv420p", "-r", str(fps), "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", part]
        if log:
            log(f"rendering {D:.1f}s at {W}x{H} with {n} inputs")
        # ffmpeg 7+ reads the graph from a file with "-/filter_complex"; older builds use -filter_complex_script
        r = subprocess.run(args + ["-/filter_complex", script] + tail, capture_output=True, text=True)
        if r.returncode and "Unrecognized option" in r.stderr:
            r = subprocess.run(args + ["-filter_complex_script", script] + tail, capture_output=True, text=True)
        if r.returncode:
            raise RuntimeError(f"ffmpeg failed: {r.stderr.strip()[-800:]}")
        os.replace(part, out)
        return {"duration": round(D, 3), "width": W, "height": H}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


_render_lock = threading.Lock()


def render_version(pdir, note="", log=None):
    """Draft render → drafts/v<N>.mp4, recorded in versions.json; old drafts beyond KEEP_DRAFTS deleted."""
    with _render_lock:
        versions = read_json(os.path.join(pdir, "versions.json"), [])
        v = (max([x["v"] for x in versions]) + 1) if versions else 1
        rel = f"drafts/v{v}.mp4"
        info = render(pdir, os.path.join(pdir, *rel.split("/")), draft=True, log=log)
        shutil.copy2(os.path.join(pdir, "timeline.json"), os.path.join(pdir, "drafts", f"v{v}.timeline.json"))
        versions.append({"v": v, "file": rel, "timeline": f"drafts/v{v}.timeline.json", "note": note, "ts": now(),
                         "machine": MACHINE, **info})
        drafts = [x for x in versions if x.get("file") and not x.get("export")]
        for old in drafts[:-KEEP_DRAFTS]:
            try:
                os.remove(os.path.join(pdir, *old["file"].split("/")))
            except OSError:
                pass
            old["file"] = None
        write_json(os.path.join(pdir, "versions.json"), versions)
        return versions[-1]


def export_final(pdir, name, log=None):
    """Full-quality render into the ad library: <library>/<mmdd>/<name>.mp4."""
    if not re.match(r"^[^/\\:*?\"<>|]{1,120}$", name or ""):
        raise ValueError("Give the export a file name (no slashes)")
    lib = library_dir()
    if not lib:
        raise FileNotFoundError("The 20xx B2C library folder was not found in Google Drive")
    code = name[:4] if re.match(r"^\d{4}", name) else datetime.now().strftime("%m%d")
    out = os.path.join(lib, code, name if name.lower().endswith(".mp4") else name + ".mp4")
    if os.path.exists(out):
        raise FileExistsError(f"{out} already exists; pick another name")
    with _render_lock:
        info = render(pdir, out, draft=False, log=log)
        versions = read_json(os.path.join(pdir, "versions.json"), [])
        versions.append({"v": (max([x["v"] for x in versions]) + 1) if versions else 1, "file": None, "export": out,
                         "note": f"Final export: {os.path.basename(out)}", "ts": now(), "machine": MACHINE, **info})
        write_json(os.path.join(pdir, "versions.json"), versions)
    return out


def cleanup_drafts(pdir):
    """After the final export: delete the draft videos (the timeline and notes stay)."""
    versions = read_json(os.path.join(pdir, "versions.json"), [])
    removed = 0
    for x in versions:
        if x.get("file"):
            try:
                os.remove(os.path.join(pdir, *x["file"].split("/"))); removed += 1
            except OSError:
                pass
            x["file"] = None
    write_json(os.path.join(pdir, "versions.json"), versions)
    return removed


# ───────────────────────────── timeline helpers for the UI ─────────────────────────────

def thumbnail(src, t, cache_dir, height=96):
    key = hashlib.sha1(f"{src}|{os.path.getmtime(src)}|{t:.2f}|{height}".encode()).hexdigest()[:20]
    out = os.path.join(cache_dir, f"{key}.jpg")
    if not os.path.exists(out):
        os.makedirs(cache_dir, exist_ok=True)
        if os.path.splitext(src)[1].lower() in IMAGE_EXT:
            cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-vf", f"scale=-2:{height}", "-frames:v", "1", out]
        else:
            cmd = ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", src, "-vf", f"scale=-2:{height}", "-frames:v", "1", out]
        subprocess.run(cmd, capture_output=True)
    return out


def waveform(src, cache_dir, points_per_sec=20):
    """Peak levels (0..1) at `points_per_sec`, for drawing audio blocks."""
    key = hashlib.sha1(f"{src}|{os.path.getmtime(src)}|{points_per_sec}".encode()).hexdigest()[:20]
    out = os.path.join(cache_dir, f"{key}.wave.json")
    if os.path.exists(out):
        return read_json(out, [])
    rate = 4000
    r = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", src, "-ac", "1", "-ar", str(rate), "-f", "s16le", "-"], capture_output=True)
    import array
    a = array.array("h"); a.frombytes(r.stdout[: len(r.stdout) // 2 * 2])
    step = max(1, rate // points_per_sec)
    peaks = [round(max((abs(x) for x in a[i:i + step]), default=0) / 32768, 3) for i in range(0, len(a), step)]
    os.makedirs(cache_dir, exist_ok=True)
    write_json(out, peaks)
    return peaks


# ───────────────────────────── CLI ─────────────────────────────

def _cli():
    import argparse
    p = argparse.ArgumentParser(description="Scale Cases video edits")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("where")
    sub.add_parser("list")
    sub.add_parser("rules")
    a = sub.add_parser("new"); a.add_argument("name"); a.add_argument("--title"); a.add_argument("--width", type=int, default=1080)
    a.add_argument("--height", type=int, default=1920); a.add_argument("--fps", type=int, default=30)
    a = sub.add_parser("render"); a.add_argument("project"); a.add_argument("--note", default="")
    a = sub.add_parser("notes"); a.add_argument("project"); a.add_argument("--all", action="store_true")
    a = sub.add_parser("resolve"); a.add_argument("project"); a.add_argument("note"); a.add_argument("--reply", required=True)
    a = sub.add_parser("propose"); a.add_argument("project"); a.add_argument("note"); a.add_argument("--rule", required=True)
    a = sub.add_parser("export"); a.add_argument("project"); a.add_argument("--name", required=True)
    a = sub.add_parser("cleanup"); a.add_argument("project")
    args = p.parse_args()
    if args.cmd == "where":
        print(json.dumps({"edits": edits_root(), "library": library_dir(), "rules": rules_path(), "machine": MACHINE}, indent=2)); return
    if args.cmd == "list":
        print(json.dumps(list_projects(), indent=2)); return
    if args.cmd == "rules":
        print(read_rules() or "(no rules yet)"); return
    if args.cmd == "new":
        print(new_project(args.name, args.title, args.width, args.height, args.fps)); return
    pdir = project_dir(args.project)
    if args.cmd == "render":
        print(json.dumps(render_version(pdir, args.note, log=print), indent=2))
    elif args.cmd == "notes":
        for n in load_notes(pdir):
            if args.all or n["status"] == "open" or n.get("rule_status") == "pending":
                t = f"{n['t']:.1f}s" if n.get("t") is not None else "—"
                print(f"[{n['id']}] v{n.get('version')} @ {t} {n['kind'].upper()} {n['status']}"
                      f"{' rule:' + n['rule_status'] if n.get('rule_status') else ''} — {n['text']}"
                      f"{chr(10) + '    reply: ' + n['reply'] if n.get('reply') else ''}")
    elif args.cmd == "resolve":
        print(json.dumps(update_note(pdir, args.note, status="done", reply=args.reply), indent=2))
    elif args.cmd == "propose":
        print(json.dumps(update_note(pdir, args.note, rule=args.rule, rule_status="pending"), indent=2))
    elif args.cmd == "export":
        print(export_final(pdir, args.name, log=print))
    elif args.cmd == "cleanup":
        print(f"removed {cleanup_drafts(pdir)} draft videos")


if __name__ == "__main__":
    _cli()
