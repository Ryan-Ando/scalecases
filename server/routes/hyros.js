import { Router } from 'express';
import fetch from 'node-fetch';
import { google } from 'googleapis';

const router = Router();

const HYROS_BASE  = 'https://api.hyros.com/v1/api/v1.0';
const FB_API      = 'https://graph.facebook.com/v19.0';
const START_DATE  = '2026-04-14';
const SHEET_ID    = process.env.HYROS_SHEET_ID || '16c7rc3LmPcRRMpw5u4lbk5wq8Mwizma8ynNB1nu9Prw';
const SHEET_TAB   = 'Daily Leads';

// ── Helpers ──────────────────────────────────────────────────────────────────

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildDateRange(start, end) {
  const dates = [];
  const d = new Date(start + 'T12:00:00Z');
  const e = new Date(end   + 'T12:00:00Z');
  while (d <= e) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

// 1-based column index → letter(s):  1→A, 26→Z, 27→AA
function colLetter(n) {
  let r = '';
  while (n > 0) { n--; r = String.fromCharCode(65 + (n % 26)) + r; n = Math.floor(n / 26); }
  return r;
}

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

// ── Hyros API ─────────────────────────────────────────────────────────────────

async function fetchHyrosDay(dateStr) {
  const key      = process.env.HYROS_API_KEY;
  const accounts = (process.env.HYROS_AD_ACCOUNTS || '1125965718442560,758516163121709')
    .split(',').map(s => s.trim()).filter(Boolean);

  const byAdset = {};

  for (const accountId of accounts) {
    let pageId = null;
    do {
      const params = new URLSearchParams({
        startDate: dateStr, endDate: dateStr,
        level: 'facebook_adset',
        attributionModel: 'last_click',
        fields: 'leads,cost',
        isAdAccountId: 'true',
        ids: accountId,
      });
      if (pageId) params.set('pageId', pageId);

      const r    = await fetch(`${HYROS_BASE}/attribution?${params}`, {
        headers: { 'API-Key': key },
      });
      const data = await r.json();

      if (data.result === 'ERROR' || !Array.isArray(data.result)) {
        console.warn(`Hyros [${accountId}] ${dateStr}:`, data.message);
        break;
      }

      for (const row of data.result) {
        if (!byAdset[row.id]) byAdset[row.id] = { leads: 0, cost: 0 };
        byAdset[row.id].leads += (row.leads || 0);
        byAdset[row.id].cost  += (row.cost  || 0);
      }

      pageId = data.nextPageId || null;
      if (pageId) await delay(300);
    } while (pageId);

    await delay(400);
  }

  return byAdset;
}

// ── FB API — batch adset name + status ───────────────────────────────────────

async function getAdsetInfo(adsetIds) {
  const token = process.env.FB_ACCESS_TOKEN;
  const info  = {};
  if (!token || !adsetIds.length) return info;

  for (let i = 0; i < adsetIds.length; i += 50) {
    const chunk = adsetIds.slice(i, i + 50);
    try {
      const params = new URLSearchParams({
        ids: chunk.join(','), fields: 'name,effective_status', access_token: token,
      });
      const r    = await fetch(`${FB_API}/?${params}`);
      const data = await r.json();
      if (!data.error) {
        for (const [id, d] of Object.entries(data)) {
          if (d.name) info[id] = { name: d.name, status: d.effective_status || 'UNKNOWN' };
        }
      }
    } catch (e) {
      console.warn('FB adset lookup:', e.message);
    }
    await delay(400);
  }
  return info;
}

// ── Google Sheets auth ────────────────────────────────────────────────────────

async function getAuthClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(raw),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getClient();
}

// ── Core sync logic ───────────────────────────────────────────────────────────

let _syncRunning = false;
let _lastSync    = null;
let _lastError   = null;

