import { Router } from 'express';
import { google } from 'googleapis';

const router = Router();

function getSheetConfig() {
  return {
    sheetId: process.env.SHEETS_ID,
    tabName: process.env.SHEETS_TAB_NAME || 'Sheet1',
    campaignCol: process.env.SHEETS_CAMPAIGN_COL || 'A',
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
// Returns [{ campaignName, cases }]
router.get('/cases', async (req, res) => {
  try {
    const { sheetId, tabName, campaignCol, casesCol } = getSheetConfig();
    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // Determine range — read both columns from row 2 onward (skip header)
    const colRange = `${tabName}!${campaignCol}2:${casesCol}`;
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: colRange,
    });

    const rows = response.data.values || [];
    const data = rows
      .filter(row => row[0]) // skip empty campaign name rows
      .map(row => ({
        campaignName: row[0].trim(),
        cases: parseInt(row[1], 10) || 0,
      }));

    res.json(data);
  } catch (err) {
    console.error('Sheets cases error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sheets/config
// Returns current column mapping config (safe to expose — no secrets)
router.get('/config', (_req, res) => {
  const { tabName, campaignCol, casesCol } = getSheetConfig();
  res.json({ tabName, campaignCol, casesCol });
});

export default router;
