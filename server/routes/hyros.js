import { Router } from 'express';
import fetch from 'node-fetch';
import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', 'hyros_state.json');

const HYROS_BASE = 'https://api.hyros.com/v1/api/v1.0';
const FB_API    = 'https://graph.facebook.com/v19.0';
const START_DATE = '2026-04-14';

function getState() {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

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

// Column index (1-based) → letter(s): 1→A, 27→AA
function colLetter(n) {
  let r = '';
  while (n > 0) { n--; r = String.fromCharCode(65 + (n % 26)) + r; n = Math.floor(n / 26); }
  return r;
}

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

// ── Hyros API ────────────────────────────────────────────────────────────────

async function fetchHyrosDay(dateStr) {
  const key      = process.env.HYROS_API_KEY;
  const accounts = (process.env.HYROS_AD_ACCOUNTS || '1125965718442560,758516163121709')
    .split(',').map(s => s.trim()).filter(Boolean);

  const byAdset = {}; // adsetId → {leads, cost}

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
        console.warn(`Hyros error for account ${accountId} on ${dateStr}:`, data.message);
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

    await delay(400); // gap between accounts
  }

  return byAdset;
}

// ── Facebook API — batch adset name + status lookup ─────────────────────────

async function getAdsetInfo(adsetIds) {
  const token = process.env.FB_ACCESS_TOKEN;
  const info  = {};
  if (!token || !adsetIds.length) return info;

  for (let i = 0; i < adsetIds.length; i += 50) {
    const chunk  = adsetIds.slice(i, i + 50);
    const params = new URLSearchParams({
      ids:          chunk.join(','),
      fields:       'name,effective_status',
      access_token: token,
    });
    try {
      const r    = await fetch(`${FB_API}/?${params}`);
      const data = await r.json();
      if (!data.error) {
        for (const [id, d] of Object.entries(data)) {
          if (d.name) info[id] = { name: d.name, status: d.effective_status || 'UNKNOWN' };
        }
      }
    } catch (e) {
      console.warn('FB adset lookup error:', e.message);
    }
    await delay(400);
  }

  return info;
}

// ── Google Sheets auth (needs write + drive for creation/sharing) ────────────

async function getAuthClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set');
  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
  return auth.getClient();
}

// ── POST /api/hyros/create-sheet ─────────────────────────────────────────────
// Creates a new Google Sheet, shares it, saves ID to hyros_state.json.

