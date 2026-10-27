"""Replace the burned-in disclaimer at the bottom of an image ad.

Hiding method is chosen per image (or forced through opts["method"]):
  solid   - background behind the old text is one flat colour -> fill with that colour
  rowfill - background varies only vertically (gradient / bands) -> fill each row with its own colour
  median  - two median passes erase thin text strokes but keep larger structure (UI edges, photo)
  frost   - hard-edged frosted panel, last resort

Library use:   run_image(src, text, out_path, opts) -> result dict
CLI use:       python disclaimer_image.py "ad.png" --text-file t.txt --out "out.png"
"""
import argparse, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

FONT_REG = r"C:\Windows\Fonts\segoeui.ttf"
FONT_BOLD = r"C:\Windows\Fonts\segoeuib.ttf"
FONT_PATH = FONT_REG
FROST_WHITE = 0.45   # how much the blurred panel is lightened toward white (0 = plain blur)


def find_disclaimer_band(gray, search_frac=0.30, gap=34, min_trans=12, absorb_short_tail=False):
    """Return (y0, y1) of the bottom-most tight cluster of text-like rows, or None."""
    H, W = gray.shape
    top = int(H * (1 - search_frac))
    g = gray[top:, :].astype(int)
    # thin-stroke map: pixels that disappear under a 5-px horizontal min (bright strokes)
    # or max (dark strokes) filter. Small text is made of these; photo texture and big
    # headline glyphs mostly are not.
    k = 5; p = k // 2
    gp = np.pad(g, ((0, 0), (p, p)), mode="edge")
    win = np.lib.stride_tricks.sliding_window_view(gp, k, axis=1)
    mn, mx = win.min(axis=2), win.max(axis=2)
    thin = ((g > 170) & (g - mn > 90)) | ((g < 90) & (mx - g > 90))
    sc = thin.sum(axis=1)
    thr = max(min_trans, int(W * 0.012))
    rows = np.where(sc >= thr)[0]
    if len(rows) == 0:
        return None
    runs, s = [], rows[0]
    for a, b in zip(rows[:-1], rows[1:]):
        if b - a > 1:
            runs.append((s, a)); s = b
    runs.append((s, rows[-1]))
    # seed = bottom-most run that is clearly dense small text (ignore 1-2 row specks)
    seed = None
    for a, b in runs[::-1]:
        if b - a + 1 >= 4 and sc[a:b + 1].mean() >= 3 * thr:
            seed = (a, b); break
    if seed is None:
        return None
    y0, y1 = seed
    L0 = y1 - y0 + 1          # glyph-body height of one disclaimer line
    S = np.percentile(sc[y0:y1 + 1], 75)
    # climb upward row by row: a row belongs to the disclaimer if it is at least 55% as dense
    # as the disclaimer itself. Captions, photo texture and box edges score far lower.
    dense = sc >= max(thr, 0.55 * S)
    r = y0 - 1; last_dense = y0
    while r >= 0 and last_dense - r <= gap:
        if dense[r]:
            last_dense = r; y0 = r
        r -= 1
    # absorb one trailing short line (the short centred last line of the paragraph). Only wanted
    # when the climb ends at the paragraph's LAST line, i.e. the image was flipped to find a
    # top-of-frame disclaimer; at the bottom of a frame the nearest sparse run above is UI.
    above = [(a, b) for a, b in runs if b < y0 and y0 - b - 1 <= gap] if absorb_short_tail else []
    if above:
        a, b = max(above, key=lambda r: r[1])
        if (b - a + 1) <= 1.6 * L0 and sc[a:b + 1].mean() >= thr:
            y0 = a
    # include sparse rows glued to the top of the block (ascender tops of the first line)
    n = 0
    while y0 - 1 >= 0 and sc[y0 - 1] >= thr and n < 15:
        y0 -= 1; n += 1
    return top + y0, top + y1


def color_dist(arr, c):
    return np.sqrt(((arr.astype(int) - np.array(c, dtype=int)) ** 2).sum(axis=-1))


