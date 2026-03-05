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

// GET /api/sheets/cases
// Reads every row, counts how many rows exist per state abbreviation in column D.
// Returns [{ state: 'VA', cases: 4 }, ...]
router.get('/cases', async (req, res) => {
  try {
    const { sheetId, tabName, stateCol } = getSheetConfig();
    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // Read only the state column, skipping the header row
    const range = `${tabName}!${stateCol}2:${stateCol}`;
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range,
    });

    const rows = response.data.values || [];

    // Count rows per state
    const counts = {};
    for (const row of rows) {
      const state = (row[0] || '').trim().toUpperCase();
      if (state) counts[state] = (counts[state] || 0) + 1;
    }

    const data = Object.entries(counts).map(([state, cases]) => ({ state, cases }));
    res.json(data);
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
