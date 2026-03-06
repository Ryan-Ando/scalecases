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

async function getAuthClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return auth.getClient();
}

// GET /api/sheets/cases?start=ISO&end=ISO
// Reads name (col A), phone (col B), date (col F) from the sheet.
// Optionally filters by date range. Returns [{ name, phone, date }].
router.get('/cases', async (req, res) => {
  try {
    const { sheetId, tabName } = getSheetConfig();
    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${tabName}!A2:F`,
    });

    const rows = response.data.values || [];

    const start = req.query.start ? new Date(req.query.start) : null;
    const end   = req.query.end   ? new Date(req.query.end)   : null;

    const cases = [];
    for (const row of rows) {
      const name  = (row[0] || '').trim();
      const phone = (row[1] || '').trim();
      const date  = row[5] ? new Date(row[5]) : null;

      if (!phone) continue;

      if (start && date && date < start) continue;
      if (end   && date && date > end)   continue;

      const state = (row[3] || '').trim().toUpperCase();
      cases.push({ name, phone, state, date: date ? date.toISOString() : null });
    }

    res.json(cases);
  } catch (err) {
    console.error('Sheets cases error:', err.message);
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
// Returns [{ id, adName, date, leads: { SC: N, GA: M, ... } }]
// Columns: A=date(MMDD), B=adName, C-L=SC,GA,VA,MD,DC,FL,AZ,WA,OH,TX
const TRACKING_STATES = ['SC', 'GA', 'VA', 'MD', 'DC', 'FL', 'AZ', 'WA', 'OH', 'TX'];
const SKIP_LABELS = new Set(['date', 'account', 'none', 'ad name', 'ad', '']);

router.get('/tracking-import', async (req, res) => {
  try {
    const sheetId = process.env.TRACKING_SHEET_ID;
    if (!sheetId) return res.status(503).json({ error: 'TRACKING_SHEET_ID not set in Render env vars' });

    const gid = parseInt(req.query.gid || process.env.TRACKING_SHEET_GID || '264713539');

    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // Resolve tab name from gid
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const sheetMeta = meta.data.sheets.find(s => s.properties.sheetId === gid);
    if (!sheetMeta) return res.status(404).json({ error: `Tab with gid ${gid} not found in spreadsheet` });
    const tabName = sheetMeta.properties.title;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${tabName}!A:L`,
    });

    const rows = response.data.values || [];

    // Merge rows by adName (in case same ad appears twice), summing lead counts
    const byName = {};
    for (const row of rows) {
      const date   = (row[0] || '').trim();
      const adName = (row[1] || '').trim();
      if (!adName || SKIP_LABELS.has(date.toLowerCase()) || SKIP_LABELS.has(adName.toLowerCase())) continue;

      if (!byName[adName]) {
        byName[adName] = { id: adName, adName, date, leads: {} };
      }

      TRACKING_STATES.forEach((state, j) => {
        const val = parseInt(row[j + 2] || '0') || 0;
        if (val > 0) byName[adName].leads[state] = (byName[adName].leads[state] || 0) + val;
      });
    }

    res.json(Object.values(byName));
  } catch (err) {
    console.error('Tracking import error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
