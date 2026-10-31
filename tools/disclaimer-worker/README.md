# Scale Cases Helper (local disclaimer worker + creative library)

Powers the **Disclaimers** tab (`127.0.0.1:43128`) and the **local creative library** that Ads
Tracking and Relaunch read (`127.0.0.1:43127`, `library_helper.py`, a port of the old Node helper).
It runs on each person's own computer because the ads live in Google Drive for desktop and the
rendering needs ffmpeg. Nothing is uploaded anywhere; the browser talks to the helper directly.

## Install or update (Mac and Windows, anyone)

Download the setup from the site (the Disclaimers tab and the creative library show the links
when the helper is not running), or:

- **Mac:** `client/public/setup/ScaleCases-Setup-Mac.zip` → unzip → double-click
  "Scale Cases Setup". Or in Terminal:
  `/bin/bash -c "$(curl -fsSL https://scalecases-client.onrender.com/setup/mac.sh)"`
  Installs Homebrew (asks for the Mac password once), Python 3.12, ffmpeg, the helper in
  `~/Library/Application Support/ScaleCasesHelper`, and a launchd agent `com.scalecases.helper`
  (logs in `~/Library/Logs/ScaleCasesHelper`).
- **Windows:** `client/public/setup/ScaleCases-Setup-Windows.cmd` → double-click. Installs
  Python 3.12 and ffmpeg with winget (per user, no admin), the helper in
  `%LOCALAPPDATA%\ScaleCasesHelper`, and a hidden `Scale Cases Helper` startup shortcut.

Both download the code from this repository's `main` branch, replace the older separate installs
(`com.scalecases.disclaimer-worker`, `com.scalecases.creative-library`, the Node helper and their
startup shortcuts), start the helper and print a checklist. Running setup again updates it.
`tools/setup/make-mac-zip.sh` rebuilds the Mac zip after editing `Scale Cases Setup.command`.

For development: `python tools/disclaimer-worker/worker.py` (set `SC_LIBRARY_PORT=0` to skip the
creative library).

Requires Python 3.11+ with `numpy`, `pillow`, `fastapi`, `uvicorn` and `ffmpeg` + `ffprobe` on
PATH. Text is set in Segoe UI on Windows and in the bundled Selawik (`fonts/`, an open-licensed
font with Segoe UI's metrics) everywhere else, so outputs from either machine look the same.

Everything the tab shows — the disclaimer library with versions, settings, output history,
jobs, the drag-and-drop inbox, staged renders awaiting review and review previews — lives in
the **shared folder `ScaleCases/Disclaimers`** in Google Drive, so everyone sees the same thing.
The helper looks for it in every Shared Drive first, then My Drive, and follows it if it moves
(e.g. from My Drive into a Shared Drive). The creative library is the newest `20xx B2C` folder
next to it (override with `creative_root` in `local.json`).

**Several people at once:** each computer writes only its own files,
`ScaleCases/Disclaimers/sync/<store>/<machine id>.json`, with the latest copy of every record it
changed (stamped `_u`) and tombstones for deletions. Reading merges all computers' files plus
the older single files (`disclaimers.json`, `jobs.json`, …, dated by their modification time):
the newest copy of each record wins, and for jobs each item separately, so two people reviewing
different items of one job never overwrite each other and Drive never makes conflict copies.
Every computer must run version 4 or later; older workers only read the single files and will
not see changes made by newer ones. The only machine-local file is `local.json` (this machine's
library root) in `%LOCALAPPDATA%\ScaleCasesDisclaimers` (Windows) or
`~/Library/Application Support/ScaleCasesDisclaimers` (macOS); override that folder with the
`SC_DISCLAIMER_DATA` environment variable. When Drive is not available the worker falls back to
that local folder and moves the data into the shared folder the first time it appears.

## Working from two machines

The ad library is the Google Drive folder `My Drive/2026 B2C`, mirrored by Google Drive for
desktop on each machine (Windows: `G:\My Drive\…`; macOS:
`~/Library/CloudStorage/GoogleDrive-<account>/My Drive/…`). In Settings, set **Library root**
to that machine's `My Drive` path (the worker guesses it). Paths under the root are stored as
`{root}/…` and paths inside the shared data folder as `{data}/…`, so every record works on
both machines.

How the sync behaves:
- Each worker re-reads a data file whenever Drive has changed it (checked on every request),
  so a disclaimer added on the PC shows up on the Mac on the next refresh, and a job rendered
  on one machine can be reviewed, approved, rejected or re-rendered on the other.
- Items remember which machine rendered them; a worker restart only marks its own in-flight
  items as stale.
- Approving on the other machine needs the staged render to have synced; until then the tab
  says so and you can wait or re-render locally.
- **Export library** / **Import library** in Settings remain as a backup / restore.

Testing knobs: `SC_DISCLAIMER_PORT` and `SC_DISCLAIMER_MACHINE` let two workers run on one
machine against the same shared folder.

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
