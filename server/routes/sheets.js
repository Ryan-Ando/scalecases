import { Router } from 'express';
import { google } from 'googleapis';

const router = Router();

function getSheetConfig() {
  return {
    sheetId: process.env.SHEETS_ID,
    tabName: process.env.SHEETS_TAB_NAME || 'Sheet1',
    stateCol: process.env.SHEETS_STATE_COL || 'A',
    casesCol: process.env.SHEETS_CASES_COL || 'B',
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

// GET /api/sheets/cases
// Returns [{ state, cases }] — state is matched against campaign names by abbreviation
router.get('/cases', async (req, res) => {
  try {
    const { sheetId, tabName, stateCol, casesCol } = getSheetConfig();
    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // Read both columns from row 2 onward (skip header row)
    const range = `${tabName}!${stateCol}2:${casesCol}`;
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range,
    });

    const rows = response.data.values || [];
    const data = rows
      .filter(row => row[0])
      .map(row => ({
        state: row[0].trim().toUpperCase(),
        cases: parseInt(row[1], 10) || 0,
      }));

    res.json(data);
  } catch (err) {
    console.error('Sheets cases error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sheets/config
router.get('/config', (_req, res) => {
  const { tabName, stateCol, casesCol } = getSheetConfig();
  res.json({ tabName, stateCol, casesCol });
});

export default router;