def analyze(rgb, y0, y1):
    band = rgb[y0:y1 + 1]
    H, W, _ = band.shape
    flat = band.reshape(-1, 3)
    q = (flat // 16).astype(np.int32)
    keys = q[:, 0] * 256 + q[:, 1] * 16 + q[:, 2]
    mode_key = np.bincount(keys).argmax()
    near = flat[keys == mode_key]
    bg = tuple(int(v) for v in np.median(near, axis=0))
    d = color_dist(band, bg)
    fd = color_dist(flat, bg)
    far = flat[fd > 90]
    if len(far) > 50:
        far_d = fd[fd > 90]
        core = far[far_d >= np.percentile(far_d, 75)]
        text_color = tuple(int(v) for v in np.median(core, axis=0))
    else:
        text_color = (255, 255, 255) if sum(bg) < 384 else (0, 0, 0)
    cols = np.where((d > 90).any(axis=0))[0]
    x0, x1 = (int(cols[0]), int(cols[-1])) if len(cols) else (0, W - 1)

    # Solid test: erase thin text strokes with a min-filter on the distance-from-bg map.
    K = 9
    dist_img = Image.fromarray(np.clip(d, 0, 255).astype(np.uint8))
    residual = np.array(dist_img.filter(ImageFilter.MinFilter(K)))
    bad_rows = np.where(residual.max(axis=1) > 40)[0]

    if len(bad_rows) == 0:
        method = "solid"
    elif bad_rows[-1] < max(8, int(H * 0.30)) and np.all(np.diff(bad_rows) == 1):
        method = "solid"      # only a thin photo edge at the top of the band: fill anyway
    else:
        ok = True
        row_fill = np.zeros((H, 3), dtype=np.uint8)
        for i in range(H):
            row = band[i]
            med = np.median(row, axis=0)
            rd = color_dist(row, med)
            padded = np.pad(rd, K // 2, mode="edge")
            res = np.lib.stride_tricks.sliding_window_view(padded, K).min(axis=1)
            if res.max() > 40 or (rd < 28).mean() < 0.40:
                ok = False
                break
            row_fill[i] = np.median(row[rd < 28], axis=0)
        method = "rowfill" if ok else "blur"
        if ok:
            return method, bg, text_color, (x0, x1), row_fill
    return method, bg, text_color, (x0, x1), None


def wrap_fit(text, font_path, max_w, max_h, lo=10, hi=80):
    best = None
    for size in range(lo, hi):
        f = ImageFont.truetype(font_path, size)
        words, lines, cur = text.split(), [], ""
        for w in words:
            t = (cur + " " + w).strip()
            if f.getlength(t) <= max_w:
                cur = t
            else:
                lines.append(cur); cur = w
        lines.append(cur)
        lh = int(size * 1.18)
        if lh * len(lines) <= max_h and all(f.getlength(l) <= max_w for l in lines):
            best = (size, f, lines, lh)
        else:
            break
    return best


def thin_stroke_count(gray_band):
    g = gray_band.astype(int); k = 5; p = k // 2
    gp = np.pad(g, ((0, 0), (p, p)), mode="edge")
    win = np.lib.stride_tricks.sliding_window_view(gp, k, axis=1)
    mn, mx = win.min(axis=2), win.max(axis=2)
    return int((((g > 170) & (g - mn > 90)) | ((g < 90) & (mx - g > 90))).sum())


def median_erase(im, y0, y1, H, max_residual=0.03):
    """Erase thin text in rows y0..y1 with two median passes. Returns new image or None if
    too much text-like structure survives or the erased band mixes light and dark areas."""
    W = im.size[0]
    r = int(np.clip(H * 0.004, 5, 14)); size = 2 * r + 1
    ctx = r + 2
    top = max(0, y0 - ctx); bot = min(H - 1, y1 + ctx)
    strip = im.crop((0, top, W, bot + 1))
    before = thin_stroke_count(np.array(strip.convert("L"))[y0 - top:y1 - top + 1])
    if before == 0:
        return None
    for _ in range(2):
        strip = strip.filter(ImageFilter.MedianFilter(size))
    after = thin_stroke_count(np.array(strip.convert("L"))[y0 - top:y1 - top + 1])
    if after > max_residual * before:
        return None
    lum = np.array(strip.convert("L"))[y0 - top:y1 - top + 1]
    col = lum.mean(axis=0)
    light = col > 140; dark = col < 100
    if light.sum() > 0.03 * W and dark.sum() > 0.03 * W:
        return None
    out = im.copy()
    out.paste(strip.crop((0, y0 - top, W, y1 - top + 1)), (0, y0))
    return out


def run_image(path, text, out_path, opts=None):
    """Process one image. Returns a result dict; raises ValueError when nothing can be done."""
    opts = opts or {}
    force = opts.get("method", "auto") or "auto"        # auto | solid | median | frost
    band_scale = float(opts.get("band_scale", 1.0) or 1.0)
    font_path = FONT_BOLD if opts.get("bold") else FONT_REG
    frost_white = float(opts.get("frost_white", FROST_WHITE))
    log, flags = [], []

    im = Image.open(path).convert("RGB")
    rgb = np.array(im)
    gray = np.array(im.convert("L"))
    H, W = gray.shape
    band = find_disclaimer_band(gray)
    if band is None:
        raise ValueError("no disclaimer text found near the bottom of the image")
    y0, y1 = band
    pad = max(4, int(H * 0.004))
    y0 = max(0, y0 - pad); y1 = min(H - 1, y1 + pad)
    if band_scale != 1.0:
        y0 = max(0, y1 - int((y1 - y0) * band_scale))
        flags.append("band_scaled")
    method, bg, text_color, (x0, x1), row_fill = analyze(rgb, y0, y1)
    log.append(f"band y{y0}-{y1}, text x{x0}-{x1}, detected method={method}, bg={bg}")
    if force != "auto" and force != method:
        flags.append("forced_method")
        log.append(f"method forced to {force}")
        method = force if force != "median" else "blur"   # median is tried on the blur path
        if force == "frost":
            method = "frost_only"

    out = im.copy()
    stroke = 0
    if method == "solid":
        ImageDraw.Draw(out).rectangle((0, y0, W - 1, y1), fill=bg)
    elif method == "rowfill":
        arr = np.array(out)
        arr[y0:y1 + 1, :, :] = row_fill[:, None, :]
        out = Image.fromarray(arr)
    else:
        med = None if method == "frost_only" else median_erase(out, y0, y1, H)
        if med is not None:
            out = med
            method = "median"
            panel_luma = np.array(out.convert("L"))[y0:y1 + 1].mean()
            text_color, stroke = ((28, 28, 30), 0) if panel_luma > 140 else ((255, 255, 255), max(1, int(H * 0.0012)))
        else:
            if force == "median":
                flags.append("median_failed"); log.append("median erase could not clear the text; using frost")
            method = "frost"
            blurred = out.filter(ImageFilter.GaussianBlur(max(6, int(H * 0.012))))
            tint = (255, 255, 255) if frost_white >= 0 else (0, 0, 0)
            frost = Image.blend(blurred, Image.new("RGB", (W, H), tint), abs(frost_white))
            mask = Image.new("L", (W, H), 0)
            ImageDraw.Draw(mask).rectangle((0, y0, W - 1, H - 1), fill=255)
            out = Image.composite(frost, out, mask)
            panel_luma = np.array(frost.convert("L"))[y0:y1 + 1].mean()
            text_color, stroke = ((28, 28, 30), 0) if panel_luma > 140 else ((255, 255, 255), max(1, int(H * 0.0012)))

    margin = int(W * 0.015)
    tx0, tx1 = max(margin, x0), min(W - margin, x1)
    max_w, max_h = tx1 - tx0, (y1 - y0 + 1) - 2 * pad
    fit = wrap_fit(text, font_path, max_w, max_h)
    if fit is None:
        raise ValueError("could not fit the disclaimer text into the old text's footprint")
    size, font, lines, lh = fit
    d = ImageDraw.Draw(out)
    y = y0 + pad + (max_h - lh * len(lines)) // 2
    cx = (tx0 + tx1) / 2
    for ln in lines:
        kw = dict(stroke_width=stroke, stroke_fill=(0, 0, 0)) if stroke else {}
        d.text((cx - font.getlength(ln) / 2, y), ln, font=font, fill=text_color, **kw)
        y += lh
    if os.path.abspath(out_path) == os.path.abspath(path):
        raise ValueError("output path equals the source path")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    out.save(out_path)
    log.append(f"method={method} font={size}px lines={len(lines)} text_colour={text_color}")
    return dict(kind="image", W=W, H=H, method=method, band=[int(y0), int(y1)], x=[int(x0), int(x1)],
                bg=[int(v) for v in bg], text_color=[int(v) for v in text_color], font_px=size,
                lines=len(lines), flags=flags, log=log, out_path=out_path,
                ranges=[dict(region="bottom", band=[int(y0), int(y1)], method=method)])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--text-file", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--method", default="auto", choices=["auto", "solid", "median", "frost"])
    a = ap.parse_args()
    text = open(a.text_file, encoding="utf-8").read().strip()
    try:
        r = run_image(a.image, text, a.out, {"method": a.method})
        print("\n".join(r["log"]))
    except Exception as e:
        print(f"ERROR {e}", file=sys.stderr); sys.exit(1)
