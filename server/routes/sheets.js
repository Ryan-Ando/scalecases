import { Router } from 'express';
import { google } from 'googleapis';
import { fetchDailyInsights } from './facebook.js';

const router = Router();

// ── Spend Sheet push (states-as-columns × days-as-rows layout) ─────────────

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

function extractState(campaignName) {
  if (!campaignName) return null;
  const tokens = campaignName.trim().split(/[-–—\s_/|]+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i].toUpperCase();
    if (US_STATES.has(t)) return t;
  }
  return null;
}

function extractBrand(campaignName) {
  if (!campaignName) return null;
  const tokens = campaignName.split(/[-–—\s_/|]+/);
  for (const t of tokens) {
    const u = t.toUpperCase();
    if (u === 'LSS')  return 'LSS';
    if (u === 'HALO') return 'Halo';
  }
  return null;
}

// Composite key matching the client — '<brand> <state>' when both present,
// just the state code when no brand is detectable.
function extractGroup(campaignName) {
  const state = extractState(campaignName);
  if (!state) return null;
  const brand = extractBrand(campaignName);
  return brand ? `${brand} ${state}` : state;
}

// Normalize a sheet header cell into the key our LSS-only grid uses (plain state code).
// Accepts 'GA' and 'LSS GA' (both → 'GA'). Rejects 'Halo GA' so push never overwrites
// a Halo column even if one exists in the sheet.
function parseHeaderCell(cell) {
  const s = String(cell || '').trim();
  if (!s) return null;
  const m = s.match(/^(LSS|Halo)\s+([A-Za-z]{2})$/i);
  if (m) {
    if (m[1].toUpperCase() === 'HALO') return null; // never write to Halo columns
    const state = m[2].toUpperCase();
    if (US_STATES.has(state)) return state;
  }
  const upper = s.toUpperCase();
  if (US_STATES.has(upper)) return upper;
  return null;
}

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

function defaultTabName(year, monthIndex) {
  // monthIndex is 0-based (0 = Jan). Format matches the user's "june 2026" style.
  return `${MONTHS[monthIndex]} ${year}`;
}

function colLetter(n) {
  // 1-based → A, B, ..., Z, AA, AB...
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Build day × state spend grid from daily campaign insights for the given month.
async function buildMonthGrid(year, monthIndex) {
  const ym = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const since = `${ym}-01`;
  const until = `${ym}-${String(daysInMonth).padStart(2, '0')}`;

  const rows = await fetchDailyInsights({
    level: 'campaign', start: since, end: until, full: true,
  });

  const grid = {};       // grid[day][state] = spend (LSS + unbranded only — Halo excluded)
  const stateSet = new Set();
  for (const r of rows) {
    if (!r.date_start?.startsWith(ym)) continue;
    // Sheet push is LSS-only: drop any Halo-branded campaign so its spend never
    // lands in the sheet, even when an unbranded campaign for the same state exists.
    if (extractBrand(r.campaign_name) === 'Halo') continue;
    const st = extractState(r.campaign_name);
    if (!st) continue;
    const day = parseInt(r.date_start.slice(8), 10);
    const spend = parseFloat(r.spend) || 0;
    if (!grid[day]) grid[day] = {};
    grid[day][st] = (grid[day][st] || 0) + spend;
    stateSet.add(st);
  }
  const states = [...stateSet].sort();
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  return { states, days, grid };
}

function spendSheetId() {
  return process.env.SPEND_SHEET_ID;
}

// Look up the tab name in the spreadsheet (case-insensitive). Throws if missing —
// monthly tabs are pre-formatted with headers and date rows; we should never
// silently auto-create one and then fail to find any cells to write into.
async function findTab(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = (meta.data.sheets || []).map(s => s.properties?.title || '');
  const hit = existing.find(t => t.toLowerCase() === tabName.toLowerCase());
  if (!hit) throw new Error(`Tab "${tabName}" not found. Existing tabs: ${existing.join(', ')}`);
  return hit;
}

// Try to extract a day-of-month (1-31) from a sheet cell.
// Cells in the date column might be "6/1/2026", "Jun 1", "2026-06-01", or just "1".
function parseDayFromCell(cell) {
  if (cell == null || cell === '') return null;
  const s = String(cell).trim();
  if (/^\d{1,2}$/.test(s)) {
    const n = parseInt(s, 10);
    return (n >= 1 && n <= 31) ? n : null;
  }
  // "M/D" or "M/D/YYYY" — pull the second number
  const slash = s.match(/^\d{1,2}\/(\d{1,2})(?:\/\d{2,4})?$/);
  if (slash) {
    const d = parseInt(slash[1], 10);
    if (d >= 1 && d <= 31) return d;
  }
  // "YYYY-MM-DD"
  const iso = s.match(/^\d{4}-\d{2}-(\d{2})$/);
  if (iso) {
    const d = parseInt(iso[1], 10);
    if (d >= 1 && d <= 31) return d;
  }
  // Fallback — let JS try
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    const d = parsed.getDate();
    if (d >= 1 && d <= 31) return d;
  }
  return null;
}

