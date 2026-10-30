# Scale Cases — working notes for Claude Code

Ad-intelligence dashboard for Cypress Media Group's personal-injury lead-gen business.
Express server (`server/`, port 3001) + React 19/Vite client (`client/`), deployed on Render
(`scalecases-server.onrender.com` + static client at `scalecases-client.onrender.com`).
No database: Google Sheets + JSON files under `DATA_DIR` + in-memory caches + browser storage.
Repo: github.com/Ryan-Ando/scalecases. Standing permission: commit and `git push` to main without asking.

## Tabs that render (App.jsx)
Ads Tracking, Spend Sheet, Relaunch, Disclaimers. Other tab components exist in the repo but are hidden.
Tabs stay mounted; the active tab persists in localStorage.

## Hard-won facts (do not relearn)
- **Leads**: only `/next-steps` thank-you-page visits in Hyros are real leads. Never use the
  `!qualified-lead` tag. The Hyros backfill/sync workflow and its daily cron were retired 2026-07-04.
- **Facebook counts**: campaign results are per-state custom conversions; count the indicator-named
  action exactly. Use range-aggregated insights with unified attribution and impression-time
  reporting to match Ads Manager. Never sum daily rows.
- **Naming convention is load-bearing**: brand token (HALO/BULKTIDE/default LSS) and the last
  state-code token in a campaign name drive attribution everywhere.
- **Ads Tracking side effect**: loading that tab writes to the Google Sheet and tags GHL contacts.
- **No auth**: every server endpoint is open to anyone with the URL. Flag this before adding
  anything sensitive or exposing a new service beyond loopback.
- Spend-sheet push and the digest are manual-only (no schedules).

## Shared browser state (server/routes/state.js + client/src/sync.js)
Budgets/pacing, column layouts, merge groups, deleted ads, KPI settings and the accumulated
FB / GHL / sheet data in IndexedDB are mirrored to the server's record-sync store
(`DATA_DIR/state/<store>.json`, per-record `_rev`, tombstones, store `epoch` for clears) so every
device shows the same thing. `initialSync()` runs before tabs mount; local writes go through
db.js hooks / `lsSet` and are pushed in batches; a 60 s poll applies other devices' changes and
shows a reload badge. Work on one device at a time; last write wins per record.
**DATA_DIR must be a Render persistent disk** (render.yaml mounts `/var/data`), or all of this plus
leads.json, fb-cache and snapshots vanish on each deploy.

## Disclaimers tab + local worker (tools/disclaimer-worker)
Replaces burned-in disclaimers on image/video ads. The browser talks to a FastAPI worker on
`127.0.0.1:43128` on the user's own machine (origin allowlist: Render client + Vite dev). Render
plays no part; the ads live on the user's disk and rendering needs ffmpeg.
- Start: `python tools/disclaimer-worker/worker.py` (Windows: `install.ps1`; macOS: `install.sh`
  registers a launchd agent). All worker data (library, settings, history, jobs, staging,
  previews, inbox) lives in the SHARED Drive folder `My Drive/ScaleCases/Disclaimers` and syncs
  between the PC and the Mac; workers re-read files Drive changed on every request. Only
  `local.json` (library root) is per machine: `%LOCALAPPDATA%\ScaleCasesDisclaimers` on Windows,
  `~/Library/Application Support/ScaleCasesDisclaimers` on macOS (override with `SC_DISCLAIMER_DATA`).
  Paths are stored as `{root}/…` (library) or `{data}/…` (shared data folder).
- Ad library: Google Drive, folder `My Drive/2026 B2C` (per-state folders `CA`, `CO`; outputs go to
  `<state>/new disclaimer/<mmdd>/`). Windows path `G:\My Drive\2026 B2C`; macOS
  `~/Library/CloudStorage/GoogleDrive-<account>/My Drive/2026 B2C`. In the worker this is the
  **library root**; saved destinations use the `{root}` placeholder so the library is portable.
- User rules: the disclaimer is always chosen manually; each disclaimer carries a default destination.
  Output keeps the source filename when its tail carries a state tag (settings.tags), otherwise
  ` - <disclaimer name>` is appended. Nothing is written until approved in Review.
- Detection rules were tuned over ~35 real ads (solid → rowfill → median erase → frosted panel for
  images; per-range top/bottom detection, caption rejection, solid-card fill, frosted box =
  2× median erase + light blur + −15% tint for video; opening disclaimer inserted when none is
  visible in the first 5 s). Before changing them, re-run the byte-identical regression against
  the approved outputs in `CA/new disclaimer` (see README there).
- Fonts: Segoe UI on Windows; bundled Selawik (same metrics, OFL) elsewhere.
