import { Router } from 'express';
import { google } from 'googleapis';

const router = Router();

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