router.post('/create-sheet', async (req, res) => {
  try {
    const auth   = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });
    const drive  = google.drive({ version: 'v3', auth });

    const resp = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: 'Hyros Ad Performance' },
        sheets: [{ properties: { title: 'Daily Leads', sheetId: 0 } }],
      },
    });

    const sheetId = resp.data.spreadsheetId;

    // Share with the owner email (env or default)
    const ownerEmail = process.env.HYROS_SHEET_OWNER || 'levi@cypressmediagroup.com';
    try {
      await drive.permissions.create({
        fileId: sheetId,
        requestBody: { type: 'user', role: 'writer', emailAddress: ownerEmail },
        sendNotificationEmail: false,
      });
    } catch (e) {
      console.warn('Could not share sheet:', e.message);
    }

    saveState({ sheetId, lastSync: null });

    res.json({
      ok: true,
      sheetId,
      url: `https://docs.google.com/spreadsheets/d/${sheetId}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/hyros/sync ──────────────────────────────────────────────────────
// Full refresh: fetches all days from START_DATE → today, rebuilds the sheet.
// Long-running — responds immediately with { ok, status: 'started' }, runs async.

router.post('/sync', async (req, res) => {
  const state = getState();
  if (!state.sheetId) {
    return res.status(400).json({ error: 'No sheet created yet. POST /api/hyros/create-sheet first.' });
  }

  res.json({ ok: true, status: 'started', sheetId: state.sheetId });

  // Run async after response is sent
  _runSync(state.sheetId).catch(err => console.error('Hyros sync failed:', err.message));
});

async function _runSync(sheetId) {
  const today = isoToday();
  const dates = buildDateRange(START_DATE, today);
  console.log(`Hyros sync: fetching ${dates.length} days across all accounts…`);

  // ── 1. Fetch Hyros data per day ──────────────────────────────────────────
  const dailyData = {}; // date → adsetId → {leads, cost}
  for (const dateStr of dates) {
    dailyData[dateStr] = await fetchHyrosDay(dateStr);
    await delay(500);
  }

  // ── 2. Collect all adset IDs ─────────────────────────────────────────────
  const allAdsetIds = new Set();
  for (const day of Object.values(dailyData)) {
    for (const id of Object.keys(day)) allAdsetIds.add(id);
  }

  // ── 3. Get adset names + statuses from FB ────────────────────────────────
  const adsetInfo = await getAdsetInfo([...allAdsetIds]);

  // ── 4. Build adset rows (active first, then inactive, alpha within each) ──
  const adsets = [...allAdsetIds].map(id => ({
    id,
    name:   adsetInfo[id]?.name   || id,
    status: adsetInfo[id]?.status || 'UNKNOWN',
  })).sort((a, b) => {
    const aA = a.status === 'ACTIVE', bA = b.status === 'ACTIVE';
    if (aA && !bA) return -1;
    if (!aA && bA) return 1;
    return a.name.localeCompare(b.name);
  });

  // ── 5. Column layout ─────────────────────────────────────────────────────
  // A: Adset Name
  // B … B+N-1: date columns (N = dates.length)
  // B+N: Total Leads
  // B+N+1: Total Spend
  // B+N+2: CPL (formula)
  // B+N+3: Status
  const totalLeadsColIdx = 1 + dates.length + 1; // 1-based
  const totalSpendColIdx = totalLeadsColIdx + 1;
  const cplColIdx        = totalSpendColIdx + 1;
  const statusColIdx     = cplColIdx + 1;

  // ── 6. Header row ────────────────────────────────────────────────────────
  const headers = [
    'Adset Name',
    ...dates.map(d => {
      const dt = new Date(d + 'T12:00:00Z');
      return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
    }),
    'Total Leads',
    'Total Spend',
    'CPL',
    'Status',
  ];

  // ── 7. Data rows ─────────────────────────────────────────────────────────
  const dataRows = adsets.map((adset, idx) => {
    const sheetRow = idx + 2; // row 1 = headers
    const row      = [adset.name];

    let totalLeads = 0;
    let totalCost  = 0;

    for (const dateStr of dates) {
      const d = dailyData[dateStr][adset.id];
      row.push(d?.leads || 0);
      totalLeads += (d?.leads || 0);
      totalCost  += (d?.cost  || 0);
    }

    row.push(totalLeads);
    row.push(Number(totalCost.toFixed(2)));
    // CPL formula — avoids divide-by-zero
    row.push(
      `=IF(${colLetter(totalLeadsColIdx)}${sheetRow}=0,"—",${colLetter(totalSpendColIdx)}${sheetRow}/${colLetter(totalLeadsColIdx)}${sheetRow})`
    );
    row.push(adset.status);

    return row;
  });

  // ── 8. Write to sheet ────────────────────────────────────────────────────
  const auth   = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  // Clear existing content
  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: 'Daily Leads',
  });

  // Write all rows
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range:          'Daily Leads!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [headers, ...dataRows] },
  });

  // ── 9. Formatting ────────────────────────────────────────────────────────
  const lastDataCol = statusColIdx - 1; // 0-based end for ranges below

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        // Bold header row
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 } } },
            fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
          },
        },
        // Freeze row 1 and column A
        {
          updateSheetProperties: {
            properties: { sheetId: 0, gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 } },
            fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
          },
        },
        // Add basic filter (user can filter out inactive rows)
        { setBasicFilter: { filter: { range: { sheetId: 0 } } } },
        // Format spend column as currency
        {
          repeatCell: {
            range: {
              sheetId: 0, startRowIndex: 1,
              startColumnIndex: totalSpendColIdx - 1,
              endColumnIndex:   totalSpendColIdx,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' },
              },
            },
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        // Format CPL column as currency
        {
          repeatCell: {
            range: {
              sheetId: 0, startRowIndex: 1,
              startColumnIndex: cplColIdx - 1,
              endColumnIndex:   cplColIdx,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' },
              },
            },
            fields: 'userEnteredFormat.numberFormat',
          },
        },
      ],
    },
  });

  saveState({ sheetId, lastSync: new Date().toISOString() });
  console.log(`Hyros sync complete: ${adsets.length} adsets × ${dates.length} days`);
}

// ── GET /api/hyros/status ────────────────────────────────────────────────────

router.get('/status', (_req, res) => {
  const state = getState();
  res.json({
    sheetId:  state.sheetId  || null,
    url:      state.sheetId  ? `https://docs.google.com/spreadsheets/d/${state.sheetId}` : null,
    lastSync: state.lastSync || null,
  });
});

export default router;
