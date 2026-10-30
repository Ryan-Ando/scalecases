# Local disclaimer worker

Powers the **Disclaimers** tab. It runs only on this computer (`127.0.0.1:43128`) because the
ads live on a local drive and the rendering needs ffmpeg. Nothing is uploaded anywhere; the
browser talks to the worker directly and the worker reads and writes the folders you choose.

## Run

Windows:

```powershell
python tools/disclaimer-worker/worker.py
# or install it to start hidden at sign-in:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/disclaimer-worker/install.ps1
```

macOS (Python 3 and Homebrew ffmpeg required: `brew install python ffmpeg`):

```bash
bash tools/disclaimer-worker/install.sh     # installs deps, registers a launchd agent, starts it
# or run it in a terminal:
python3 tools/disclaimer-worker/worker.py
```

Requires Python 3.11+ with `numpy`, `pillow`, `fastapi`, `uvicorn` and `ffmpeg` + `ffprobe` on
PATH. Text is set in Segoe UI on Windows and in the bundled Selawik (`fonts/`, an open-licensed
font with Segoe UI's metrics) everywhere else, so outputs from either machine look the same.

Data lives in `%LOCALAPPDATA%\ScaleCasesDisclaimers` (Windows) or
`~/Library/Application Support/ScaleCasesDisclaimers` (macOS); override with the
`SC_DISCLAIMER_DATA` environment variable. It holds the disclaimer library with versions,
settings, output history, recent jobs, the drag-and-drop inbox, staged renders awaiting review,
and review previews.

## Working from two machines

The ad library is the Google Drive folder `My Drive/2026 B2C`, mirrored by Google Drive for
desktop on each machine (Windows: `G:\My Drive\…`; macOS:
`~/Library/CloudStorage/GoogleDrive-<account>/My Drive/…`). In Settings, set **Library root**
to that machine's `My Drive` path (the worker guesses it). Destinations and history entries
under the root are stored as `{root}/…`, so a library exported from one machine imports on the
other with working destinations. Use **Export library** / **Import library** in Settings to
carry the disclaimers and tags across; job history stays per machine.

## What it does

- **Library**: named disclaimers; editing the text creates a new version.
- **Jobs**: each source file × each destination renders to a staging folder, then waits for review.
  Approving moves it to `<destination>\<out folder>\<mmdd>\<name>`. Rejecting deletes it.
- **Naming**: if the source name already ends with one of the state tags in Settings, the output
  keeps the name. Otherwise ` - <disclaimer name>` is appended before the extension.
- **Destinations**: each disclaimer can carry a default destination folder; picking the disclaimer
  fills it in, and it can still be changed per job.
- **Drag and drop**: files dropped on the Process panel are copied to the worker inbox
  (`%LOCALAPPDATA%\ScaleCasesDisclaimers\inbox`) because browsers never reveal a dropped file's
  path. The copy is the source for rendering, history and regeneration; the original is untouched.
- **Missing opening disclaimer**: if no disclaimer is on screen during the first 5 seconds of a
  video, a fresh frosted panel with the new text is added there (flag `inserted_opening`). Any
  disclaimer found later in the video, such as one over the last 5 seconds, is replaced as usual.
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
