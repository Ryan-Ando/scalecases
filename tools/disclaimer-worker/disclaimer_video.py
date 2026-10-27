"""Replace the burned-in disclaimer at the top or bottom of a video ad.

Steps per video:
  1. Decode a downscaled top and bottom strip of every frame and detect which frames contain
     small bright text (thin bright strokes). Gives exact start/end frames per region; there
     may be several ranges (e.g. one at the start and another at the end).
  2. For EACH range, pull a few full-res frames, locate the text band, reject anything that is
     not a disclaimer (captions, story text, UI), and decide the hiding method: solid fill if
     the background behind the text is flat (whole frame width, or a solid card), otherwise a
     hard-edged frosted rounded box (default) or a soft feathered blur. The frosted box erases
     the old text with two median passes, then a light blur and a slight tint.
  3. Render the new disclaimer sized to that range's old band and composite it only on that
     range's frames. All ranges go through one ffmpeg pass. Audio is copied.

Library use:   run_video(src, text, out_path, opts) -> result dict
CLI use:       python disclaimer_video.py "ad.mp4" --text-file t.txt --out "out.mp4"
"""
import argparse, os, subprocess, sys, tempfile, json
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import disclaimer_image as img

STRIP_FRAC = 0.22        # fraction of the frame height scanned at each edge
STRIP_W = 480            # downscaled width used for frame-by-frame presence detection


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,r_frame_rate,nb_frames", "-show_entries", "format=duration",
                          "-of", "json", path], capture_output=True, text=True, check=True).stdout
    j = json.loads(out); s = j["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    fps = float(num) / float(den)
    return int(s["width"]), int(s["height"]), fps, int(s.get("nb_frames") or round(float(j["format"]["duration"]) * fps))


def decode_strip(path, W, H, region="bottom"):
    sh = int(H * STRIP_FRAC); y = H - sh if region == "bottom" else 0
    h = int(round(sh * STRIP_W / W))
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-vf", f"crop={W}:{sh}:0:{y},scale={STRIP_W}:{h}",
           "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    n = len(raw) // (h * STRIP_W)
    return np.frombuffer(raw, np.uint8)[: n * h * STRIP_W].reshape(n, h, STRIP_W)


def thin_bright_score(strip):
    im = Image.fromarray(strip)
    mn = np.array(im.filter(ImageFilter.MinFilter(5)), dtype=int)
    return int(((strip > 200) & ((strip.astype(int) - mn) > 100)).sum())


def presence_ranges(scores, rel=0.35, min_len=5, max_gap=12):
    nz = scores[scores > 0]
    if len(nz) == 0:
        return []
    thr = float(np.percentile(nz, 90)) * rel
    on = scores >= thr
    ranges, start = [], None
    for i, v in enumerate(on):
        if v and start is None: start = i
        if not v and start is not None:
            ranges.append((start, i - 1)); start = None
    if start is not None: ranges.append((start, len(on) - 1))
    merged = []
    for a, b in ranges:
        if merged and a - merged[-1][1] - 1 <= max_gap:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    return [(a, b) for a, b in merged if b - a + 1 >= min_len]


def grab_frame(path, n, W, H):
    cmd = ["ffmpeg", "-v", "error", "-i", path, "-vf", f"select=eq(n\\,{n})", "-frames:v", "1",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(H, W, 3)


def text_runs(gray, y0, y1):
    g = gray[y0:y1 + 1].astype(int); k = 5; p = k // 2
    gp = np.pad(g, ((0, 0), (p, p)), mode="edge")
    win = np.lib.stride_tricks.sliding_window_view(gp, k, axis=1)
    mn, mx = win.min(axis=2), win.max(axis=2)
    sc = (((g > 170) & (g - mn > 90)) | ((g < 90) & (mx - g > 90))).sum(axis=1)
    rows = np.where(sc >= max(12, int(gray.shape[1] * 0.012)))[0]
    if len(rows) == 0:
        return []
    runs, s = [], rows[0]
    for a, b in zip(rows[:-1], rows[1:]):
        if b - a > 1:
            runs.append(a - s + 1); s = b
    runs.append(rows[-1] - s + 1)
    return runs


def analyze_range(path, a, b, W, H, style, frost, region="bottom", strict=True, band_scale=1.0):
    """Sample full-res frames across one presence range; return band geometry and method,
    or a string reason when the text is not a disclaimer, or None when no band was found."""
    samples = sorted(set(int(round(a + (b - a) * t)) for t in (0.1, 0.35, 0.6, 0.9)))
    bands, methods, bgs, xs, texts, grays, runs, frames = [], [], [], [], [], [], [], []
    for n in samples:
        fr = grab_frame(path, n, W, H)
        gray = np.array(Image.fromarray(fr).convert("L"))
        if region == "top":
            band = img.find_disclaimer_band(gray[::-1], absorb_short_tail=True)
            if band is not None:
                band = (H - 1 - band[1], H - 1 - band[0])
        else:
            band = img.find_disclaimer_band(gray)
        if band is None: continue
        runs.append(text_runs(gray, band[0], band[1]))
        y0, y1 = band
        pad = max(4, int(H * 0.004)); y0 = max(0, y0 - pad); y1 = min(H - 1, y1 + pad)
        m, bg, tc, (x0, x1), _ = img.analyze(fr, y0, y1)
        bands.append((y0, y1)); methods.append(m); bgs.append(bg); xs.append((x0, x1)); texts.append(tc)
        grays.append(gray); frames.append(fr)
    if not bands:
        return None
    y0 = min(bb[0] for bb in bands); y1 = max(bb[1] for bb in bands)
    if strict:
        if region == "bottom" and y1 < 0.93 * H:
            return "caption (not at the bottom edge)"
        if region == "top" and y0 > 0.07 * H:
            return "caption (not at the top edge)"
        nlines = int(np.median([len(r) for r in runs]))
        glyph = float(np.median([np.median(r) for r in runs if r]))
        if nlines < 4 or glyph > 0.016 * H:
            return f"caption ({nlines} lines, glyph height {glyph / H * 100:.1f}% of frame)"
    if band_scale != 1.0:
        if region == "bottom":
            y0 = max(0, y1 - int((y1 - y0) * band_scale))
        else:
            y1 = min(H - 1, y0 + int((y1 - y0) * band_scale))
    x0 = min(x[0] for x in xs); x1 = max(x[1] for x in xs)
    solid = all(m == "solid" for m in methods) and all(img.color_dist(np.array(bg), bgs[0]) < 20 for bg in bgs)
    sx0, sx1 = 0, W - 1
    card = False
    if not solid:
        cols = []
        for g in grays:
            gb = g[y0:y1 + 1].astype(int); k = 5; p = 2
            gp = np.pad(gb, ((0, 0), (p, p)), mode="edge")
            win = np.lib.stride_tricks.sliding_window_view(gp, k, axis=1)
            thin = ((gb > 170) & (gb - win.min(axis=2) > 90)) | ((gb < 90) & (win.max(axis=2) - gb > 90))
            c = np.where(thin.sum(axis=0) >= 2)[0]
            if len(c): cols.append((int(np.percentile(c, 1)), int(np.percentile(c, 99))))
        if cols:
            tx0 = min(c[0] for c in cols); tx1 = max(c[1] for c in cols)
            m_ = int(W * 0.015)
            cx0, cx1 = max(0, tx0 - m_), min(W - 1, tx1 + m_)
            res = [img.analyze(fr[:, cx0:cx1 + 1], y0, y1) for fr in frames]
            if all(r_[0] == "solid" for r_ in res) and all(img.color_dist(np.array(r_[1]), res[0][1]) < 20 for r_ in res):
                solid = True; card = True
                bgs = [r_[1] for r_ in res]; texts = [r_[2] for r_ in res]
                sx0, sx1 = cx0, cx1
                x0, x1 = tx0, tx1
    method = "solid" if solid else "blur"
    bg = bgs[0]
    band_luma = float(np.mean([g[y0:y1 + 1].mean() for g in grays]))
    if solid:
        text_color, stroke = texts[0], 0
    elif style == "frost":
        panel_luma = band_luma * (1 - abs(frost)) + (255 * frost if frost > 0 else 0)
        text_color, stroke = ((28, 28, 30), 0) if panel_luma > 140 else ((255, 255, 255), max(1, int(H * 0.0012)))
    else:
        text_color, stroke = (255, 255, 255), max(1, int(H * 0.001))
    return dict(y0=int(y0), y1=int(y1), x0=int(x0), x1=int(x1), method=method, bg=bg, text_color=text_color,
                stroke=stroke, methods=methods, region=region, sx0=int(sx0), sx1=int(sx1), card=card,
                band_luma=band_luma)


def render_text(text, W, H, r, font_path):
    y0, y1, x0, x1 = r["y0"], r["y1"], r["x0"], r["x1"]
    pad = max(4, int(H * 0.004))
    margin = int(W * 0.015)
    tx0, tx1 = max(margin, x0), min(W - margin, x1)
    max_w, max_h = tx1 - tx0, (y1 - y0 + 1) - 2 * pad
    fit = img.wrap_fit(text, font_path, max_w, max_h)
    if fit is None:
        return None
    size, font, lines, lh = fit
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
    y = y0 + pad + (max_h - lh * len(lines)) // 2; cx = (tx0 + tx1) / 2
    stroke, tc = r["stroke"], r["text_color"]
    for ln in lines:
        kw = dict(stroke_width=stroke, stroke_fill=(0, 0, 0)) if stroke else {}
        d.text((cx - font.getlength(ln) / 2, y), ln, font=font, fill=tc, **kw); y += lh
    return ov, size, len(lines)


def detect_ranges(path, W, H, regions=("bottom", "top")):
    found = []
    for region in regions:
        strips = decode_strip(path, W, H, region)
        scores = np.array([thin_bright_score(s) for s in strips])
        found += [dict(region=region, a=int(a), b=int(b)) for a, b in presence_ranges(scores)]
    return found


def run_video(path, text, out_path, opts=None):
    """Process one video. Returns a result dict; raises ValueError when nothing can be done."""
    opts = opts or {}
    force = opts.get("method", "auto") or "auto"       # auto | solid | frost | soft
    style = "soft" if force == "soft" else "frost"
    frost = float(opts.get("frost", -0.15) if opts.get("frost") is not None else -0.15)
    blur_sigma = opts.get("blur_sigma")
    blur_sigma = float(blur_sigma) if blur_sigma not in (None, "", 0) else None
    band_scale = float(opts.get("band_scale", 1.0) or 1.0)
    font_path = img.FONT_BOLD if opts.get("bold") else img.FONT_REG
    region_opt = opts.get("region", "auto") or "auto"
    manual = opts.get("ranges") or []
    log, flags = [], []

    name = os.path.basename(path)
    W, H, fps, nframes = probe(path)
    if manual:
        ranges = [dict(region=r.get("region", "bottom"), a=int(r["a"]), b=int(r["b"])) for r in manual]
        flags.append("manual_ranges")
        log.append("using manually specified ranges")
    else:
        regions = ("bottom", "top") if region_opt == "auto" else (region_opt,)
        ranges = detect_ranges(path, W, H, regions)
    log.append(f"{W}x{H} {fps:g}fps {nframes} frames; text detected: "
               + (", ".join(f"{r['region']} {r['a']}-{r['b']} ({r['a']/fps:.2f}s-{(r['b']+1)/fps:.2f}s)" for r in ranges) or "none"))
    if not ranges:
        raise ValueError("no disclaimer-like text detected at the top or bottom of the frame")

    tmp = tempfile.mkdtemp(prefix="vdisc_")
    inputs = ["-i", path]
    stages = []
    cur = "[0:v]"; vi = 0; nxt = 1
    accepted, rejected = [], []
    for ri, rg in enumerate(ranges):
        region, a, b = rg["region"], rg["a"], rg["b"]
        r = analyze_range(path, a, b, W, H, style, frost, region, strict=not manual, band_scale=band_scale)
        if r is None:
            rejected.append(dict(region=region, a=a, b=b, reason="could not locate a text band"))
            flags.append("range_unlocated"); continue
        if isinstance(r, str):
            rejected.append(dict(region=region, a=a, b=b, reason=r)); continue
        method = r["method"]
        if force == "solid" and method != "solid":
            method = "solid"; flags.append("forced_method"); r["text_color"], r["stroke"] = r["text_color"], 0
            log.append(f"range {a}-{b}: method forced to solid (bg {r['bg']})")
        elif force in ("frost", "soft") and method == "solid":
            method = "blur"; flags.append("forced_method")
            panel_luma = r["band_luma"] * (1 - abs(frost)) + (255 * frost if frost > 0 else 0)
            r["text_color"], r["stroke"] = ((28, 28, 30), 0) if (style == "frost" and panel_luma > 140) else ((255, 255, 255), max(1, int(H * 0.0012)))
            log.append(f"range {a}-{b}: method forced to {style}")
        rt = render_text(text, W, H, r, font_path)
        if rt is None:
            rejected.append(dict(region=region, a=a, b=b, reason="could not fit the text into the band")); continue
        ov, size, nlines = rt
        y0, y1, x0, x1 = r["y0"], r["y1"], r["x0"], r["x1"]
        enable = f"between(n\\,{a}\\,{b})"
        ov_path = os.path.join(tmp, f"text{ri}.png"); ov.save(ov_path)
        inputs += ["-i", ov_path]; ov_idx = nxt; nxt += 1
        sig = None
        if method == "solid":
            hexbg = "0x%02x%02x%02x" % tuple(r["bg"])
            sx0, sx1 = r["sx0"], r["sx1"]
            stages.append(f"{cur}drawbox=x={sx0}:y={y0}:w={sx1 - sx0 + 1}:h={y1 - y0 + 1}:color={hexbg}:t=fill:"
                          f"enable='{enable}'[v{vi + 1}]")
        elif style == "frost":
            sig = blur_sigma if blur_sigma is not None else round(H * 0.0016, 1)
            med_r = int(np.clip(H * 0.004, 7, 14))
            bx0 = max(0, x0 - int(W * 0.012)); bx1 = min(W - 1, x1 + int(W * 0.012))
            radius = int(W * 0.025)
            if region == "bottom":
                by0 = y0 - (y0 % 2); by1 = min(H - 1, y1 + 2); sh = H - by0
                box = (bx0, 0, bx1, by1 - by0 + radius)
            else:
                by0 = 0; by1 = min(H - 1, y1 + 2); by1 += (by1 + 1) % 2; sh = by1 + 1
                box = (bx0, max(0, y0 - 2) - radius, bx1, by1)
            mask = Image.new("L", (W, sh), 0)
            ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)
            mask_path = os.path.join(tmp, f"mask{ri}.png"); mask.save(mask_path)
            inputs += ["-i", mask_path]; mk_idx = nxt; nxt += 1
            k = 1 - abs(frost); off = 255 * frost if frost > 0 else 0
            lut = (f"lutrgb=r='val*{k:.3f}+{off:.1f}':g='val*{k:.3f}+{off:.1f}'"
                   f":b='val*{k:.3f}+{off:.1f}'")
            stages.append(
                f"{cur}split[a{ri}][b{ri}];"
                f"[b{ri}]crop={W}:{sh}:0:{by0},median=radius={med_r},median=radius={med_r},"
                f"gblur=sigma={sig}:steps=2,format=rgb24,{lut}[bl{ri}];"
                f"[bl{ri}][{mk_idx}:v]alphamerge[blm{ri}];"
                f"[a{ri}][blm{ri}]overlay=0:{by0}:enable='{enable}'[v{vi + 1}]")
        else:
            sig = blur_sigma if blur_sigma is not None else float(np.clip((y1 - y0 + 1) / 10, 25, 35))
            feather = max(4, int(H * 0.003))
            mask = Image.new("L", (W, H), 0)
            rect = ((-100, y0 - 2 * feather, W + 100, H + 100) if region == "bottom"
                    else (-100, -100, W + 100, y1 + 2 * feather))
            ImageDraw.Draw(mask).rectangle(rect, fill=255)
            mask = mask.filter(ImageFilter.GaussianBlur(feather))
            mask_path = os.path.join(tmp, f"mask{ri}.png"); mask.save(mask_path)
            inputs += ["-i", mask_path]; mk_idx = nxt; nxt += 1
            stages.append(
                f"{cur}split[a{ri}][b{ri}];[b{ri}]gblur=sigma={sig}:steps=2[bl{ri}];"
                f"[bl{ri}][{mk_idx}:v]alphamerge[blm{ri}];"
                f"[a{ri}][blm{ri}]overlay=0:0:enable='{enable}'[v{vi + 1}]")
        vi += 1; cur = f"[v{vi}]"
        stages.append(f"{cur}[{ov_idx}:v]overlay=0:0:enable='{enable}'[v{vi + 1}]")
        vi += 1; cur = f"[v{vi}]"
        shown = method if method == "solid" else style
        if len(set(r["methods"])) > 1: flags.append("samples_disagree")
        if r["card"]: flags.append("card_solid")
        if region == "top": flags.append("top_region")
        accepted.append(dict(region=region, a=a, b=b, band=[y0, y1], x=[x0, x1], method=shown,
                             sigma=sig, font_px=size, lines=nlines, samples=r["methods"],
                             card=r["card"], bg=[int(v) for v in r["bg"]]))
        log.append(f"range {region} {a}-{b}: band y{y0}-{y1} {shown}"
                   + (f" sigma={sig:g}" if sig else "") + f" font={size}px lines={nlines}; samples {r['methods']}")
    for rj in rejected:
        log.append(f"range {rj['region']} {rj['a']}-{rj['b']}: {rj['reason']}, left untouched")
    if not stages:
        raise ValueError("every detected text range was rejected; nothing to replace")
    if len(accepted) > 1: flags.append("multiple_ranges")
    fc = ";".join(stages) + f";{cur}format=yuv420p"
    if os.path.abspath(out_path) == os.path.abspath(path):
        raise ValueError("output path equals the source path")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    cmd = ["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", fc, "-c:v", "libx264", "-preset", "slow",
           "-crf", "17", "-r", f"{fps:g}", "-c:a", "copy", "-movflags", "+faststart", out_path]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError("ffmpeg failed: " + (p.stderr or "").strip()[-800:])
    return dict(kind="video", W=W, H=H, fps=fps, frames=nframes, ranges=accepted, rejected=rejected,
                flags=sorted(set(flags)), log=log, out_path=out_path,
                method=accepted[0]["method"] if accepted else None)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--text-file", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--method", default="auto", choices=["auto", "solid", "frost", "soft"])
    ap.add_argument("--frost", type=float, default=-0.15)
    ap.add_argument("--blur-sigma", type=float, default=None)
    a = ap.parse_args()
    text = open(a.text_file, encoding="utf-8").read().strip()
    try:
        r = run_video(a.video, text, a.out, {"method": a.method, "frost": a.frost, "blur_sigma": a.blur_sigma})
        print("\n".join(r["log"]))
    except Exception as e:
        print(f"ERROR {e}", file=sys.stderr); sys.exit(1)
