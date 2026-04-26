import { Router } from 'express';
import fetch from 'node-fetch';
import { google } from 'googleapis';

const router = Router();

const HYROS_BASE = 'https://api.hyros.com/v1/api/v1.0';
const FB_API     = 'https://graph.facebook.com/v19.0';
const GHL_BASE   = 'https://rest.gohighlevel.com/v1';
const START_DATE = '2026-04-14';
const SHEET_ID   = process.env.HYROS_SHEET_ID || '16c7rc3LmPcRRMpw5u4lbk5wq8Mwizma8ynNB1nu9Prw';
const EVENTS_TAB  = 'Lead Events';
const WEBHOOK_TAB = 'Webhook Cache';
const PROTECTED_TABS = new Set([EVENTS_TAB, WEBHOOK_TAB]);

// In-memory fbclid → adsetId map, populated from Webhook Cache sheet + live webhooks
const _fbclidCache = new Map();
let   _cacheLoaded = false;

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

// ── Webhook cache ─────────────────────────────────────────────────────────────

// Load all fbclid → adsetId mappings from the Webhook Cache sheet into memory.
async function loadFbclidCache(sheets) {
  if (_cacheLoaded) return;
  try {
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${WEBHOOK_TAB}!C:D`, // fbclid, Adset ID
    });
    for (const [fbclid, adsetId] of (r.data.values || []).slice(1)) {
      if (fbclid && adsetId) _fbclidCache.set(fbclid, adsetId);
    }
  } catch { /* tab may not exist yet */ }
  _cacheLoaded = true;
}

async function ensureWebhookTab(sheets) {
  const meta   = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const hasTab = meta.data.sheets.some(s => s.properties.title === WEBHOOK_TAB);
  if (!hasTab) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: WEBHOOK_TAB } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${WEBHOOK_TAB}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Timestamp', 'Lead ID', 'fbclid', 'Adset ID', 'Email', 'Event Type']] },
    });
  }
}

// ── Sheet — read stage events ─────────────────────────────────────────────────

// Reads the "Lead Events" tab and returns leads grouped by date + adset ID.
// Returns: { '2026-04-23': { '<adsetId>': 3, ... }, ... }
async function getLeadsFromSheet(sheets) {
  try {
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${EVENTS_TAB}!A:D`,
    });
    const rows = (r.data.values || []).slice(1); // skip header
    const byDate = {};
    for (const [, dateStr, adsetId] of rows) {
      if (!dateStr || !adsetId) continue;
      if (!byDate[dateStr]) byDate[dateStr] = {};
      byDate[dateStr][adsetId] = (byDate[dateStr][adsetId] || 0) + 1;
    }
    return byDate;
  } catch {
    return {};
  }
}

// ── Hyros API — spend ─────────────────────────────────────────────────────────

