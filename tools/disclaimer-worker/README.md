# Local disclaimer worker

Powers the **Disclaimers** tab. It runs only on this computer (`127.0.0.1:43128`) because the
ads live on a local drive and the rendering needs ffmpeg. Nothing is uploaded anywhere; the
browser talks to the worker directly and the worker reads and writes the folders you choose.

## Run

```powershell
python tools/disclaimer-worker/worker.py
```

or install it to start hidden at sign-in:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/disclaimer-worker/install.ps1
```

Requires Python 3.11+ with `numpy`, `pillow`, `fastapi`, `uvicorn` (installed by `install.ps1`)
and `ffmpeg` + `ffprobe` on PATH (`winget install Gyan.FFmpeg`). Segoe UI fonts are used
(`C:\Windows\Fonts\segoeui.ttf` and `segoeuib.ttf`).

Data lives in `%LOCALAPPDATA%\ScaleCasesDisclaimers`: the disclaimer library with versions,
settings, output history, recent jobs, staged renders awaiting review, and review previews.

## What it does

- **Library**: named disclaimers; editing the text creates a new version.
- **Jobs**: each source file × each destination renders to a staging folder, then waits for review.
  Approving moves it to `<destination>\<out folder>\<mmdd>\<name>`. Rejecting deletes it.
- **Naming**: if the source name already ends with one of the state tags in Settings, the output
  keeps the name. Otherwise ` - <disclaimer name>` is appended before the extension.
- **Review previews**: before/after crops of the disclaimer band; for video also the last
  disclaimer frame and the first clean frame after it.
- **Flags** mark outputs worth a closer look: samples disagreed on method, more than one range,
  solid card, top-of-frame disclaimer, manual ranges, forced method, a range that could not be located.
- **Overrides** per file: method, frost tint, blur strength, band size, bold text, region, manual
  frame ranges. Re-render applies them to that file only.
- **History**: every approved output with the disclaimer version used; stale ones (older than the
  current text) can be regenerated in one click.
- **Sort by date**: moves every ad under a parent folder into `mmdd` subfolders from the filename
  prefix, with a dry run first. Name collisions are reported, never overwritten.

## Security notes

The worker binds to loopback only and accepts requests only from the Scale Cases site origins
(production and the Vite dev server). It can read and write any folder the Windows user can,
which is the point: you choose the destination in the tab. Do not expose the port.
