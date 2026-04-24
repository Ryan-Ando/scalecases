import { Router } from 'express';
import fetch from 'node-fetch';
import { google } from 'googleapis';

const router = Router();

const HYROS_BASE = 'https://api.hyros.com/v1/api/v1.0';
const FB_API     = 'https://graph.facebook.com/v19.0';
const START_DATE = '2026-04-14';
const SHEET_ID   = process.env.HYROS_SHEET_ID || '16c7rc3LmPcRRMpw5u4lbk5wq8Mwizma8ynNB1nu9Prw';

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoToday() { return new Date().toISOString().slice(0, 10); }

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

// 1-based column index → letter(s)
function colLetter(n) {
  let r = '';
  while (n > 0) { n--; r = String.fromCharCode(65 + (n % 26)) + r; n = Math.floor(n / 26); }
  return r;
}

// Sanitize a string for use as a Google Sheets tab name (max 100 chars, no special chars)
function safeTabName(s) {
  return (s || 'Unknown Campaign')
    .replace(/[:\\/?*[\]]/g, ' ')
    .trim()
    .slice(0, 100) || 'Unknown Campaign';
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

// ── FB API — batch adset name, status, and campaign name ─────────────────────

async function getAdsetInfo(adsetIds) {
  const token = process.env.FB_ACCESS_TOKEN;
  const info  = {};
  if (!token || !adsetIds.length) return info;

  for (let i = 0; i < adsetIds.length; i += 50) {
    const chunk = adsetIds.slice(i, i + 50);
    try {
      const params = new URLSearchParams({
        ids:          chunk.join(','),
        fields:       'name,effective_status,campaign{name,id}',
        access_token: token,
      });
      const r    = await fetch(`${FB_API}/?${params}`);
      const data = await r.json();
      if (!data.error) {
        for (const [id, d] of Object.entries(data)) {
          if (d.name) {
            info[id] = {
              name:         d.name,
              status:       d.effective_status || 'UNKNOWN',
              campaignName: d.campaign?.name   || 'Unknown Campaign',
              campaignId:   d.campaign?.id     || null,
            };
          }
        }
      } else {
        console.warn('FB adset lookup error:', data.error.message);
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

// ── Write one campaign tab ────────────────────────────────────────────────────

async function writeCampaignTab(sheets, tabName, numericId, adsets, dailyData, dates) {
  const leadsCol = 1 + dates.length + 1;
  const spendCol = leadsCol + 1;
  const cplCol   = spendCol + 1;
  const statusCol = cplCol  + 1;

  const headers = [
    'Adset Name',
    ...dates.map(d => {
      const dt = new Date(d + 'T12:00:00Z');
      return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
    }),
    'Total Leads', 'Total Spend', 'CPL', 'Status',
  ];

  const dataRows = adsets.map((adset, idx) => {
    const row   = idx + 2;
    const cells = [adset.name];
    let totLeads = 0, totCost = 0;

    for (const dateStr of dates) {
      const d = dailyData[dateStr]?.[adset.id];
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

  // Clear + write values
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: tabName });
  await sheets.spreadsheets.values.update({
    spreadsheetId:    SHEET_ID,
    range:            `${tabName}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody:      { values: [headers, ...dataRows] },
  });

  // Formatting
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
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
        {
          updateSheetProperties: {
            properties: {
              sheetId: numericId,
              gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 },
            },
            fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
          },
        },
        { setBasicFilter: { filter: { range: { sheetId: numericId } } } },
        {
          repeatCell: {
            range: { sheetId: numericId, startRowIndex: 1, startColumnIndex: spendCol - 1, endColumnIndex: spendCol },
            cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' } } },
            fields: 'userEnteredFormat.numberFormat',
          },
        },
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
}

// ── Core sync ─────────────────────────────────────────────────────────────────

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

    // 1. Fetch Hyros data per day
    const dailyData = {};
    for (const dateStr of dates) {
      dailyData[dateStr] = await fetchHyrosDay(dateStr);
      await delay(500);
    }

    // 2. Collect all adset IDs
    const allAdsetIds = new Set();
    for (const day of Object.values(dailyData)) {
      for (const id of Object.keys(day)) allAdsetIds.add(id);
    }

    // 3. Resolve names, statuses, and campaign names from FB
    const adsetInfo = await getAdsetInfo([...allAdsetIds]);

    // 4. Group adsets by campaign
    const byCampaign = {}; // campaignTabName → adset[]
    for (const id of allAdsetIds) {
      const info     = adsetInfo[id];
      const tabName  = safeTabName(info?.campaignName || 'Unknown Campaign');
      if (!byCampaign[tabName]) byCampaign[tabName] = [];
      byCampaign[tabName].push({
        id,
        name:   info?.name   || id,
        status: info?.status || 'UNKNOWN',
      });
    }

    // Sort adsets within each campaign: active first, then alpha
    for (const adsets of Object.values(byCampaign)) {
      adsets.sort((a, b) => {
        const aA = a.status === 'ACTIVE', bA = b.status === 'ACTIVE';
        if (aA && !bA) return -1;
        if (!aA && bA) return  1;
        return a.name.localeCompare(b.name);
      });
    }

    // 5. Get or create tabs
    const auth   = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const meta        = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const existingTabs = meta.data.sheets.map(s => ({
      title:     s.properties.title,
      numericId: s.properties.sheetId,
    }));

    const campaignTabNames = new Set(Object.keys(byCampaign));

    // Create any missing tabs
    const tabsToCreate = [...campaignTabNames].filter(
      name => !existingTabs.some(t => t.title === name)
    );
    if (tabsToCreate.length) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          requests: tabsToCreate.map(title => ({ addSheet: { properties: { title } } })),
        },
      });
    }

    // Re-fetch tab list with numeric IDs after creation
    const metaAfter   = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const tabMap      = {}; // tabName → numericId
    for (const s of metaAfter.data.sheets) {
      tabMap[s.properties.title] = s.properties.sheetId;
    }

    // 6. Write each campaign tab
    for (const [tabName, adsets] of Object.entries(byCampaign)) {
      console.log(`  Writing tab: ${tabName} (${adsets.length} adsets)`);
      await writeCampaignTab(sheets, tabName, tabMap[tabName], adsets, dailyData, dates);
      await delay(300);
    }

    // 7. Remove the old "Daily Leads" tab if it exists (replaced by campaign tabs)
    const oldTab = metaAfter.data.sheets.find(s => s.properties.title === 'Daily Leads');
    if (oldTab && Object.keys(tabMap).length > 1) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          requests: [{ deleteSheet: { sheetId: oldTab.properties.sheetId } }],
        },
      });
    }

    _lastSync = new Date().toISOString();
    const total = Object.values(byCampaign).reduce((s, a) => s + a.length, 0);
    console.log(`Hyros sync complete: ${total} adsets across ${Object.keys(byCampaign).length} campaigns`);
  } catch (err) {
    _lastError = err.message;
    console.error('Hyros sync error:', err.message);
  } finally {
    _syncRunning = false;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

async function handleSync(req, res) {
  if (_syncRunning) return res.json({ ok: false, status: 'already running' });
  res.json({ ok: true, status: 'started', sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}` });
  runSync();
}
router.get('/sync',  handleSync);
router.post('/sync', handleSync);

router.get('/status', (_req, res) => {
  res.json({
    running:   _syncRunning,
    lastSync:  _lastSync,
    lastError: _lastError,
    sheetUrl:  `https://docs.google.com/spreadsheets/d/${SHEET_ID}`,
  });
});

export default router;
