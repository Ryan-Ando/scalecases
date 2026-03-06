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

      cases.push({ name, phone, date: date ? date.toISOString() : null });
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

export default router;