// Fetch spend per adset for a single day via attribution endpoint.
async function fetchCostForDay(dateStr) {
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
        fields: 'cost',
        isAdAccountId: 'true',
        ids: accountId,
      });
      if (pageId) params.set('pageId', pageId);

      const r    = await fetch(`${HYROS_BASE}/attribution?${params}`, { headers: { 'API-Key': key } });
      const data = await r.json();

      if (!Array.isArray(data.result)) {
        console.warn(`Hyros cost [${accountId}] ${dateStr}:`, data.message);
        break;
      }

      for (const row of data.result) {
        if (!byAdset[row.id]) byAdset[row.id] = 0;
        byAdset[row.id] += (row.cost || 0);
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

// Fetch ALL adsets from all FB ad accounts (paginated), returns same info shape as getAdsetInfo
async function getAllAccountAdsets() {
  const token    = process.env.FB_ACCESS_TOKEN;
  const accounts = (process.env.FB_AD_ACCOUNTS || '')
    .split(',').map(a => { const id = a.trim(); return id.startsWith('act_') ? id : `act_${id}`; })
    .filter(id => id !== 'act_');
  const info = {};
  if (!token || !accounts.length) return info;

  for (const account of accounts) {
    let url = `${FB_API}/${account}/adsets?fields=id,name,effective_status,campaign{name,id}&effective_status=["ACTIVE"]&limit=200&access_token=${token}`;
    while (url) {
      try {
        const r    = await fetch(url);
        const data = await r.json();
        if (data.error) { console.warn('FB getAllAdsets error:', data.error.message); break; }
        for (const d of data.data || []) {
          info[d.id] = {
            name:         d.name,
            status:       d.effective_status || 'UNKNOWN',
            campaignName: d.campaign?.name   || 'Unknown Campaign',
            campaignId:   d.campaign?.id     || null,
          };
        }
        url = data.paging?.next || null;
        if (url) await delay(300);
      } catch (e) { console.warn('FB getAllAdsets:', e.message); break; }
    }
    await delay(300);
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
// Row 1: Headers (frozen)
// Row 2: Totals  (frozen, equation-based, pinned below header)
// Row 3+: Adset data sorted by CPL desc; inactive rows hidden

async function writeCampaignTab(sheets, tabName, numericId, adsets, dailyData, dates, today, l4dDates) {
  const spendCol    = 3;  // 1-based column indices
  const leadsCol    = 4;
  const cplCol      = 5;
  const l4dLeadsCol = 6;
  const l4dSpendCol = 7;
  const l4dCplCol   = 8;
  const firstDayCol = 9;
  const lastDayCol  = firstDayCol + dates.length - 1;
  const l4dEndCol   = firstDayCol + Math.min(l4dDates.length, dates.length) - 1;

  const headers = [
    'Adset Name', 'Status', 'Total Spend', 'Total Leads', 'CPL',
    'L4D Leads', 'L4D Spend', 'L4D CPL',
    ...dates.map(d => {
      const dt = new Date(d + 'T12:00:00Z');
      return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
    }),
  ];

  // Build per-adset data for sorting
  const adsetData = adsets.map(adset => {
    let totLeads = 0, totCost = 0, l4dCost = 0;
    const dayCells = [];
    for (const dateStr of dates) {
      const d = dailyData[dateStr]?.[adset.id];
      dayCells.push(d?.leads || 0);
      totLeads += (d?.leads || 0);
      totCost  += (d?.cost  || 0);
    }
    for (const dateStr of l4dDates) {
      const d = dailyData[dateStr]?.[adset.id];
      l4dCost += (d?.cost || 0);
    }
    return { adset, dayCells, totLeads, totCost, l4dCost, cpl: totLeads > 0 ? totCost / totLeads : -1 };
  });

  // Sort: ACTIVE adsets first (by CPL desc), then inactive adsets (by CPL desc)
  adsetData.sort((a, b) => {
    const aActive = a.adset.status === 'ACTIVE';
    const bActive = b.adset.status === 'ACTIVE';
    if (aActive !== bActive) return aActive ? -1 : 1;
    return b.cpl - a.cpl;
  });

  // Find where inactive rows start (sheet row index is 0-based; header=0, totals=1, data starts at 2)
  const firstInactiveDataIdx = adsetData.findIndex(({ adset }) => adset.status !== 'ACTIVE');
  const inactiveSheetStart   = firstInactiveDataIdx >= 0 ? firstInactiveDataIdx + 2 : -1;
  const inactiveSheetEnd     = inactiveSheetStart   >= 0 ? 2 + adsetData.length     : -1;

  // Build data rows (start at sheet row 3; row 1=header, row 2=totals)
  const dataRows = adsetData.map(({ adset, dayCells, totCost, l4dCost }, idx) => {
    const row = idx + 3; // 1-based sheet row
    return [
      adset.name,
      adset.status,
      Number(totCost.toFixed(2)),
      `=SUM(${colLetter(firstDayCol)}${row}:${colLetter(lastDayCol)}${row})`,
      `=IF(${colLetter(leadsCol)}${row}=0,"—",${colLetter(spendCol)}${row}/${colLetter(leadsCol)}${row})`,
      `=SUM(${colLetter(firstDayCol)}${row}:${colLetter(l4dEndCol)}${row})`,
      Number(l4dCost.toFixed(2)),
      `=IF(${colLetter(l4dLeadsCol)}${row}=0,"—",${colLetter(l4dSpendCol)}${row}/${colLetter(l4dLeadsCol)}${row})`,
      ...dayCells,
    ];
  });

  // Totals row (row 2) — all equation-based, sums rows 3 to end
  const lastRow = 2 + dataRows.length;
  const totalsRow = [
    'TOTALS', '',
    `=SUM(${colLetter(spendCol)}3:${colLetter(spendCol)}${lastRow})`,
    `=SUM(${colLetter(leadsCol)}3:${colLetter(leadsCol)}${lastRow})`,
    `=IF(${colLetter(leadsCol)}2=0,"—",${colLetter(spendCol)}2/${colLetter(leadsCol)}2)`,
    `=SUM(${colLetter(l4dLeadsCol)}3:${colLetter(l4dLeadsCol)}${lastRow})`,
    `=SUM(${colLetter(l4dSpendCol)}3:${colLetter(l4dSpendCol)}${lastRow})`,
    `=IF(${colLetter(l4dLeadsCol)}2=0,"—",${colLetter(l4dSpendCol)}2/${colLetter(l4dLeadsCol)}2)`,
    ...dates.map((_, i) => `=SUM(${colLetter(firstDayCol + i)}3:${colLetter(firstDayCol + i)}${lastRow})`),
  ];

  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: tabName });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID, range: `${tabName}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [headers, totalsRow, ...dataRows] },
  });

  const currencyFmt = (startCol, endCol, startRow = 1) => ({
    repeatCell: {
      range: { sheetId: numericId, startRowIndex: startRow, startColumnIndex: startCol - 1, endColumnIndex: endCol },
      cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' } } },
      fields: 'userEnteredFormat.numberFormat',
    },
  });

  const requests = [
    // Reset all row visibility before applying new hide state
    {
      updateDimensionProperties: {
        range: { sheetId: numericId, dimension: 'ROWS', startIndex: 0, endIndex: 2000 },
        properties: { hiddenByUser: false },
        fields: 'hiddenByUser',
      },
    },
    // Hide inactive adset rows (grouped at bottom) so they can be unhidden manually
    ...(inactiveSheetStart >= 0 ? [{
      updateDimensionProperties: {
        range: { sheetId: numericId, dimension: 'ROWS', startIndex: inactiveSheetStart, endIndex: inactiveSheetEnd },
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser',
      },
    }] : []),
    // Header row style
    {
      repeatCell: {
        range: { sheetId: numericId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.22, green: 0.56, blue: 0.36 } } },
        fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
      },
    },
    // Totals row style
    {
      repeatCell: {
        range: { sheetId: numericId, startRowIndex: 1, endRowIndex: 2 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.85, green: 0.93, blue: 0.87 } } },
        fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
      },
    },
    // Freeze 2 rows + 1 column
    {
      updateSheetProperties: {
        properties: { sheetId: numericId, gridProperties: { frozenRowCount: 2, frozenColumnCount: 1 } },
        fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount',
      },
    },
    { setBasicFilter: { filter: { range: { sheetId: numericId } } } },
    currencyFmt(spendCol,    spendCol),
    currencyFmt(cplCol,      cplCol),
    currencyFmt(l4dSpendCol, l4dSpendCol),
    currencyFmt(l4dCplCol,   l4dCplCol),
  ];

  await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
}

// ── Write Home tab ────────────────────────────────────────────────────────────
async function writeHomeTab(sheets, tabMap) {
  const HOME = 'Home';
  if (!tabMap[HOME]) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: HOME, index: 0 } } }] },
    });
    // Re-fetch to get sheetId
    const m = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    tabMap[HOME] = m.data.sheets.find(s => s.properties.title === HOME)?.properties?.sheetId;
  }

  const serverUrl = 'https://scalecases-server.onrender.com';
  const sheetUrl  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}`;

  const rows = [
    ['Scale Cases — Ad Intelligence'],
    [''],
    ['Action', 'Link', 'Description'],
    ['Sync Now',        `=HYPERLINK("${serverUrl}/api/hyros/sync","▶ Run Sync")`,          'Refresh all campaign tabs with latest spend + leads'],
    ['Sync Status',     `=HYPERLINK("${serverUrl}/api/hyros/status","◉ Check Status")`,    'See last sync time and whether a sync is running'],
    ['Backfill Status', `=HYPERLINK("${serverUrl}/api/hyros/backfill-status","◉ Backfill Status")`, 'Check status of last CSV backfill'],
    ['Open Sheet',      `=HYPERLINK("${sheetUrl}","📊 Open")`,                             'Link to this spreadsheet'],
    [''],
    ['Notes'],
    ['• Sheet auto-syncs every 30 minutes'],
    ['• Inactive adsets are hidden — use filters to show them'],
    ['• L4D = last 4 days excluding today'],
    ['• Day columns are newest-first (left to right)'],
  ];

  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: HOME });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID, range: `${HOME}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });

  const homeId = tabMap[HOME];
  if (homeId == null) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        // Title row
        {
          repeatCell: {
            range: { sheetId: homeId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 16 }, backgroundColor: { red: 0.22, green: 0.56, blue: 0.36 } } },
            fields: 'userEnteredFormat.textFormat,userEnteredFormat.backgroundColor',
          },
        },
        // Table header row (row 3 = index 2)
        {
          repeatCell: {
            range: { sheetId: homeId, startRowIndex: 2, endRowIndex: 3 },
            cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 } } },
            fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
          },
        },
        // Freeze top row
        {
          updateSheetProperties: {
            properties: { sheetId: homeId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
        // Column widths
        { updateDimensionProperties: { range: { sheetId: homeId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 160 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId: homeId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 180 }, fields: 'pixelSize' } },
        { updateDimensionProperties: { range: { sheetId: homeId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 380 }, fields: 'pixelSize' } },
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
    const yesterday = (() => {
      const d = new Date(today + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    })();

    // Date columns: START_DATE to today, reversed so latest is first (leftmost)
    const dates = buildDateRange(START_DATE, today).reverse();

    // L4D: yesterday and 3 days prior (excludes today)
    const l4dStart = (() => {
      const d = new Date(today + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - 4);
      return d.toISOString().slice(0, 10);
    })();
    const l4dDates = buildDateRange(l4dStart, yesterday);

    // All dates we need to fetch (union, deduplicated)
    const allDates = [...new Set([...dates, ...l4dDates])];
    console.log(`Hyros sync: ${allDates.length} days…`);

    // 1. Get Google Sheets auth early — needed for leads + writing tabs
    const auth   = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // 2. Read all stage events from sheet (leads source of truth)
    const leadsFromSheet = await getLeadsFromSheet(sheets);

    // 3. Fetch spend per day from Hyros attribution API
    const dailyData = {};
    for (const dateStr of allDates) {
      const costByAdset  = await fetchCostForDay(dateStr);
      const leadsByAdset = leadsFromSheet[dateStr] || {};
      dailyData[dateStr] = {};
      for (const id of new Set([...Object.keys(costByAdset), ...Object.keys(leadsByAdset)])) {
        dailyData[dateStr][id] = {
          leads: leadsByAdset[id] || 0,
          cost:  costByAdset[id]  || 0,
        };
      }
      await delay(500);
    }

    // 4. Collect adset IDs from leads + spend, then merge ALL account adsets from FB
    const allAdsetIds = new Set();
    for (const day of Object.values(dailyData)) {
      for (const id of Object.keys(day)) allAdsetIds.add(id);
    }

    // Pull every adset from the FB account so new/zero-lead adsets always appear
    const allAccountAdsets = await getAllAccountAdsets();
    for (const id of Object.keys(allAccountAdsets)) allAdsetIds.add(id);

    // Merge FB account info with any we already resolved
    const adsetInfo = { ...allAccountAdsets, ...await getAdsetInfo(
      [...allAdsetIds].filter(id => !allAccountAdsets[id]) // only look up unknowns
    )};

    // 4. Group adsets by campaign — all statuses (active first, inactive hidden in tab)
    const byCampaign = {}; // campaignTabName → adset[]
    for (const id of allAdsetIds) {
      const info = adsetInfo[id];
      if (!info) continue; // skip completely unknown adsets
      const tabName = safeTabName(info?.campaignName || 'Unknown Campaign');
      if (!byCampaign[tabName]) byCampaign[tabName] = [];
      byCampaign[tabName].push({ id, name: info.name || id, status: info.status || 'UNKNOWN' });
    }

    // 5. Get or create tabs
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

    // 6. Write Home tab
    await writeHomeTab(sheets, tabMap);

    // 7. Write each campaign tab
    for (const [tabName, adsets] of Object.entries(byCampaign)) {
      console.log(`  Writing tab: ${tabName} (${adsets.length} adsets)`);
      await writeCampaignTab(sheets, tabName, tabMap[tabName], adsets, dailyData, dates, today, l4dDates);
      await delay(300);
    }

    // 7. Remove stale campaign tabs + legacy "Daily Leads", never touch protected tabs or Home
    const toDelete = metaAfter.data.sheets.filter(s => {
      const title = s.properties.title;
      if (PROTECTED_TABS.has(title)) return false;
      if (title === 'Home') return false;
      return title === 'Daily Leads' || !campaignTabNames.has(title);
    });
    if (toDelete.length && Object.keys(tabMap).length > 1) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          requests: toDelete.map(s => ({ deleteSheet: { sheetId: s.properties.sheetId } })),
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

// ── GHL helpers ───────────────────────────────────────────────────────────────

async function ghlGet(path, params = {}) {
  const url = new URL(`${GHL_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const r = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${process.env.GHL_API_KEY}` },
  });
  return r.json();
}

// Returns { stateFieldId, fbclidFieldId } from GHL custom field definitions
async function getGhlFieldIds() {
  const data   = await ghlGet('/custom-fields/');
  const fields = data.customFields || [];
  return {
    stateFieldId:  fields.find(f => f.fieldKey === 'what_state_was_your_accident_in')?.id || null,
    fbclidFieldId: fields.find(f => f.fieldKey === 'fbclid')?.id || null,
    allKeys:       fields.map(f => ({ key: f.fieldKey, id: f.id })),
  };
}

// Fetch all GHL contacts created between from–to with a state value set.
async function fetchGhlContacts(from, to, stateFieldId, fbclidFieldId) {
  const contacts = [];
  const fromMs   = new Date(from + 'T00:00:00Z').getTime();
  let   startAfter    = fromMs;
  let   startAfterId  = null;
  let   page          = 0;

  while (page < 300) {
    page++;
    const params = { limit: 100, startAfter };
    if (startAfterId) params.startAfterId = startAfterId;

    const data  = await ghlGet('/contacts/', params);
    const batch = data.contacts || [];
    if (!batch.length) break;

    for (const c of batch) {
      const dateStr = (c.dateAdded || '').slice(0, 10);
      if (dateStr < from) continue;
      if (dateStr > to)   continue;

      const stateVal  = c.customField?.find(f => f.id === stateFieldId)?.value  || '';
      const fbclidVal = c.customField?.find(f => f.id === fbclidFieldId)?.value || '';
      if (!stateVal) continue;

      contacts.push({
        email:  (c.email || '').toLowerCase().trim(),
        state:  stateVal.toLowerCase().trim(),
        fbclid: fbclidVal,
        date:   dateStr,
      });
    }

    const last     = batch[batch.length - 1];
    const lastDate = (last?.dateAdded || '').slice(0, 10);
    if (lastDate > to || batch.length < 100) break;

    startAfter   = new Date(last.dateAdded).getTime();
    startAfterId = last.id;
    await delay(300);
  }

  return contacts;
}

// Fetch Hyros adset IDs for a list of emails (batches of 50).
async function hyrosAdsetsByEmail(emails) {
  const key = process.env.HYROS_API_KEY;
  const emailToAdset = {};

  // Build all batches upfront
  const batches = [];
  for (let i = 0; i < emails.length; i += 50) {
    batches.push(emails.slice(i, i + 50));
  }

  // Fire up to 10 batches concurrently to stay under Render's 30s timeout
  const CONCURRENCY = 10;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (batch) => {
        const emailsStr = batch.map(e => `"${e}"`).join(',');
        const params    = new URLSearchParams({ emails: emailsStr });
        const r         = await fetch(`${HYROS_BASE}/leads?${params}`, { headers: { 'API-Key': key } });
        return r.json();
      })
    );
    for (const data of results) {
      for (const lead of data.result || []) {
        const email   = (lead.email || '').toLowerCase().trim();
        const adsetId = lead.lastSource?.adSource?.adSourceId;
        if (email && adsetId && !emailToAdset[email]) {
          emailToAdset[email] = adsetId;
        }
      }
    }
  }

  return emailToAdset;
}

async function ensureEventsTab(sheets) {
  const meta   = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const hasTab = meta.data.sheets.some(s => s.properties.title === EVENTS_TAB);
  if (!hasTab) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: EVENTS_TAB } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${EVENTS_TAB}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Timestamp', 'Date', 'Adset ID', 'Stage', 'Campaign', 'Campaign ID', 'Ad ID', 'Ad Name', 'fbclid', 'Hyros Verified']] },
    });
  }
}

// ── Backfill state ────────────────────────────────────────────────────────────

let _backfill = { running: false, done: false, result: null, error: null };

async function runBackfillFromContacts(contacts, append = false) {
  _backfill = { running: true, done: false, result: null, error: null };
  try {
    // Build GHL lookup map — email is already lowercased, dedup by email (keep first)
    const ghlMap = {};
    for (const c of contacts) {
      if (!ghlMap[c.email]) ghlMap[c.email] = c;
    }

    // Ask Hyros which of these emails it knows about → authoritative lead set
    const emails = Object.keys(ghlMap);
    const hyrosAdsets = await hyrosAdsetsByEmail(emails);

    const auth   = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // In append mode, load existing emails to skip duplicates
    let existingEmails = new Set();
    if (append) {
      try {
        const r = await sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID, range: `${EVENTS_TAB}!I:I`,
        });
        existingEmails = new Set((r.data.values || []).flat().filter(Boolean));
      } catch { /* tab may not exist */ }
    }

    const toInsert = [], noHyros = [], noState = [], skipped = [];
    for (const email of Object.keys(hyrosAdsets)) {
      const ghl = ghlMap[email];
      if (!ghl || !ghl.state) { noState.push(email); continue; }
      if (append && existingEmails.has(email)) { skipped.push(email); continue; }

      const adsetId = ghl.adsetId || hyrosAdsets[email];
      if (!adsetId) continue;

      toInsert.push([
        new Date().toISOString(), ghl.date, adsetId, ghl.state,
        ghl.campaign, ghl.campaignId, ghl.adId, '', email, 'YES',
      ]);
    }

    for (const email of emails) {
      if (!hyrosAdsets[email]) noHyros.push(email);
    }

    await ensureEventsTab(sheets);
    if (!append) {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SHEET_ID, range: `${EVENTS_TAB}!A2:Z`,
      });
    }
    if (toInsert.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID, range: `${EVENTS_TAB}!A:A`,
        valueInputOption: 'RAW', requestBody: { values: toInsert },
      });
    }

    _backfill = {
      running: false, done: true, error: null,
      result: {
        ok: true,
        inserted: toInsert.length,
        notInHyros: noHyros.length,
        noStateSample: noState.slice(0, 5),
        notInHyrosSample: noHyros.slice(0, 5),
      },
    };
  } catch (e) {
    _backfill = { running: false, done: true, result: null, error: String(e) };
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

// Simple CSV parser — handles quoted fields with embedded commas/newlines
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"')             { inQuotes = false; }
      else                             { field += ch; }
    } else {
      if      (ch === '"')  { inQuotes = true; }
      else if (ch === ',')  { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* skip */ }
      else                  { field += ch; }
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// POST /api/hyros/backfill-csv?dryRun=true
// Body: raw CSV text (Content-Type: text/plain or text/csv)
// Parses GHL export, joins with Hyros for adset IDs, writes to Lead Events.
router.post('/backfill-csv', async (req, res) => {
  const dryRun = req.query.dryRun !== 'false';

  // Collect raw body
  let csv = '';
  await new Promise((resolve, reject) => {
    req.setEncoding('utf8');
    req.on('data', chunk => { csv += chunk; });
    req.on('end', resolve);
    req.on('error', reject);
  });

  if (!csv.trim()) return res.status(400).json({ ok: false, error: 'Empty body' });

  const rows = parseCsv(csv.trim());
  if (rows.length < 2) return res.status(400).json({ ok: false, error: 'No data rows found' });

  const headers = rows[0].map(h => h.trim().toLowerCase());
  const col = name => headers.findIndex(h => h.includes(name));

  const emailIdx  = col('email');
  const fbclidIdx = col('fbclid');
  const stateIdx  = col('state');
  const dateIdx   = col('created');
  const urlIdx    = col('url');

  if (emailIdx < 0 || stateIdx < 0) {
    return res.status(400).json({ ok: false, error: 'Could not find email or state columns', headers });
  }

  const contacts = [];
  for (const row of rows.slice(1)) {
    const email  = (row[emailIdx]  || '').toLowerCase().trim();
    const state  = (row[stateIdx]  || '').toLowerCase().trim();
    const fbclid = (row[fbclidIdx] || '').trim();
    const raw    = (row[dateIdx]   || '').trim();
    const date   = raw.slice(0, 10);
    if (!email || !state || !date) continue;

    // Parse URL for adset/ad/campaign IDs
    let adsetId = '', adId = '', campaignId = '', campaign = '';
    const rawUrl = urlIdx >= 0 ? (row[urlIdx] || '').trim() : '';
    if (rawUrl) {
      try {
        const u = new URL(rawUrl);
        adsetId    = u.searchParams.get('fbc_id')       || '';
        adId       = u.searchParams.get('h_ad_id')      || '';
        campaignId = u.searchParams.get('utm_id')       || '';
        campaign   = u.searchParams.get('utm_campaign') || '';
      } catch { /* malformed URL */ }
    }

    contacts.push({ email, state, fbclid, date, adsetId, adId, campaignId, campaign });
  }

  if (!contacts.length) {
    return res.json({ ok: false, error: 'No contacts with state found in CSV' });
  }

  const noAdset = contacts.filter(c => !c.adsetId).map(c => c.email);
  const withAdset = contacts.filter(c => c.adsetId);

  // Dry run: return preview without writing
  if (dryRun) {
    const preview = withAdset.slice(0, 5).map(c => [
      new Date().toISOString(), c.date, c.adsetId, c.state,
      c.campaign, c.campaignId, c.adId, '', c.fbclid || `email:${c.email}`, 'YES',
    ]);
    return res.json({
      dryRun: true, totalInCsv: contacts.length,
      withAdset: withAdset.length, noAdset: noAdset.length,
      noAdsetSample: noAdset.slice(0, 5), preview,
    });
  }

  // Real run: respond immediately, process in background
  // append=true → skip emails already in sheet (for daily top-ups)
  const append = req.query.append === 'true';
  if (_backfill.running) return res.json({ ok: false, error: 'Backfill already running' });
  _backfill = { running: true, done: false, result: null, error: null };
  res.json({ ok: true, status: 'started', totalContacts: contacts.length, append, pollUrl: '/api/hyros/backfill-status' });
  runBackfillFromContacts(contacts, append);
});

router.get('/backfill-status', (_req, res) => res.json(_backfill));

// GET /api/hyros/ghl-probe — raw GHL API responses to identify correct structure
router.get('/ghl-probe', async (req, res) => {
  const key = process.env.GHL_API_KEY;
  const headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
  const out = {};

  const paths = [
    'https://rest.gohighlevel.com/v1/custom-fields/',
    'https://rest.gohighlevel.com/v1/contacts/?limit=1',
    'https://services.leadconnectorhq.com/custom-fields/?locationId=',
    'https://rest.gohighlevel.com/v1/locations/',
  ];

  for (const url of paths) {
    try {
      const r    = await fetch(url, { headers });
      const text = await r.text();
      try { out[url] = JSON.parse(text); } catch { out[url] = text.slice(0, 500); }
    } catch (e) { out[url] = { error: e.message }; }
    await delay(300);
  }

  res.json(out);
});

// GET /api/hyros/backfill?from=YYYY-MM-DD&to=YYYY-MM-DD&dryRun=true
// Joins GHL contacts (state + fbclid) with Hyros leads (adset ID) and backfills Lead Events.
// Defaults to dryRun=true — add &dryRun=false to actually write.
router.get('/backfill', async (req, res) => {
  const dryRun = req.query.dryRun !== 'false';
  const from   = req.query.from || START_DATE;
  const to     = req.query.to   || isoToday();

  try {
    // 1. Resolve GHL custom field IDs
    const { stateFieldId, fbclidFieldId, allKeys } = await getGhlFieldIds();
    if (!stateFieldId) {
      return res.json({ ok: false, error: 'GHL field "what_state_was_your_accident_in" not found', allKeys });
    }

    // 2. Fetch GHL contacts with a state set in the date range
    const ghlContacts = await fetchGhlContacts(from, to, stateFieldId, fbclidFieldId);
    console.log(`Backfill: ${ghlContacts.length} GHL contacts with state in ${from}–${to}`);

    if (!ghlContacts.length) {
      return res.json({ ok: true, inserted: 0, message: 'No GHL contacts with state found in range' });
    }

    // 3. Fetch Hyros adset IDs by email
    const emails       = [...new Set(ghlContacts.map(c => c.email).filter(Boolean))];
    const emailToAdset = await hyrosAdsetsByEmail(emails);

    // 4. Load existing fbclids from Lead Events to prevent duplicates
    const auth   = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    let existingKeys = new Set();
    try {
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range:         `${EVENTS_TAB}!I:I`, // fbclid column
      });
      existingKeys = new Set((existing.data.values || []).flat().filter(Boolean));
    } catch { /* tab may not exist yet */ }

    // 5. Build rows, deduplicating on fbclid (or email: prefix as fallback)
    const toInsert   = [];
    const noAdset    = [];
    const duplicates = [];

    for (const c of ghlContacts) {
      const adsetId = emailToAdset[c.email];
      const dedupKey = c.fbclid || `email:${c.email}`;

      if (existingKeys.has(dedupKey)) { duplicates.push(c.email); continue; }
      if (!adsetId)                   { noAdset.push(c.email);    continue; }

      toInsert.push([
        new Date().toISOString(), // Timestamp
        c.date,                   // Date
        adsetId,                  // Adset ID (from Hyros)
        c.state,                  // Stage (from GHL)
        '', '', '', '',           // Campaign, Campaign ID, Ad ID, Ad Name
        dedupKey,                 // fbclid / dedup key
        'YES',                    // Hyros Verified
      ]);
      existingKeys.add(dedupKey); // prevent intra-batch duplicates
    }

    const summary = {
      dryRun,
      range:           `${from} → ${to}`,
      ghlContacts:     ghlContacts.length,
      hyrosMatched:    toInsert.length,
      noHyrosAdset:    noAdset.length,
      alreadyInSheet:  duplicates.length,
      noAdsetEmails:   noAdset.slice(0, 10),
    };

    if (dryRun) {
      return res.json({ ...summary, preview: toInsert.slice(0, 5) });
    }

    // 6. Write to sheet
    if (toInsert.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId:    SHEET_ID,
        range:            `${EVENTS_TAB}!A:A`,
        valueInputOption: 'RAW',
        requestBody:      { values: toInsert },
      });
    }

    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('backfill error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/hyros/webhook
// Receives Hyros lead.opted.in events. Extracts fbclid + adset and caches them
// so stage-event can do a Hyros-verified adset lookup when the lead hits the thank-you page.
router.post('/webhook', async (req, res) => {
  res.sendStatus(200); // respond fast — Hyros retries on timeout

  const payload = req.body || {};
  console.log('Hyros webhook:', payload.type, payload.eventId);

  if (payload.type !== 'lead.opted.in') return;

  const lead    = payload.body?.lead;
  const adsetId = lead?.lastSource?.adSource?.adSourceId;
  const leadId  = lead?.id   || '';
  const email   = lead?.email || '';

  // fbclid lives in the referrer URL that Hyros records at opt-in time
  let fbclid = '';
  try {
    const referrer = payload.body?.referrer || '';
    fbclid = new URL(referrer).searchParams.get('fbclid') || '';
  } catch { /* referrer may be empty or malformed */ }

  if (!adsetId) {
    console.warn('Hyros webhook: no adsetId found', JSON.stringify(payload).slice(0, 300));
    return;
  }

  // Store in memory immediately
  if (fbclid) _fbclidCache.set(fbclid, adsetId);

  // Persist to Webhook Cache sheet
  try {
    const auth   = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });
    await ensureWebhookTab(sheets);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${WEBHOOK_TAB}!A:A`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[new Date().toISOString(), leadId, fbclid, adsetId, email, payload.type]],
      },
    });
  } catch (err) {
    console.error('Hyros webhook sheet write error:', err.message);
  }
});