async function runSync() {
  if (_syncRunning) return;
  _syncRunning = true;
  _lastError   = null;

  try {
    const today = isoToday();
    const dates = buildDateRange(START_DATE, today);
    console.log(`Hyros sync: ${dates.length} days…`);

    // 1. Fetch Hyros per day
    const dailyData = {};
    for (const dateStr of dates) {
      dailyData[dateStr] = await fetchHyrosDay(dateStr);
      await delay(500);
    }

    // 2. Collect all adset IDs seen across all days
    const allAdsetIds = new Set();
    for (const day of Object.values(dailyData)) {
      for (const id of Object.keys(day)) allAdsetIds.add(id);
    }

    // 3. Resolve names + statuses from FB
    const adsetInfo = await getAdsetInfo([...allAdsetIds]);

    // 4. Sort: active first, then inactive; alpha within each group
    const adsets = [...allAdsetIds].map(id => ({
      id,
      name:   adsetInfo[id]?.name   || id,
      status: adsetInfo[id]?.status || 'UNKNOWN',
    })).sort((a, b) => {
      const aA = a.status === 'ACTIVE', bA = b.status === 'ACTIVE';
      if (aA && !bA) return -1;
      if (!aA && bA) return  1;
      return a.name.localeCompare(b.name);
    });

    // 5. Column layout (1-based)
    // A=1: Adset Name | B…B+N-1: date cols | B+N: Total Leads | +1: Total Spend | +2: CPL | +3: Status
    const leadsCol  = 1 + dates.length + 1;
    const spendCol  = leadsCol + 1;
    const cplCol    = spendCol + 1;
    const statusCol = cplCol   + 1;

    // 6. Headers
    const headers = [
      'Adset Name',
      ...dates.map(d => {
        const dt = new Date(d + 'T12:00:00Z');
        return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
      }),
      'Total Leads', 'Total Spend', 'CPL', 'Status',
    ];

    // 7. Data rows
    const dataRows = adsets.map((adset, idx) => {
      const row     = idx + 2; // row 1 = header
      const cells   = [adset.name];
      let totLeads  = 0, totCost = 0;

      for (const dateStr of dates) {
        const d = dailyData[dateStr][adset.id];
        cells.push(d?.leads || 0);
        totLeads += (d?.leads || 0);
        totCost  += (d?.cost  || 0);
      }

      cells.push(totLeads);
      cells.push(Number(totCost.toFixed(2)));
      cells.push(`=IF(${colLetter(leadsCol)}${row}=0,"—",${colLetter(spendCol)}${row}/${colLetter(leadsCol)}${row})`);
      cells.push(adset.status);
      return cells;
    });

    // 8. Write to sheet
    const auth   = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // Ensure the tab exists; create it if not
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const tabExists = meta.data.sheets.some(s => s.properties.title === SHEET_TAB);
    if (!tabExists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: SHEET_TAB } } }] },
      });
    }

    // Get the real sheetId (numeric) for formatting
    const metaAfter  = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const tabMeta    = metaAfter.data.sheets.find(s => s.properties.title === SHEET_TAB);
    const numericId  = tabMeta?.properties?.sheetId ?? 0;

    // Clear + write
    await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: SHEET_TAB });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [headers, ...dataRows] },
    });

    // 9. Formatting
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [
          // Bold + grey header row
          {
            repeatCell: {
              range: { sheetId: numericId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true },
                  backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
                },
              },
              fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
            },
          },
          // Freeze row 1 + column A
          {
            updateSheetProperties: {
              properties: {
                sheetId: numericId,
                gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 },
              },
              fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
            },
          },
          // Filter row (use Status column to hide inactive)
          { setBasicFilter: { filter: { range: { sheetId: numericId } } } },
          // Spend column: currency
          {
            repeatCell: {
              range: { sheetId: numericId, startRowIndex: 1, startColumnIndex: spendCol - 1, endColumnIndex: spendCol },
              cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' } } },
              fields: 'userEnteredFormat.numberFormat',
            },
          },
          // CPL column: currency
          {
            repeatCell: {
              range: { sheetId: numericId, startRowIndex: 1, startColumnIndex: cplCol - 1, endColumnIndex: cplCol },
              cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' } } },
              fields: 'userEnteredFormat.numberFormat',
            },
          },
        ],
      },
    });

    _lastSync = new Date().toISOString();
    console.log(`Hyros sync complete: ${adsets.length} adsets × ${dates.length} days`);
  } catch (err) {
    _lastError = err.message;
    console.error('Hyros sync error:', err.message);
  } finally {
    _syncRunning = false;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET or POST /api/hyros/sync — triggers a full rebuild (async, returns immediately)
async function handleSync(req, res) {
  if (_syncRunning) return res.json({ ok: false, status: 'already running' });
  res.json({ ok: true, status: 'started', sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}` });
  runSync();
}
router.get('/sync',  handleSync);
router.post('/sync', handleSync);

// GET /api/hyros/status
router.get('/status', (_req, res) => {
  res.json({
    running:  _syncRunning,
    lastSync: _lastSync,
    lastError: _lastError,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}`,
  });
});

export default router;
