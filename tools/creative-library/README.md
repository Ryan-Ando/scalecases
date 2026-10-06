# Local creative library

The Windows helper serves the creative inventory to the Scale Cases browser on this
computer at `127.0.0.1:43127`. It never sends files or filenames to an external
server. It reads directory entries once per minute, skips symbolic links, and
does not hash or decode media. Optional image/video previews are fetched directly
from the local helper by the browser; video is not preloaded.

Install (Node.js required):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/creative-library/install.ps1 -LibraryRoot "C:\path\2026 B2C"
```

Installation writes only to `%LOCALAPPDATA%\ScaleCasesCreativeLibrary` and a
`Scale Cases Creative Library.lnk` shortcut in the current user's Startup folder.
The library directory is read-only. The helper runs hidden, without administrator
privileges. Its port is bound only to loopback, with an exact origin allowlist.
The website has no endpoint for uploading creatives.

Open Ads Tracking or Relaunch on this computer and allow the site's local-network
permission in Chrome/Edge. Use **Connect / Refresh** to retry. Other computers
cannot access this library. The helper rescans once per minute; an open visible
page refreshes once per minute. Allow up to two minutes for a new file to appear.
**Local previews** is off by default. Clearing browser storage removes saved
Facebook matches and requires another inventory check.

To disable startup, delete that named shortcut from `shell:startup`. To stop the
running helper, identify its Node process by the command pointing to
`ScaleCasesCreativeLibrary/helper.mjs` and end only that process.

## Matching and recommendations

- Manual ad combinations take priority. State-only naming markers, capitalization,
  and known media extensions are normalized. Creative numbers, format suffixes,
  copy/version names, and client-specific suffixes are preserved.
- A file found in any connected Facebook account (including inactive ads and
  saved historical matches) is not recommended as untested. Permanently deleted
  ads unavailable from Meta cannot be conclusively detected by this integration.
- No new-ad suggestions are made with incomplete inventory or campaign insights.
- CPL is campaign spend divided by campaign results over the last 30 completed
  UTC days. Below $300 qualifies; exactly $300, above $300, zero leads, and missing
  data retain the existing proven-ad list. A qualifying campaign is named on each
  suggestion. State variants are grouped, and adaptation to another state is
  explicitly recommended rather than treated as an already-existing asset.
- Local creatives appear in the **Local creative library** section in both tabs.
  They are not fabricated as Facebook ad records or counted in historical spend.
  New recommendations are newest-first by original creative date (not a later
  state export date), followed by the unchanged proven recommendations.