// Core push: discover the sheet's state columns + date rows, then write only
// the (state × day) intersections. Day labels and TOTAL columns/rows are never
// touched. States that don't already appear as a column header are skipped.
async function pushSpendToSheet({ year, monthIndex, tabName, preview = false }) {
  const spreadsheetId = spendSheetId();
  if (!spreadsheetId) throw new Error('SPEND_SHEET_ID not set');

  const auth   = await getAuthClient(true);
  const sheets = google.sheets({ version: 'v4', auth });

  const resolvedTab = await findTab(sheets, spreadsheetId, tabName || defaultTabName(year, monthIndex));

  // Read a generous rectangle covering header + date rows. AZ50 = up to 52 columns
  // and 50 rows; plenty for a 31-day month with state columns and a totals row.
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${resolvedTab}'!A1:AZ50`,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const rows = existing.data.values || [];

  // 1. Find the header row — first row containing ≥2 cells that parse as a state
  //    or brand-prefixed state (LSS GA, Halo GA, plain GA, etc.).
  let headerRowIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const hits = (rows[i] || []).filter(c => parseHeaderCell(c)).length;
    if (hits >= 2) { headerRowIdx = i; break; }
  }
  if (headerRowIdx === -1) {
    throw new Error(`No header row with state codes found in "${resolvedTab}".`);
  }

  // 2. Build colByState from the header row (0-based column index). Take ONLY the
  //    first contiguous block of state-code columns — any duplicate state block
  //    further right (totals strip, summary section) is ignored.
  const colByState = {};
  const headerCells = rows[headerRowIdx] || [];
  let runStarted = false;
  for (let c = 0; c < headerCells.length; c++) {
    const key = parseHeaderCell(headerCells[c]);
    if (key) {
      runStarted = true;
      if (colByState[key] == null) colByState[key] = c;
    } else if (runStarted) {
      break; // end of first state-code block — ignore any later blocks
    }
  }

  // 3. Build rowByDay by scanning rows BELOW the header for a day-parseable cell.
  //    Stops at the first row that has no day in any column (covers a TOTALS row).
  const rowByDay = {};
  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    let day = null;
    for (let c = 0; c < row.length; c++) {
      day = parseDayFromCell(row[c]);
      if (day) break;
    }
    if (!day) continue;
    if (!rowByDay[day]) rowByDay[day] = r;
  }
  if (Object.keys(rowByDay).length === 0) {
    throw new Error(`No date/day rows found below the header in "${resolvedTab}".`);
  }

  // 4. Build the FB grid and queue per-cell updates.
  const { states, days, grid } = await buildMonthGrid(year, monthIndex);

  // Today (ET) — if we're pushing the current month, skip today + future days so
  // an in-progress day doesn't get logged as a partial number.
  const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const [tY, tM, tD] = todayET.split('-').map(n => parseInt(n, 10));
  const isCurrentMonth = (tY === year) && (tM === monthIndex + 1);

  const updates = [];
  const skippedStates = new Set();
  // For every (state, day) the SHEET knows about, write FB spend (or '' if zero/missing).
  for (const st of Object.keys(colByState)) {
    const col = colByState[st];
    for (const day of Object.keys(rowByDay).map(Number)) {
      if (isCurrentMonth && day >= tD) continue; // skip today + future
      const row = rowByDay[day];
      const spend = grid[day]?.[st] || 0;
      updates.push({
        range: `'${resolvedTab}'!${colLetter(col + 1)}${row + 1}`,
        values: [[spend > 0 ? spend : '']],
      });
    }
  }
  // Track FB-known states that the sheet doesn't have a column for (just reporting, no write).
  for (const st of states) if (colByState[st] == null) skippedStates.add(st);

  // Sample of cells we'll write — useful for debugging when the sheet appears unchanged.
  const nonZero = updates.filter(u => {
    const v = u.values[0][0];
    return typeof v === 'number' && v > 0;
  });
  const sample = nonZero.slice(0, 5).map(u => `${u.range}=${u.values[0][0]}`);

  if (preview) {
    return {
      tab: resolvedTab, preview: true,
      colByState, rowByDay,
      statesMatched: Object.keys(colByState).length,
      daysMatched: Object.keys(rowByDay).length,
      proposedWrites: updates.length,
      nonZeroWrites: nonZero.length,
      sample,
      skippedStates: [...skippedStates],
    };
  }

  if (updates.length === 0) {
    return { tab: resolvedTab, updated: 0, skippedStates: [...skippedStates], note: 'no matching state×day cells' };
  }

  const apiRes = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED', // lets sheet currency/number formatting apply
      data: updates,
    },
  });

  return {
    tab: resolvedTab,
    updated: updates.length,
    nonZeroWrites: nonZero.length,
    totalUpdatedCells: apiRes.data?.totalUpdatedCells ?? null,
    statesMatched: Object.keys(colByState).length,
    daysMatched: Object.keys(rowByDay).length,
    skippedStates: [...skippedStates],
    sample,
    colByState,
    rowByDay,
  };
}

