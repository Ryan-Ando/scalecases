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

    const data = rows.map(({ rowIndex, utmContent, utmMedium }) => ({
      range: `${tabName}!G${rowIndex}:H${rowIndex}`,
      values: [[utmContent || '', utmMedium || '']],
    }));

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

// GET /api/sheets/config
router.get('/config', (_req, res) => {
  const { tabName, stateCol } = getSheetConfig();
  res.json({ tabName, stateCol });
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
// Reads MONTHLY_CASES_SHEET_ID + MONTHLY_CASES_TAB and appends rows that don't
// already exist in the master sheet (SHEETS_ID + SHEETS_TAB_NAME).
// Deduplication key: normalised name + normalised phone (last 10 digits).
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

    const auth   = await getAuthClient(true); // write scope
    const sheets = google.sheets({ version: 'v4', auth });

    // Read master sheet to build dedupe set
    const masterRes = await sheets.spreadsheets.values.get({
      spreadsheetId: masterSheetId,
      range: `${masterTab}!A2:F`,
    });
    const masterRows = masterRes.data.values || [];
    const existing = new Set(
      masterRows.map(r => `${(r[0]||'').trim().toLowerCase()}|${(r[1]||'').replace(/\D/g,'').slice(-10)}`)
    );

    // Read monthly tab
    const monthRes = await sheets.spreadsheets.values.get({
      spreadsheetId: monthlySheetId,
      range: `${monthlyTab}!A2:F`,
    });
    const monthRows = monthRes.data.values || [];

    // Filter to new rows only
    const toAppend = monthRows.filter(r => {
      const phone = (r[1] || '').replace(/\D/g, '').slice(-10);
      if (!phone) return false;
      const key = `${(r[0]||'').trim().toLowerCase()}|${phone}`;
      return !existing.has(key);
    });

    if (toAppend.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: masterSheetId,
        range: `${masterTab}!A:F`,
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
