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

// Per-account lead field: env HYROS_LEADS_FIELD_<accountId>=field_name
// Falls back to HYROS_LEADS_FIELD, then 'leads'
function leadsFieldForAccount(accountId) {
  return (
    process.env[`HYROS_LEADS_FIELD_${accountId}`] ||
    process.env.HYROS_LEADS_FIELD ||
    'leads'
  );
}

async function fetchHyrosDay(dateStr) {
  const key      = process.env.HYROS_API_KEY;
  const accounts = (process.env.HYROS_AD_ACCOUNTS || '1125965718442560,758516163121709')
    .split(',').map(s => s.trim()).filter(Boolean);

  const byAdset = {};

  for (const accountId of accounts) {
    const leadsField = leadsFieldForAccount(accountId);
    let pageId = null;
    do {
      const params = new URLSearchParams({
        startDate: dateStr, endDate: dateStr,
        level: 'facebook_adset',
        attributionModel: 'last_click',
        fields: `${leadsField},cost`,
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
        // support custom field names — fall back to row.leads if custom field absent
        byAdset[row.id].leads += (row[leadsField] ?? row.leads ?? 0);
        byAdset[row.id].cost  += (row.cost  || 0);
      }

      pageId = data.nextPageId || null;
      if (pageId) await delay(300);
    } while (pageId);

    await delay(400);
  }

  return byAdset;
}

// ── Probe available Hyros fields for an account ───────────────────────────────

async function probeHyrosFields(accountId, dateStr) {
  const key = process.env.HYROS_API_KEY;
  const candidates = [
    'leads',
    'leads_b2c_ppl',
    'leads_zemsky',
    'leads_acc_con',
    'converted_leads',
    'qualified_leads',
  ];

  const results = {};
  for (const field of candidates) {
    try {
      const params = new URLSearchParams({
        startDate: dateStr, endDate: dateStr,
        level: 'facebook_adset',
        attributionModel: 'last_click',
        fields: `${field},cost`,
        isAdAccountId: 'true',
        ids: accountId,
      });
      const r    = await fetch(`${HYROS_BASE}/attribution?${params}`, { headers: { 'API-Key': key } });
      const data = await r.json();

      if (!Array.isArray(data.result)) {
        results[field] = { error: data.message || 'not an array' };
      } else {
        const totLeads = data.result.reduce((s, row) => s + (row[field] ?? 0), 0);
        const totCost  = data.result.reduce((s, row) => s + (row.cost  ?? 0), 0);
        // include per-adset breakdown so caller can spot-check
        const rows = data.result.map(row => ({ id: row.id, [field]: row[field] ?? null, cost: row.cost ?? 0 }));
        results[field] = { totalLeads: totLeads, totalCost: totCost, rowCount: rows.length, rows };
      }
    } catch (e) {
      results[field] = { error: e.message };
    }
    await delay(400);
  }
  return results;
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
// Column layout:
//   A: Adset Name
//   B…: date columns (START_DATE to yesterday — excludes today)
//   Total Leads   — sum of all date cols (ex today)
//   Total Spend   — sum of all date cols (ex today)
//   CPL           — Total Spend / Total Leads (ex today)
//   L4D Leads     — today + 3 prior days
//   L4D Spend     — today + 3 prior days
//   L4D CPL       — L4D Spend / L4D Leads
//   Status

async function writeCampaignTab(sheets, tabName, numericId, adsets, dailyData, dates, today, l4dDates) {
  // dates = START_DATE to yesterday (excludes today)
  // l4dDates = today-3 to today (4 days)
  const N          = dates.length;
  const leadsCol   = 1 + N + 1; // 1-based
  const spendCol   = leadsCol + 1;
  const cplCol     = spendCol + 1;
  const l4dLeadsCol = cplCol  + 1;
  const l4dSpendCol = l4dLeadsCol + 1;
  const l4dCplCol   = l4dSpendCol + 1;
  const statusCol   = l4dCplCol  + 1;

  const headers = [
    'Adset Name',
    ...dates.map(d => {
      const dt = new Date(d + 'T12:00:00Z');
      return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
    }),
    'Total Leads', 'Total Spend', 'CPL',
    'L4D Leads', 'L4D Spend', 'L4D CPL',
    'Status',
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

    // L4D (last 4 days incl. today)
    let l4dLeads = 0, l4dCost = 0;
    for (const dateStr of l4dDates) {
      const d = dailyData[dateStr]?.[adset.id];
      l4dLeads += (d?.leads || 0);
      l4dCost  += (d?.cost  || 0);
    }
    cells.push(l4dLeads);
    cells.push(Number(l4dCost.toFixed(2)));
    cells.push(`=IF(${colLetter(l4dLeadsCol)}${row}=0,"—",${colLetter(l4dSpendCol)}${row}/${colLetter(l4dLeadsCol)}${row})`);

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
        // Total Spend: currency
        {
          repeatCell: {
            range: { sheetId: numericId, startRowIndex: 1, startColumnIndex: spendCol - 1, endColumnIndex: spendCol },
            cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' } } },
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        // CPL: currency
        {
          repeatCell: {
            range: { sheetId: numericId, startRowIndex: 1, startColumnIndex: cplCol - 1, endColumnIndex: cplCol },
            cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' } } },
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        // L4D Spend: currency
        {
          repeatCell: {
            range: { sheetId: numericId, startRowIndex: 1, startColumnIndex: l4dSpendCol - 1, endColumnIndex: l4dSpendCol },
            cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' } } },
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        // L4D CPL: currency
        {
          repeatCell: {
            range: { sheetId: numericId, startRowIndex: 1, startColumnIndex: l4dCplCol - 1, endColumnIndex: l4dCplCol },
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
    const today    = isoToday();
    const yesterday = buildDateRange(today, today).map(() => {
      const d = new Date(today + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    })[0];

    // Date columns: START_DATE to yesterday (totals exclude today)
    const dates   = buildDateRange(START_DATE, yesterday);
    // L4D: today and 3 days prior
    const l4dStart = (() => {
      const d = new Date(today + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - 3);
      return d.toISOString().slice(0, 10);
    })();
    const l4dDates = buildDateRange(l4dStart, today);

    // All dates we need to fetch (union, deduplicated)
    const allDates = [...new Set([...dates, ...l4dDates])];
    console.log(`Hyros sync: ${allDates.length} days (${dates.length} for totals + ${l4dDates.length} for L4D)…`);

    // 1. Fetch Hyros data per day
    const dailyData = {};
    for (const dateStr of allDates) {
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
      await writeCampaignTab(sheets, tabName, tabMap[tabName], adsets, dailyData, dates, today, l4dDates);
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

// GET /api/hyros/probe-leads?account=<accountId>&date=<YYYY-MM-DD>
// Fetches a sample of leads from the /leads endpoint so we can inspect the structure,
// see what stage/category fields exist, and verify adset IDs are present.
router.get('/probe-leads', async (req, res) => {
  const key     = process.env.HYROS_API_KEY;
  const dateStr = req.query.date || (() => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  try {
    const params = new URLSearchParams({ startDate: dateStr, endDate: dateStr });
    const r    = await fetch(`${HYROS_BASE}/leads?${params}`, { headers: { 'API-Key': key } });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