// GET /api/sheets/spend-tabs — list tabs in the spend spreadsheet
router.get('/spend-tabs', async (req, res) => {
  try {
    const spreadsheetId = spendSheetId();
    if (!spreadsheetId) return res.status(503).json({ error: 'SPEND_SHEET_ID not set' });
    const auth   = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });
    const meta   = await sheets.spreadsheets.get({ spreadsheetId });
    const tabs = (meta.data.sheets || []).map(s => s.properties?.title || '').filter(Boolean);
    res.json({ tabs });
  } catch (err) {
    console.error('spend-tabs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sheets/push-spend
// Body: { year, month (1-based), tabName?, preview? }
//   preview=true returns the discovered colByState/rowByDay + sample writes WITHOUT writing.
router.post('/push-spend', async (req, res) => {
  try {
    const { year, month, tabName, preview } = req.body || {};
    if (!year || !month) return res.status(400).json({ error: 'year and month (1-12) required' });
    const result = await pushSpendToSheet({
      year: parseInt(year, 10),
      monthIndex: parseInt(month, 10) - 1,
      tabName,
      preview: preview === true || preview === 'true',
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('push-spend error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Daily auto-push of the current month at ~06:15 ET. Same minute-tick pattern used by hyros.
let _lastSpendPushDate = '';
function runSpendPushSchedule() {
  if (!spendSheetId()) return; // skip silently if not configured
  const now = new Date();
  const fmt = (key, opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...opts }).format(now);
  const hh = parseInt(fmt('h', { hour: 'numeric', hour12: false }), 10);
  const mm = parseInt(fmt('m', { minute: 'numeric' }), 10);
  const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  if (hh === 6 && mm === 15 && todayET !== _lastSpendPushDate) {
    _lastSpendPushDate = todayET;
    const [y, m] = todayET.split('-').map(n => parseInt(n, 10));
    pushSpendToSheet({ year: y, monthIndex: m - 1 })
      .then(r => console.log(`[spend-push] daily push OK — ${r.tab}: ${r.updated} cells (${r.statesMatched} states × ${r.daysMatched} days)${r.skippedStates?.length ? ` · skipped: ${r.skippedStates.join(',')}` : ''}`))
      .catch(e => console.error('[spend-push] daily push failed:', e.message));
  }
}
setInterval(runSpendPushSchedule, 60 * 1000);

function getSheetConfig() {
  return {
    sheetId: process.env.SHEETS_ID,
    tabName: process.env.SHEETS_TAB_NAME || 'Sheet1',
    stateCol: process.env.SHEETS_STATE_COL || 'D',
  };
}

async function getAuthClient(write = false) {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [write
      ? 'https://www.googleapis.com/auth/spreadsheets'
      : 'https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return auth.getClient();
}

// GET /api/sheets/cases?start=ISO&end=ISO
// Reads A–J: name, phone, state (D), date (F), utmCampaign (G), utmMedium (H),
// utmContent (I), utmTerm (J). Returns rowIndex (1-based sheet row) with each case.
router.get('/cases', async (req, res) => {
  try {
    const { sheetId } = getSheetConfig();
    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const tabName = process.env.SHEETS_TAB_NAME || 'Sheet1';
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${tabName}!A2:J`,
    });

    const rows = response.data.values || [];

    const start = req.query.start ? new Date(req.query.start) : null;
    const end   = req.query.end   ? new Date(req.query.end)   : null;

    const cases = [];
    for (let i = 0; i < rows.length; i++) {
      const row   = rows[i];
      const name  = (row[0] || '').trim();
      const phone = (row[1] || '').trim();
      const date  = row[5] ? new Date(row[5]) : null;

      if (!phone) continue;

      if (start && date && date < start) continue;
      if (end   && date && date > end)   continue;

      const state = (row[3] || '').trim().toUpperCase();
      cases.push({
        rowIndex:   i + 2,
        name, phone, state,
        date:       date ? date.toISOString() : null,
        utmContent: (row[8] || '').trim(), // col I = ads
        utmTerm:    (row[9] || '').trim(), // col J = term
      });
    }

    res.json(cases);
  } catch (err) {
    console.error('Sheets cases error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sheets/enrich-utm
// Body: [{ rowIndex, utmCampaign, utmMedium, utmContent, utmTerm }]
// Writes UTM fields to columns G–J for the given rows in the master sheet.
// Returns { updated }.
router.post('/enrich-utm', async (req, res) => {
  try {
    const rows = req.body;
    if (!Array.isArray(rows) || rows.length === 0) return res.json({ updated: 0 });

    const sheetId = process.env.SHEETS_ID;
    const tabName = process.env.SHEETS_TAB_NAME || 'Sheet1';
    if (!sheetId) return res.status(503).json({ error: 'SHEETS_ID not set' });

    const auth   = await getAuthClient(true);
    const sheets = google.sheets({ version: 'v4', auth });

    const data = rows.flatMap(({ rowIndex, utmCampaign, utmAdset, utmContent, utmTerm, date, status }) => {
      const entries = [{
        range: `${tabName}!G${rowIndex}:J${rowIndex}`,
        values: [[utmCampaign || '', utmAdset || '', utmContent || '', utmTerm || '']],
      }];
      if (date)   entries.push({ range: `${tabName}!F${rowIndex}`, values: [[date]] });
      if (status) entries.push({ range: `${tabName}!E${rowIndex}`, values: [[status]] });
      return entries;
    });

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    });

    res.json({ updated: rows.length });
  } catch (err) {
    console.error('Sheets enrich-utm error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sheets/mark-status
// Body: [{ rowIndex, status }] — writes status string to col E
router.post('/mark-status', async (req, res) => {
  try {
    const rows = req.body;
    if (!Array.isArray(rows) || rows.length === 0) return res.json({ updated: 0 });
    const sheetId = process.env.SHEETS_ID;
    const tabName = process.env.SHEETS_TAB_NAME || 'Sheet1';
    if (!sheetId) return res.status(503).json({ error: 'SHEETS_ID not set' });
    const auth   = await getAuthClient(true);
    const sheets = google.sheets({ version: 'v4', auth });
    const data = rows.map(({ rowIndex, status }) => ({
      range: `${tabName}!E${rowIndex}`,
      values: [[status || '']],
    }));
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data },
    });
    res.json({ updated: rows.length });
  } catch (err) {
    console.error('Sheets mark-status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sheets/config
router.get('/config', (_req, res) => {
  const { tabName, stateCol } = getSheetConfig();
  res.json({ tabName, stateCol });
});

// GET /api/sheets/lead-audit
// Reads the lead audit sheet (LEAD_AUDIT_SHEET_ID + LEAD_AUDIT_GID env vars).
// Auto-detects state and utm_content columns from headers.
// Returns actual lead counts grouped by { state, utmContent, actualLeads }
// plus unmatched count (rows with no utm_content).
router.get('/lead-audit', async (req, res) => {
  try {
    const sheetId = process.env.LEAD_AUDIT_SHEET_ID;
    const gid     = process.env.LEAD_AUDIT_GID ? parseInt(process.env.LEAD_AUDIT_GID) : null;
    if (!sheetId) return res.status(503).json({ error: 'LEAD_AUDIT_SHEET_ID not set in env vars' });

    const auth   = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // Resolve tab name from gid
    const meta      = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const sheetMeta = gid != null
      ? meta.data.sheets.find(s => s.properties.sheetId === gid)
      : meta.data.sheets[0];
    if (!sheetMeta) return res.status(404).json({ error: `Tab gid=${gid} not found in spreadsheet` });
    const tabName = sheetMeta.properties.title;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${tabName}!A1:Z`,
    });

    const rows = response.data.values || [];
    if (rows.length < 2) return res.json({ leads: [], unmatched: 0 });

    // Find columns by header name
    const header   = rows[0].map(h => (h || '').toLowerCase().trim());
    const iState   = header.findIndex(h => h.includes('state') || h.includes('accident'));
    const iContent = header.findIndex(h => h === 'utm_content' || h.includes('utm_content'));

    if (iState < 0)   return res.status(400).json({ error: `No state column found. Headers: ${rows[0].join(', ')}` });
    if (iContent < 0) return res.status(400).json({ error: `No utm_content column found. Headers: ${rows[0].join(', ')}` });

    // Count rows grouped by (state, utm_content)
    const counts    = {};
    let   unmatched = 0;
    for (let i = 1; i < rows.length; i++) {
      const row     = rows[i];
      const state   = (row[iState]   || '').trim().toUpperCase();
      const content = (row[iContent] || '').trim();
      if (!state) continue;
      if (!content) { unmatched++; continue; }
      const key = `${state}\x00${content}`;
      counts[key] = (counts[key] || 0) + 1;
    }

    const leads = Object.entries(counts).map(([key, actualLeads]) => {
      const sep   = key.indexOf('\x00');
      const state = key.slice(0, sep);
      const utmContent = key.slice(sep + 1);
      return { state, utmContent, actualLeads };
    });

    res.json({ leads, unmatched, tab: tabName, totalRows: rows.length - 1 });
  } catch (err) {
    console.error('Lead audit sheet error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sheets/tracking-import
// Reads the manual tracking sheet (TRACKING_SHEET_ID env var).
// Row 1 = headers: date, ad name, SC, GA, ...
// Row 2 = full campaign names: <blank>, Account, LSS SC, LSS GA, ...
// Returns { columns: [{ key, fullName }], rows: [{ id, adName, leads }] }
const SKIP_LABELS = new Set(['date', 'account', 'none', 'ad name', 'ad', '']);

router.get('/tracking-import', async (req, res) => {
  try {
    const sheetId = process.env.TRACKING_SHEET_ID;
    if (!sheetId) return res.status(503).json({ error: 'TRACKING_SHEET_ID not set in Render env vars' });

    const gid = parseInt(req.query.gid || process.env.TRACKING_SHEET_GID || '264713539');

    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const sheetMeta = meta.data.sheets.find(s => s.properties.sheetId === gid);
    if (!sheetMeta) return res.status(404).json({ error: `Tab with gid ${gid} not found in spreadsheet` });
    const tabName = sheetMeta.properties.title;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${tabName}!A:ZZ`, // read all columns dynamically
    });

    const rows = response.data.values || [];
    if (rows.length < 2) return res.json({ columns: [], rows: [] });

    // Row 0: short header keys (SC, GA, VA, ...)
    const headerRow = rows[0] || [];
    // Row 1: full campaign names (LSS SC, LSS GA, ...)
    const campaignRow = rows[1] || [];

    // Build column definitions from col index 2 onward
    const columns = [];
    for (let j = 2; j < headerRow.length; j++) {
      const key      = (headerRow[j]   || '').trim();
      const fullName = (campaignRow[j] || '').trim();
      if (key) columns.push({ key, fullName: fullName || key });
    }

    // Parse ad rows (rows 2+), skip header/label rows
    const byName = {};
    for (let i = 2; i < rows.length; i++) {
      const row    = rows[i];
      const date   = (row[0] || '').trim();
      const adName = (row[1] || '').trim();
      if (!adName || SKIP_LABELS.has(date.toLowerCase()) || SKIP_LABELS.has(adName.toLowerCase())) continue;

      if (!byName[adName]) {
        byName[adName] = { id: adName, adName, leads: {} };
      }

      columns.forEach((col, j) => {
        const val = parseInt(row[j + 2] || '0') || 0;
        if (val > 0) byName[adName].leads[col.key] = (byName[adName].leads[col.key] || 0) + val;
      });
    }

    res.json({ columns, rows: Object.values(byName) });
  } catch (err) {
    console.error('Tracking import error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sheets/import-month
// Reads MONTHLY_CASES_SHEET_ID + MONTHLY_CASES_TAB (columns A–J) and appends rows
// that don't already exist in the master sheet (SHEETS_ID + SHEETS_TAB_NAME).
// Master columns: A=name, B=phone, C=campaign, D=state, E=empty, F=date,
//                 G=utmCampaign, H=utmAdset, I=utmContent(ad), J=utmTerm
// Deduplication key: normalised phone number (last 10 digits) — most reliable signal.
// Returns { added, skipped }.
router.post('/import-month', async (req, res) => {
  try {
    const monthlySheetId = process.env.MONTHLY_CASES_SHEET_ID;
    const monthlyTab     = process.env.MONTHLY_CASES_TAB;
    if (!monthlySheetId) return res.status(503).json({ error: 'MONTHLY_CASES_SHEET_ID not set' });
    if (!monthlyTab)     return res.status(503).json({ error: 'MONTHLY_CASES_TAB not set' });

    const masterSheetId = process.env.SHEETS_ID;
    const masterTab     = process.env.SHEETS_TAB_NAME || 'Sheet1';
    if (!masterSheetId) return res.status(503).json({ error: 'SHEETS_ID not set' });

    function normalizePhone(p) {
      return (p || '').replace(/\D/g, '').slice(-10);
    }

    const auth   = await getAuthClient(true);
    const sheets = google.sheets({ version: 'v4', auth });

    // Read master A–J to build dedupe set keyed on phone (col B = index 1)
    const masterRes = await sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: `${masterTab}!A2:J`,
    });
    const masterRows = masterRes.data.values || [];
    const existingPhones = new Set(
      masterRows.map(r => normalizePhone(r[1])).filter(Boolean)
    );

    // Read monthly including row 1 header to detect column layout
    const monthRes = await sheets.spreadsheets.values.get({
      spreadsheetId: monthlySheetId,
      range: `${monthlyTab}!A1:Z`,
    });
    const allMonthRows = monthRes.data.values || [];
    if (allMonthRows.length < 2) return res.json({ added: 0, skipped: 0 });

    // Detect columns by header name (case-insensitive)
    const headerRow = allMonthRows[0].map(h => (h || '').toLowerCase().trim());
    const monthRows = allMonthRows.slice(1);

    function colIdx(...names) {
      for (const name of names) {
        const i = headerRow.findIndex(h => h.includes(name));
        if (i >= 0) return i;
      }
      return -1;
    }

    // Env var overrides (0-based) take priority over header detection
    const iName  = parseInt(process.env.MONTHLY_COL_NAME  ?? colIdx('name', 'first', 'client', 'contact'));
    const iPhone = parseInt(process.env.MONTHLY_COL_PHONE ?? colIdx('phone', 'mobile', 'cell', 'number'));
    const iState = parseInt(process.env.MONTHLY_COL_STATE ?? colIdx('state', 'st'));
    const iDate  = parseInt(process.env.MONTHLY_COL_DATE  ?? colIdx('date', 'created', 'signed', 'intake'));

    // Keep only rows whose phone doesn't already exist in master
    const toAppend = monthRows
      .filter(r => {
        const phone = normalizePhone(iPhone >= 0 ? r[iPhone] : r[1]);
        return phone && !existingPhones.has(phone);
      })
      .map(r => {
        const name  = (iName  >= 0 ? r[iName]  : r[0] || '').trim();
        const phone = (iPhone >= 0 ? r[iPhone] : r[1] || '').trim();
        const state = (iState >= 0 ? r[iState] : r[3] || '').trim().toUpperCase();
        const date  = (iDate  >= 0 ? r[iDate]  : r[5] || '').trim();
        // Master layout: A=name B=phone C=campaign D=state E=status F=date G-J=utm
        return [name, phone, '', state, '', date, '', '', '', ''];
      });

    if (toAppend.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: masterSheetId,
        range: `${masterTab}!A:J`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: toAppend },
      });
    }

    res.json({ added: toAppend.length, skipped: monthRows.length - toAppend.length });
  } catch (err) {
    console.error('Sheet import-month error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