// POST /api/hyros/stage-event
// Called by a pixel on each thank-you page. Appends one row to the Lead Events sheet.
// Body: { lead_stage, fbc_id, utm_campaign, utm_id, h_ad_id, utm_medium, fbclid }
router.options('/stage-event', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

router.post('/stage-event', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { lead_stage, fbc_id, utm_campaign, utm_id, h_ad_id, utm_medium, fbclid } = req.body || {};
  if (!lead_stage || !fbclid) {
    return res.status(400).json({ ok: false, error: 'Missing lead_stage or fbclid' });
  }

  const now     = new Date();
  const dateStr = now.toISOString().slice(0, 10);

  try {
    const auth   = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // Load Hyros webhook cache from sheet if not yet in memory
    await loadFbclidCache(sheets);

    // Resolve adset ID — prefer Hyros-verified lookup, fall back to URL fbc_id
    const hyrosAdsetId = _fbclidCache.get(fbclid);
    const adsetId      = hyrosAdsetId || fbc_id || '';
    const verified     = !!hyrosAdsetId;

    if (!adsetId) {
      return res.status(400).json({ ok: false, error: 'Could not resolve adset ID' });
    }

    if (!verified) {
      console.warn(`stage-event: fbclid ${fbclid} not in Hyros cache, using URL fbc_id`);
    }

    await ensureEventsTab(sheets);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${EVENTS_TAB}!A:A`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          now.toISOString(),
          dateStr,
          adsetId,
          (lead_stage || '').toLowerCase(),
          utm_campaign || '',
          utm_id       || '',
          h_ad_id      || '',
          utm_medium   || '',
          fbclid       || '',
          verified ? 'YES' : 'NO',
        ]],
      },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('stage-event error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/hyros/probe-leads?date=<YYYY-MM-DD>
// Tries every plausible lead-journey endpoint shape to find stage data.
router.get('/probe-leads', async (req, res) => {
  const key     = process.env.HYROS_API_KEY;
  const headers = { 'API-Key': key };

  const dateStr = req.query.date || (() => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  // Known lead ID from Jennifer Cregger's export (reached "va" stage)
  const knownId = '4e4d2b5df6ebadd164b71e93c9cc722a0b4e25ca51ddf09ed1569a8bb519af77';

  const attrBase = `startDate=${dateStr}&endDate=${dateStr}&level=facebook_adset&attributionModel=last_click&isAdAccountId=true`;
  const acct1 = '1125965718442560';
  const acct2 = '758516163121709';

  const paths = [
    // Test all three custom metrics against both accounts
    `/attribution?${attrBase}&fields=leads_zemsky,cost&ids=${acct1}`,
    `/attribution?${attrBase}&fields=leads_zemsky,cost&ids=${acct2}`,
    `/attribution?${attrBase}&fields=leads_b2c_ppl,cost&ids=${acct1}`,
    `/attribution?${attrBase}&fields=leads_b2c_ppl,cost&ids=${acct2}`,
    `/attribution?${attrBase}&fields=leads_acc_con,cost&ids=${acct1}`,
    `/attribution?${attrBase}&fields=leads_acc_con,cost&ids=${acct2}`,
    // All three together
    `/attribution?${attrBase}&fields=leads_zemsky,leads_b2c_ppl,leads_acc_con,cost&ids=${acct1}`,
    `/attribution?${attrBase}&fields=leads_zemsky,leads_b2c_ppl,leads_acc_con,cost&ids=${acct2}`,
  ];

  const results = {};
  for (const path of paths) {
    try {
      const r    = await fetch(`${HYROS_BASE}${path}`, { headers });
      const text = await r.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 500); }
      results[path] = parsed;
    } catch (e) {
      results[path] = { error: e.message };
    }
    await delay(300);
  }

  res.json(results);
});

// Auto-sync every 30 minutes
setInterval(() => { if (!_syncRunning) runSync(); }, 30 * 60 * 1000);

export default router;
