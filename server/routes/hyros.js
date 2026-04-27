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

// Returns YYYY-MM-DD in America/Los_Angeles (handles PST/PDT automatically)
function isoDatePT(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d instanceof Date ? d : new Date(d));
}
function isoToday() { return isoDatePT(new Date()); }

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

// Known-good domains for fuzzy matching (edit-distance-1 typos get corrected to these)
const KNOWN_DOMAINS = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','aol.com','comcast.net','verizon.net','att.net','live.com','msn.com'];

// Returns edit distance between two strings (Levenshtein)
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

// Attempt to correct a typo TLD back to 'com' algorithmically.
// Handles: comd, comf, comm, cmo, con, ocm, cpm, cob, etc.
function correctTld(tld) {
  if (tld === 'com') return null; // already correct
  // Any permutation/extension of 'com' up to length 4
  if (tld.length <= 4 && editDistance(tld, 'com') <= 1) return 'com';
  // TLD starts with 'com' but has extra char (comf, comd, comm, coms...)
  if (tld.startsWith('com') && tld.length === 4) return 'com';
  // TLD ends with 'om' and 3 chars — likely mistyped 'com'
  if (tld.endsWith('om') && tld.length === 3 && editDistance(tld, 'com') === 1) return 'com';
  return null;
}

function isValidEmail(email) {
  if (!email || !email.includes('@')) return false;
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || !domain) return false;
  const dot = domain.lastIndexOf('.');
  if (dot < 1) return false;
  const tld = domain.slice(dot + 1).toLowerCase();
  if (!/^[a-z]{2,6}$/.test(tld)) return false;
  if (correctTld(tld)) return false; // bad TLD
  // Check if domain is a 1-edit typo of a known good domain
  const d = domain.toLowerCase();
  if (KNOWN_DOMAINS.some(good => good !== d && editDistance(d, good) <= 1)) return false;
  return true;
}

function correctEmail(email) {
  if (!email || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  if (!local || !domain) return null;
  const d   = domain.toLowerCase();
  const dot = d.lastIndexOf('.');
  if (dot < 1) return null;
  const base = d.slice(0, dot);
  const tld  = d.slice(dot + 1);

  // Try fixing a bad TLD first (e.g. gmail.comd → gmail.com)
  const fixedTld = correctTld(tld);
  if (fixedTld) {
    const candidate = `${base}.${fixedTld}`;
    // If base itself is also a typo, fix that too
    const bestDomain = KNOWN_DOMAINS.find(good => editDistance(candidate, good) <= 1) || candidate;
    return `${local}@${bestDomain}`;
  }

  // Try fixing the whole domain (e.g. gmaill.com → gmail.com)
  const bestDomain = KNOWN_DOMAINS.find(good => good !== d && editDistance(d, good) <= 1);
  if (bestDomain) return `${local}@${bestDomain}`;

  return null;
}

function hasNameEmailMismatch(firstName, lastName, email) {
  if (!firstName && !lastName) return false;
  const nameParts = [
    ...(firstName || '').toLowerCase().split(/[\s._\-]+/),
    ...(lastName  || '').toLowerCase().split(/[\s._\-]+/),
  ].filter(p => p.length >= 3);
  if (!nameParts.length) return false;
  const local = (email.split('@')[0] || '').toLowerCase();
  return !nameParts.some(p => local.includes(p));
}

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
// Only counts rows where HyrosVerified (col J) = 'YES' — skips DROPPED/NO rows.
// Returns: { '2026-04-23': { '<adsetId>': 3, ... }, ... }
async function getLeadsFromSheet(sheets) {
  try {
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${EVENTS_TAB}!A:J`,
    });
    const rows = (r.data.values || []).slice(1);
    const byDate = {};
    for (const row of rows) {
      const dateStr  = row[1];
      const adsetId  = row[2];
      const verified = row[9];
      if (!dateStr || !adsetId || verified !== 'YES') continue;
      if (!byDate[dateStr]) byDate[dateStr] = {};
      byDate[dateStr][adsetId] = (byDate[dateStr][adsetId] || 0) + 1;
    }
    return byDate;
  } catch {
    return {};
  }
}

// ── Hyros API — spend ─────────────────────────────────────────────────────────

// Fetch spend per adset for a single day via Hyros attribution endpoint.
// Returns { [adsetId]: { cost } }
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
        console.warn(`Hyros attribution [${accountId}] ${dateStr}:`, data.message);
        break;
      }

      for (const row of data.result) {
        if (!byAdset[row.id]) byAdset[row.id] = { cost: 0 };
        byAdset[row.id].cost += (row.cost || 0);
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

// ── Dedup Lead Events by email ────────────────────────────────────────────────
// Multiple CSV uploads can write the same email twice. Keep one row per email:
// prefer 'YES'-verified rows, then the most recent date among equals.
async function deduplicateLeadEvents(sheets) {
  let r;
  try {
    r = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${EVENTS_TAB}!A:J`,
    });
  } catch { return; }

  const rows = r.data.values || [];
  if (rows.length <= 1) return;

  const dataRows = rows.slice(1);
  const emailBest = {}; // email → best row
  const noEmail   = []; // rows without a real email (keep as-is)
  let invalidCount = 0;

  let correctedCount = 0;

  for (const row of dataRows) {
    let email = (row[8] || '').toLowerCase().trim();
    if (email.startsWith('email:')) email = email.slice(6);
    if (!email || !email.includes('@')) { noEmail.push(row); continue; }

    if (!isValidEmail(email)) {
      const corrected = correctEmail(email);
      if (corrected) {
        // Keep the row with the corrected email; clear verified so re-attribution re-checks it
        const fixed = [...row];
        fixed[8] = corrected;
        fixed[9] = 'NO';
        email = corrected;
        correctedCount++;
        console.log(`Dedup: corrected email typo ${row[8]} → ${corrected}`);
        if (!emailBest[email]) {
          emailBest[email] = fixed;
        } else {
          // Prefer any existing YES-verified row over the corrected one
          const prev = emailBest[email];
          if ((prev[9] || '') !== 'YES') emailBest[email] = fixed;
        }
      } else {
        invalidCount++;
        console.log(`Dedup: dropped uncorrectable email ${row[8]}`);
      }
      continue;
    }

    if (!emailBest[email]) {
      emailBest[email] = row;
    } else {
      const prev        = emailBest[email];
      const prevYes     = (prev[9] || '')  === 'YES';
      const curYes      = (row[9]  || '')  === 'YES';
      const prevDate    = prev[1] || '';
      const curDate     = row[1]  || '';
      // Prefer YES; among ties prefer more recent date
      if ((!prevYes && curYes) || (prevYes === curYes && curDate > prevDate)) {
        emailBest[email] = row;
      }
    }
  }

  const deduped = [...Object.values(emailBest), ...noEmail];
  const removed = dataRows.length - deduped.length - invalidCount - correctedCount;
  if (!removed && !invalidCount && !correctedCount) return;
  if (invalidCount)   console.log(`Dedup: dropped ${invalidCount} row(s) with uncorrectable emails`);
  if (correctedCount) console.log(`Dedup: corrected ${correctedCount} email typo(s) — re-attribution will verify`);

  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${EVENTS_TAB}!A2:J` });
  if (deduped.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${EVENTS_TAB}!A2`,
      valueInputOption: 'RAW', requestBody: { values: deduped },
    });
  }
  console.log(`Dedup: removed ${removed} duplicate lead row(s)`);
}

// ── Re-attribution: refresh adset IDs in Lead Events from current Hyros data ──
// Hyros continuously re-attributes leads using last-click logic. This function
// re-queries Hyros for every known email in Lead Events and updates any adset
// IDs that have shifted since the row was originally written.
async function reattributeLeadEvents(sheets) {
  // Read all Lead Events rows
  let r;
  try {
    r = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${EVENTS_TAB}!A:J`,
    });
  } catch { return; }

  const rows = r.data.values || [];
  if (rows.length <= 1) return; // no data rows

  const dataRows = rows.slice(1).map(row => [...row]); // deep copy

  // Build email → [row indices] map — only for rows that have NO adset yet.
  // Rows that already have an adset (set from GHL's fbc_id at backfill time) are
  // intentionally left alone. Hyros's UI counts leads by the adset they originally
  // submitted through (GHL fbc_id), not by their current last-click — overwriting
  // these would move leads between adsets and cause counts to diverge from Hyros.
  const emailRows = {};
  for (let i = 0; i < dataRows.length; i++) {
    const adset = (dataRows[i][2] || '').trim();
    if (adset) continue; // already attributed — do not overwrite
    let raw = (dataRows[i][8] || '').toLowerCase().trim();
    if (raw.startsWith('email:')) raw = raw.slice(6);
    if (raw && raw.includes('@')) {
      if (!emailRows[raw]) emailRows[raw] = [];
      emailRows[raw].push(i);
    }
  }

  const emails = Object.keys(emailRows);
  if (!emails.length) {
    console.log('Re-attribution: all rows already have adsets, nothing to fill');
    return;
  }

  console.log(`Re-attribution: querying Hyros for ${emails.length} unattributed lead emails…`);
  const freshAdsets = await hyrosAdsetsByEmail(emails);

  let changed = 0;
  for (const [email, indices] of Object.entries(emailRows)) {
    const newAdsetId = freshAdsets[email];
    if (!newAdsetId) continue;
    for (const idx of indices) {
      while (dataRows[idx].length < 10) dataRows[idx].push('');
      dataRows[idx][2] = newAdsetId;
      dataRows[idx][9] = 'YES';
      changed++;
    }
  }

  if (!changed) {
    console.log('Re-attribution: no adset changes found');
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${EVENTS_TAB}!A2`,
    valueInputOption: 'RAW',
    requestBody: { values: dataRows },
  });
  console.log(`Re-attribution: updated ${changed} lead row(s)`);
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

    // 2. Clean up duplicate emails from overlapping CSV uploads
    await deduplicateLeadEvents(sheets);

    // 3. Re-attribute Lead Events from current Hyros last-click data; mark DROPPED
    //    if Hyros no longer recognises a lead (removes overcount)
    await reattributeLeadEvents(sheets);

    // 4. Read all stage events from sheet (now deduped + re-attributed)
    const leadsFromSheet = await getLeadsFromSheet(sheets);

    // 5. Fetch spend per day from Hyros attribution API; merge with Lead Events for lead counts
    const dailyData = {};
    for (const dateStr of allDates) {
      const attrByAdset = await fetchCostForDay(dateStr);
      dailyData[dateStr] = {};
      for (const [id, data] of Object.entries(attrByAdset)) {
        dailyData[dateStr][id] = { leads: leadsFromSheet[dateStr]?.[id] || 0, cost: data.cost || 0 };
      }
      // Include adsets that have leads in sheet but no spend that day
      for (const [id, count] of Object.entries(leadsFromSheet[dateStr] || {})) {
        if (!dailyData[dateStr][id]) dailyData[dateStr][id] = { leads: count, cost: 0 };
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
  const emailSet = new Set(emails.map(e => e.toLowerCase()));

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
        const returnedEmail = (lead.email || '').toLowerCase().trim();
        const adsetId = lead.lastSource?.adSource?.adSourceId;
        if (!returnedEmail || !adsetId) continue;
        // Hyros may return the email it has stored (possibly a typo) rather than
        // the email we queried with. Normalise back to the queried email so that
        // ghlMap lookups succeed.
        let useEmail = returnedEmail;
        if (!emailSet.has(returnedEmail)) {
          const corrected = correctEmail(returnedEmail);
          if (corrected && emailSet.has(corrected)) useEmail = corrected;
        }
        if (!emailToAdset[useEmail]) emailToAdset[useEmail] = adsetId;
      }
    }
  }

  return emailToAdset;
}

// Extract the Facebook adset ID from Hyros attribution tags.
// Hyros encodes attribution as "@<adset-name>-<adsetId>" where adsetId is a long numeric string.
function adsetFromTags(tags) {
  for (const tag of tags || []) {
    if (!tag.startsWith('@')) continue;
    const m = tag.match(/-(\d{15,})$/);
    if (m) return m[1];
  }
  return '';
}

// Fetch all Hyros leads from a date range (paginated, up to 5000 leads).
// Only returns leads tagged "!qualified-lead" — this is exactly what Hyros UI counts.
// Adset ID is read from the "@<name>-<id>" attribution tag, matching Hyros's own display logic.
async function fetchAllHyrosLeads(fromDate, toDate) {
  const key        = process.env.HYROS_API_KEY;
  const QUAL_TAG   = process.env.HYROS_LEAD_TAG || '!qualified-lead';
  const leads      = [];
  let pageId       = null;
  let page         = 0;
  let totalFetched = 0;
  do {
    page++;
    const params = new URLSearchParams({ fromDate, toDate, pageSize: 100 });
    if (pageId) params.set('pageId', pageId);
    try {
      const r    = await fetch(`${HYROS_BASE}/leads?${params}`, { headers: { 'API-Key': key } });
      const data = await r.json();
      if (!Array.isArray(data.result)) { console.warn('fetchAllHyrosLeads page error:', data.message); break; }
      totalFetched += data.result.length;
      for (const lead of data.result) {
        const email = (lead.email || '').toLowerCase().trim();
        if (!email) continue;
        // Only count leads Hyros has marked as qualified (filters out click-only pixel captures)
        if (!( lead.tags || []).includes(QUAL_TAG)) continue;
        // Read adset from attribution tag — matches exactly what Hyros UI shows per adset
        const adsetId = adsetFromTags(lead.tags) || lead.firstSource?.adSource?.adSourceId || '';
        leads.push({ email, leadId: lead.id || '', adsetId });
      }
      pageId = data.nextPageId || null;
      if (pageId) await delay(400);
    } catch (e) { console.warn('fetchAllHyrosLeads error:', e.message); break; }
  } while (pageId && page < 50);
  console.log(`fetchAllHyrosLeads: ${leads.length} qualified leads out of ${totalFetched} total (${page} page(s))`);
  return leads;
}

// Extract US state abbreviation from a Hyros category (string or {name} object).
function stateFromCategory(category) {
  const str = (typeof category === 'object' ? (category?.name || '') : (category || ''));
  const m   = str.toUpperCase().match(/\b(WA|TX|CA|FL|NY|IL|PA|OH|GA|NC|MI|NJ|VA|AZ|TN|AL|LA|CO|IN|MO|MD|WI|MN|SC|KY|OR|OK|CT|NV|NM|MS|AR|IA|UT|KS|NE|WV|ID|HI|NH|ME|MT|RI|DE|SD|ND|AK|VT|WY|DC)\b/);
  return m ? m[1].toLowerCase() : '';
}

// Like fetchAllHyrosLeads but with NO tag filter — every lead with an email is returned.
// Also captures date (creationDate) and state (from firstSource.category) for each lead.
async function fetchAllHyrosLeadsUnfiltered(fromDate, toDate) {
  const key   = process.env.HYROS_API_KEY;
  const leads = [];
  let pageId  = null, page = 0, totalFetched = 0;
  do {
    page++;
    const params = new URLSearchParams({ fromDate, toDate, pageSize: 100 });
    if (pageId) params.set('pageId', pageId);
    try {
      const r    = await fetch(`${HYROS_BASE}/leads?${params}`, { headers: { 'API-Key': key } });
      const data = await r.json();
      if (!Array.isArray(data.result)) { console.warn('fetchAllHyrosLeadsUnfiltered error:', data.message); break; }
      totalFetched += data.result.length;
      for (const lead of data.result) {
        const email = (lead.email || '').toLowerCase().trim();
        if (!email) continue;
        // Use Hyros @attribution tags — the first @tag is the adset active at conversion time
        // (when the lead hit the thank-you page). lastSource.adSource.adSourceId can be a
        // post-conversion click adset that should NOT get credit, so we ignore it here.
        const adsetId = adsetFromTags(lead.tags)
          || lead.firstSource?.adSource?.adSourceId
          || '';
        // UTCClickDate is unreliable (Hyros API bug). clickDate is the actual last-click date.
        const rawDate = lead.lastSource?.clickDate || lead.creationDate || lead.dateAdded || '';
        const date    = rawDate ? isoDatePT(new Date(rawDate)) : fromDate;
        const state   = stateFromCategory(lead.lastSource?.category || lead.firstSource?.category || '');
        leads.push({ email, leadId: lead.id || '', adsetId, date, state });
      }
      pageId = data.nextPageId || null;
      if (pageId) await delay(400);
    } catch (e) { console.warn('fetchAllHyrosLeadsUnfiltered error:', e.message); break; }
  } while (pageId && page < 50);
  console.log(`fetchAllHyrosLeadsUnfiltered: ${leads.length} leads with email out of ${totalFetched} total (${page} page(s))`);
  return leads;
}

// Returns click data for a Hyros lead: fbclids, /next-steps presence, last click date, adset ID.
async function fetchLeadClickData(email) {
  const key    = process.env.HYROS_API_KEY;
  const p      = new URLSearchParams({ email, pageSize: 50 });
  // sessionDates: adsetId → date of first /next-steps in that adset's session
  // conversionDate: fallback — first /next-steps overall
  // sessionDates: adsetId → date of first /next-steps in that adset's session
  // conversionDate: first /next-steps overall (clicks are oldest-first)
  // lastConversionDate: most recent /next-steps overall (used when adsetId key mismatches)
  const result = { hasNextSteps: false, fbclids: [], adsetId: '', conversionDate: '', lastConversionDate: '', sessionDates: {} };
  try {
    const r    = await fetch(`${HYROS_BASE}/leads/clicks?${p}`, { headers: { 'API-Key': key } });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { return result; }
    let currentSessionAdset = '';
    for (const click of data.result || []) {
      const fbclid = click.parsedParameters?.fbclid;
      if (fbclid) result.fbclids.push(fbclid);
      const clickAdset = click.parsedParameters?.fbc_id || click.adSpendId || '';
      if (clickAdset) {
        result.adsetId = clickAdset;
        currentSessionAdset = clickAdset;
      }
      if ((click.trackedUrl || '').includes('/next-steps')) {
        result.hasNextSteps = true;
        if (click.date) {
          try {
            const dateStr = isoDatePT(new Date(click.date));
            if (currentSessionAdset && !result.sessionDates[currentSessionAdset]) {
              result.sessionDates[currentSessionAdset] = dateStr;
            }
            if (!result.conversionDate) result.conversionDate = dateStr;
            result.lastConversionDate = dateStr; // always overwrite → most recent (clicks are oldest-first)
          } catch { /* ignore */ }
        }
      }
    }
  } catch { /* ignore */ }
  return result;
}

// Kept for use by runBackfillFbclid
async function fetchLeadFbclids(email) {
  return (await fetchLeadClickData(email)).fbclids;
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

    const toInsert = [], noHyros = [], noState = [], skipped = [], nameMismatches = [];
    for (const email of Object.keys(hyrosAdsets)) {
      const ghl = ghlMap[email];
      if (!ghl || !ghl.state) { noState.push(email); continue; }
      if (append && existingEmails.has(email)) { skipped.push(email); continue; }

      const adsetId = ghl.adsetId || hyrosAdsets[email];
      if (!adsetId) continue;

      if (hasNameEmailMismatch(ghl.firstName, ghl.lastName, email)) {
        nameMismatches.push({ email, name: `${ghl.firstName || ''} ${ghl.lastName || ''}`.trim() });
        console.warn(`[backfill] name/email mismatch: "${ghl.firstName} ${ghl.lastName}" → ${email}`);
      }

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
        nameMismatches: nameMismatches.length,
        nameMismatchSample: nameMismatches.slice(0, 5),
      },
    };
  } catch (e) {
    _backfill = { running: false, done: true, result: null, error: String(e) };
  }
}

// ── fbclid-based backfill ─────────────────────────────────────────────────────
// Pulls ALL Hyros leads for the period, fetches each lead's click fbclids,
// matches against the GHL CSV contacts (keyed by fbclid from their URL field),
// and only inserts leads present in BOTH systems.  GHL validates realness;
// Hyros provides first-touch adset attribution.
async function runBackfillFbclid(ghlContacts, append = false) {
  _backfill = { running: true, done: false, result: null, error: null };
  try {
    // Build two GHL lookup maps:
    //   fbclidToGhl — keyed by ?fbclid= from the URL field (primary match)
    //   emailToGhl  — keyed by email (fallback: confirms lead is real even when fbclids differ)
    const fbclidToGhl = {};
    const emailToGhl  = {};
    for (const c of ghlContacts) {
      if (c.fbclid && !fbclidToGhl[c.fbclid]) fbclidToGhl[c.fbclid] = c;
      if (c.email  && !emailToGhl[c.email])   emailToGhl[c.email]   = c;
    }
    const ghlFbclidCount = Object.keys(fbclidToGhl).length;
    console.log(`Backfill fbclid: ${ghlFbclidCount} GHL contacts with fbclid, ${ghlContacts.length - ghlFbclidCount} without`);

    if (!ghlFbclidCount && !Object.keys(emailToGhl).length) {
      _backfill = { running: false, done: true, error: null, result: { ok: false, message: 'No GHL contacts found in CSV' } };
      return;
    }

    // Fetch all Hyros leads for the full date range
    const today      = isoToday();
    const hyrosLeads = await fetchAllHyrosLeads(START_DATE, today);
    if (!hyrosLeads.length) {
      _backfill = { running: false, done: true, error: null, result: { ok: true, inserted: 0, hyrosLeads: 0, message: 'No Hyros leads found in date range' } };
      return;
    }

    const auth   = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });
    await ensureEventsTab(sheets);

    // Load existing dedup keys (fbclid or email:X) to skip in append mode
    let existingKeys = new Set();
    if (append) {
      try {
        const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${EVENTS_TAB}!I:I` });
        existingKeys = new Set((r.data.values || []).flat().filter(Boolean));
      } catch { /* tab may not exist */ }
    }

    // For each Hyros lead, fetch their click fbclids and check for a GHL match.
    // Primary:  fbclid match — most reliable, confirms same click event
    // Fallback: email match  — catches real leads where GHL URL lacked ?fbclid=
    //           (click-only Hyros leads can't sneak in here because they're not in GHL)
    const CONCURRENCY = 5;
    const toInsert = [], notInGhl = [], noFbclid = [];
    let fbclidMatches = 0, emailFallbackMatches = 0;

    for (let i = 0; i < hyrosLeads.length; i += CONCURRENCY) {
      const batch      = hyrosLeads.slice(i, i + CONCURRENCY);
      const batchClicks = await Promise.all(batch.map(lead => fetchLeadFbclids(lead.email)));

      for (let j = 0; j < batch.length; j++) {
        const lead        = batch[j];
        const clickFbclids = batchClicks[j];

        // ── Primary: fbclid match ──────────────────────────────────────────
        let matchedFbclid = null, matchedGhl = null, matchMethod = '';
        for (const fc of clickFbclids) {
          if (fbclidToGhl[fc]) { matchedFbclid = fc; matchedGhl = fbclidToGhl[fc]; matchMethod = 'fbclid'; break; }
        }

        // ── Fallback: email match (validates lead is real — in GHL) ────────
        if (!matchedGhl) {
          const hyrosEmail   = lead.email;
          let   ghlByEmail   = emailToGhl[hyrosEmail];
          if (!ghlByEmail) {
            // Try correcting a potential Hyros-side email typo
            const corrected = correctEmail(hyrosEmail);
            if (corrected) ghlByEmail = emailToGhl[corrected];
          }
          if (ghlByEmail) {
            // Use the GHL contact's fbclid as the dedup key, or fall back to email:prefix
            matchedGhl    = ghlByEmail;
            matchedFbclid = ghlByEmail.fbclid || `email:${ghlByEmail.email}`;
            matchMethod   = 'email';
          }
        }

        if (!matchedGhl) {
          // Not in GHL at all — click-only Hyros lead, skip
          if (!clickFbclids.length) noFbclid.push(lead.email);
          else                      notInGhl.push(lead.email);
          continue;
        }

        if (append && existingKeys.has(matchedFbclid)) continue;

        // Attribution priority: Hyros firstSource > GHL fbc_id
        const adsetId = lead.adsetId || matchedGhl.adsetId;
        if (!adsetId) continue;

        toInsert.push([
          new Date().toISOString(),
          matchedGhl.date,
          adsetId,
          matchedGhl.state,
          matchedGhl.campaign   || '',
          matchedGhl.campaignId || '',
          matchedGhl.adId       || '',
          '',
          matchedFbclid,
          'YES',
        ]);
        existingKeys.add(matchedFbclid);
        if (matchMethod === 'fbclid') fbclidMatches++;
        else                          emailFallbackMatches++;
      }

      if (i + CONCURRENCY < hyrosLeads.length) await delay(500);
    }

    // Write to sheet
    if (!append) {
      await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${EVENTS_TAB}!A2:Z` });
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
        ok:                   true,
        hyrosLeads:           hyrosLeads.length,
        ghlWithFbclid:        ghlFbclidCount,
        inserted:             toInsert.length,
        fbclidMatches,
        emailFallbackMatches,
        notInGhl:             notInGhl.length,
        noFbclidInHyros:      noFbclid.length,
        notInGhlSample:       notInGhl.slice(0, 5),
        noFbclidSample:       noFbclid.slice(0, 5),
      },
    };
    console.log(`Backfill fbclid done: ${toInsert.length} inserted (${fbclidMatches} fbclid, ${emailFallbackMatches} email fallback), ${notInGhl.length} not in GHL, ${noFbclid.length} no fbclid in Hyros`);
  } catch (e) {
    console.error('runBackfillFbclid error:', e.message);
    _backfill = { running: false, done: true, result: null, error: String(e) };
  }
}

// ── /next-steps backfill ──────────────────────────────────────────────────────
// The Hyros pixel fires on /next-steps (confirmation page) only for real form
// submissions. Click-only / partial-entry leads never reach it.
// Strategy: fetch ALL Hyros leads → check each lead's click history for a
// /next-steps trackedUrl → only those are real → insert into Lead Events.
// No GHL CSV required; adset comes from Hyros @attribution tag.
async function runBackfillNextSteps(append = false) {
  _backfill = { running: true, done: false, result: null, error: null };
  try {
    const today = isoToday();

    // Fetch all Hyros leads without any tag filter
    const hyrosLeads = await fetchAllHyrosLeadsUnfiltered(START_DATE, today);
    if (!hyrosLeads.length) {
      _backfill = { running: false, done: true, error: null, result: { ok: true, inserted: 0, hyrosLeads: 0, message: 'No Hyros leads found in date range' } };
      return;
    }

    const auth   = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });
    await ensureEventsTab(sheets);

    // Load existing dedup keys in append mode
    let existingKeys = new Set();
    if (append) {
      try {
        const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${EVENTS_TAB}!I:I` });
        existingKeys = new Set((r.data.values || []).flat().filter(Boolean));
      } catch { /* tab may not exist */ }
    }

    // Load webhook cache so fbclids from click data can be resolved to adset IDs
    await loadFbclidCache(sheets);

    const CONCURRENCY = 5;
    const toInsert = [];
    let nextStepsCount = 0, skippedCount = 0, noAdsetCount = 0;

    for (let i = 0; i < hyrosLeads.length; i += CONCURRENCY) {
      const batch          = hyrosLeads.slice(i, i + CONCURRENCY);
      const batchClickData = await Promise.all(batch.map(lead => fetchLeadClickData(lead.email)));

      for (let j = 0; j < batch.length; j++) {
        const lead      = batch[j];
        const clickData = batchClickData[j];

        if (!clickData.hasNextSteps) continue;
        nextStepsCount++;

        // Attribution priority:
        //   1. Hyros @tag (most reliable — matches Hyros UI)
        //   2. firstSource/lastSource adSource from lead object
        //   3. fbc_id / adSpendId from click URL params
        //   4. Webhook cache: fbclid → adsetId (Hyros resolves fbclid at webhook time)
        const webhookAdset = clickData.fbclids.reduce((found, fc) => found || _fbclidCache.get(fc) || '', '');
        const adsetId = lead.adsetId || clickData.adsetId || webhookAdset;
        if (!adsetId) { noAdsetCount++; continue; }

        // Prefer first fbclid as dedup key; fall back to email: prefix
        const dedupKey = clickData.fbclids[0] || `email:${lead.email}`;
        if (append && existingKeys.has(dedupKey)) { skippedCount++; continue; }

        // Date priority:
        // 1. sessionDates[adsetId] — exact: /next-steps in the conversion adset's session
        // 2. lastConversionDate — most recent /next-steps overall (oldest-first iteration)
        // 3. conversionDate — first /next-steps ever
        // 4. lead.date — lastSource.clickDate, last resort only (may be from post-conversion session)
        const conversionDate = clickData.sessionDates?.[adsetId] || clickData.lastConversionDate || clickData.conversionDate || lead.date;
        toInsert.push([
          new Date().toISOString(),
          conversionDate,
          adsetId,    // lastSource adset ID
          lead.state, // parsed from firstSource.category (e.g. "wa", "tx")
          '',           // campaign name
          '',           // campaign ID
          '',           // ad ID
          '',           // ad name
          dedupKey,     // fbclid or email: dedup key
          'YES',        // Hyros verified
        ]);
        existingKeys.add(dedupKey);
      }

      if ((i + CONCURRENCY) % 50 === 0) console.log(`  /next-steps backfill: checked ${Math.min(i + CONCURRENCY, hyrosLeads.length)}/${hyrosLeads.length} leads, ${nextStepsCount} real so far`);
      if (i + CONCURRENCY < hyrosLeads.length) await delay(500);
    }

    if (!append) {
      await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${EVENTS_TAB}!A2:Z` });
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
        ok:                  true,
        hyrosLeads:          hyrosLeads.length,
        realLeads:           nextStepsCount,
        inserted:            toInsert.length,
        skippedDuplicate:    skippedCount,
        noAdset:             noAdsetCount,
      },
    };
    console.log(`Backfill next-steps done: ${toInsert.length} inserted (${nextStepsCount} real leads found out of ${hyrosLeads.length} total)`);
  } catch (e) {
    console.error('runBackfillNextSteps error:', e.message);
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
  const firstIdx  = col('first name');
  const lastIdx   = col('last name');

  if (emailIdx < 0 || stateIdx < 0) {
    return res.status(400).json({ ok: false, error: 'Could not find email or state columns', headers });
  }

  const contacts = [], invalidEmailRows = [];
  for (const row of rows.slice(1)) {
    const rawEmail = (row[emailIdx]  || '').toLowerCase().trim();
    const state    = (row[stateIdx]  || '').toLowerCase().trim();
    const fbclid   = (row[fbclidIdx] || '').trim();
    const raw      = (row[dateIdx]   || '').trim();
    const date     = raw.slice(0, 10);
    const firstName = firstIdx >= 0 ? (row[firstIdx] || '').trim() : '';
    const lastName  = lastIdx  >= 0 ? (row[lastIdx]  || '').trim() : '';
    if (!rawEmail || !state || !date) continue;

    // Parse URL for adset/ad/campaign IDs (needed for all contacts, valid or corrected)
    let adsetId = '', adId = '', campaignId = '', campaign = '', urlFbclid = '';
    const rawUrl = urlIdx >= 0 ? (row[urlIdx] || '').trim() : '';
    if (rawUrl) {
      try {
        const u = new URL(rawUrl);
        adsetId    = u.searchParams.get('fbc_id')       || '';
        adId       = u.searchParams.get('h_ad_id')      || '';
        campaignId = u.searchParams.get('utm_id')       || '';
        campaign   = u.searchParams.get('utm_campaign') || '';
        urlFbclid  = u.searchParams.get('fbclid')       || '';
      } catch { /* malformed URL */ }
    }

    if (!isValidEmail(rawEmail)) {
      const corrected = correctEmail(rawEmail);
      if (corrected) {
        contacts.push({ email: corrected, state, fbclid: urlFbclid || fbclid, date, adsetId, adId, campaignId, campaign, firstName, lastName, correctedFrom: rawEmail });
        invalidEmailRows.push(`${rawEmail} → ${corrected}`);
      } else {
        invalidEmailRows.push(rawEmail);
      }
      continue;
    }

    contacts.push({ email: rawEmail, state, fbclid: urlFbclid || fbclid, date, adsetId, adId, campaignId, campaign, firstName, lastName });
  }

  if (!contacts.length) {
    const msg = invalidEmailRows.length
      ? `No valid contacts found — ${invalidEmailRows.length} row(s) had invalid emails`
      : 'No contacts with state found in CSV';
    return res.json({ ok: false, error: msg, invalidEmailSample: invalidEmailRows.slice(0, 10) });
  }

  const withFbclid    = contacts.filter(c => c.fbclid);
  const withoutFbclid = contacts.filter(c => !c.fbclid);

  // Dry run: show CSV parsing stats; Hyros matching happens only in real run
  if (dryRun) {
    const sample = withFbclid.slice(0, 5).map(c => ({
      email: c.email, fbclid: c.fbclid, state: c.state, date: c.date, adsetId: c.adsetId,
    }));
    return res.json({
      dryRun:        true,
      mode:          'fbclid',
      totalInCsv:    contacts.length + invalidEmailRows.length,
      validContacts: contacts.length,
      invalidEmails: invalidEmailRows.length,
      invalidEmailSample: invalidEmailRows.slice(0, 10),
      withFbclid:    withFbclid.length,
      withoutFbclid: withoutFbclid.length,
      note: 'Real run pulls all Hyros leads, fetches each lead\'s click fbclids, and matches against GHL fbclids — contacts without fbclid are skipped',
      sample,
    });
  }

  // Real run: respond immediately, process fbclid matching in background
  const append = req.query.append === 'true';
  if (_backfill.running) return res.json({ ok: false, error: 'Backfill already running' });
  _backfill = { running: true, done: false, result: null, error: null };
  res.json({ ok: true, status: 'started', mode: 'fbclid', totalContacts: contacts.length, withFbclid: withFbclid.length, append, pollUrl: '/api/hyros/backfill-status' });
  runBackfillFbclid(contacts, append);
});

router.get('/backfill-status', (_req, res) => res.json(_backfill));

// POST /api/hyros/backfill-next-steps[?append=true]
// Fetches all Hyros leads, checks each for /next-steps in click history (= real submission),
// and writes matching leads to Lead Events. No GHL CSV needed.
router.post('/backfill-next-steps', (req, res) => {
  if (_backfill.running) return res.json({ ok: false, error: 'Backfill already running' });
  const append = req.query.append === 'true';
  res.json({ ok: true, status: 'started', mode: 'next-steps', append, pollUrl: '/api/hyros/backfill-status' });
  runBackfillNextSteps(append);
});

// GET /api/hyros/hyros-probe?email=x&fbclid=y — probe Hyros lookup methods
router.get('/hyros-probe', async (req, res) => {
  const key = process.env.HYROS_API_KEY;
  const headers = { 'API-Key': key };
  const out = {};
  try {
    if (req.query.email) {
      const p = new URLSearchParams({ emails: `"${req.query.email}"` });
      out.emailResult = await (await fetch(`${HYROS_BASE}/leads?${p}`, { headers })).json();
    }
    if (req.query.email) {
      // Get click history for this lead — each click has adSourceClickId = fbclid
      const p = new URLSearchParams({ email: req.query.email, pageSize: 10 });
      const safeJson = async (r) => { try { return await r.json(); } catch { return { raw: (await r.text().catch(() => '?')).slice(0, 300) }; } };
      out.leadClicks = await safeJson(await fetch(`${HYROS_BASE}/leads/clicks?${p}`, { headers }));
      // Also get lead journey
      if (out.emailResult?.result?.[0]?.id) {
        const id = out.emailResult.result[0].id;
        out.journey = await safeJson(await fetch(`${HYROS_BASE}/leads/journey?ids=${id}`, { headers }));
      }
    }
    res.json(out);
  } catch (e) { res.json({ error: String(e) }); }
});

// GET /api/hyros/probe-no-adset — fetch leads with no adset ID, show raw fields for debugging
router.get('/probe-no-adset', async (req, res) => {
  const key   = process.env.HYROS_API_KEY;
  const from  = req.query.from || START_DATE;
  const to    = req.query.to   || isoToday();
  const noAdset = [];
  let pageId = null, page = 0;
  do {
    page++;
    const params = new URLSearchParams({ fromDate: from, toDate: to, pageSize: 100 });
    if (pageId) params.set('pageId', pageId);
    try {
      const r    = await fetch(`${HYROS_BASE}/leads?${params}`, { headers: { 'API-Key': key } });
      const data = await r.json();
      if (!Array.isArray(data.result)) break;
      for (const lead of data.result) {
        const email = (lead.email || '').trim();
        if (!email) continue;
        const adsetId = lead.lastSource?.adSource?.adSourceId
          || lead.firstSource?.adSource?.adSourceId
          || '';
        if (!adsetId) {
          noAdset.push({
            email,
            tags: lead.tags,
            firstSourceAdSource: lead.firstSource?.adSource,
            lastSourceAdSource:  lead.lastSource?.adSource,
            firstSourceCategory: lead.firstSource?.category,
            firstSourceName:     lead.firstSource?.name,
          });
        }
      }
      pageId = data.nextPageId || null;
      if (pageId) await delay(300);
    } catch (e) { return res.json({ error: String(e) }); }
  } while (pageId && page < 50);
  res.json({ total: noAdset.length, sample: noAdset.slice(0, 10) });
});

// GET /api/hyros/probe-leads?from=YYYY-MM-DD&to=YYYY-MM-DD — raw first page of /leads
router.get('/probe-leads', async (req, res) => {
  const key   = process.env.HYROS_API_KEY;
  const from  = req.query.from || START_DATE;
  const to    = req.query.to   || isoToday();
  const params = new URLSearchParams({ fromDate: from, toDate: to, pageSize: 5 });
  try {
    const r    = await fetch(`${HYROS_BASE}/leads?${params}`, { headers: { 'API-Key': key } });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { return res.json({ raw: text.slice(0, 500) }); }
    res.json({ url: `${HYROS_BASE}/leads?${params}`, status: r.status, resultType: typeof data.result, resultIsArray: Array.isArray(data.result), resultLength: Array.isArray(data.result) ? data.result.length : null, message: data.message, nextPageId: data.nextPageId, sample: Array.isArray(data.result) ? data.result.slice(0, 2) : data.result });
  } catch (e) { res.json({ error: String(e) }); }
});

// GET /api/hyros/debug-lead-by-adset?adsetId=X — find a Hyros lead attributed to given adset, show raw fields
router.get('/debug-lead-by-adset', async (req, res) => {
  const adsetId = (req.query.adsetId || '').trim();
  if (!adsetId) return res.status(400).json({ error: 'adsetId required' });
  const key = process.env.HYROS_API_KEY;
  const today = isoToday();
  let pageId = null, page = 0;
  do {
    page++;
    const params = new URLSearchParams({ fromDate: START_DATE, toDate: today, pageSize: 100 });
    if (pageId) params.set('pageId', pageId);
    try {
      const r    = await fetch(`${HYROS_BASE}/leads?${params}`, { headers: { 'API-Key': key } });
      const data = await r.json();
      if (!Array.isArray(data.result)) return res.json({ error: data.message });
      for (const lead of data.result) {
        const ls = lead.lastSource?.adSource?.adSourceId || '';
        const fs = lead.firstSource?.adSource?.adSourceId || '';
        if (ls === adsetId || fs === adsetId) {
          return res.json({
            email:            lead.email,
            creationDate:     lead.creationDate,
            dateAdded:        lead.dateAdded,
            lastSource: {
              adSourceId:   lead.lastSource?.adSource?.adSourceId,
              clickDate:    lead.lastSource?.clickDate,
              UTCClickDate: lead.lastSource?.UTCClickDate,
              name:         lead.lastSource?.name,
            },
            firstSource: {
              adSourceId:   lead.firstSource?.adSource?.adSourceId,
              clickDate:    lead.firstSource?.clickDate,
              UTCClickDate: lead.firstSource?.UTCClickDate,
            },
            tags: lead.tags,
          });
        }
      }
      pageId = data.nextPageId || null;
      if (pageId) await delay(300);
    } catch (e) { return res.json({ error: e.message }); }
  } while (pageId && page < 50);
  res.json({ found: false, message: 'No lead found for this adset ID in range' });
});

// GET /api/hyros/debug-adset-info?ids=id1,id2 — get FB creation time + status for adset IDs
router.get('/debug-adset-info', async (req, res) => {
  const token = process.env.FB_ACCESS_TOKEN;
  const ids   = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  const result = {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk  = ids.slice(i, i + 50);
    const params = new URLSearchParams({ ids: chunk.join(','), fields: 'name,created_time,effective_status,campaign{name,id}', access_token: token });
    try {
      const r    = await fetch(`${FB_API}/?${params}`);
      const data = await r.json();
      if (!data.error) Object.assign(result, data);
      else result._error = data.error;
    } catch (e) { result._error = e.message; }
  }
  res.json(result);
});

// GET /api/hyros/debug-click-data?email=X
// Returns full fetchLeadClickData result + all raw click objects for an email.
router.get('/debug-click-data', async (req, res) => {
  const email = (req.query.email || '').trim();
  if (!email) return res.status(400).json({ error: 'email required' });
  const key = process.env.HYROS_API_KEY;
  const p   = new URLSearchParams({ email, pageSize: 50 });
  let rawClicks = [];
  try {
    const r    = await fetch(`${HYROS_BASE}/leads/clicks?${p}`, { headers: { 'API-Key': key } });
    const data = await r.json();
    rawClicks  = data.result || [];
  } catch (e) { return res.json({ error: e.message }); }
  const parsed = await fetchLeadClickData(email);
  res.json({ parsed, rawClicks });
});

// GET /api/hyros/debug-sheet-search?adsetNameContains=X&date=Y
// Finds Lead Events rows whose adset name contains the given string (FB lookup) on the given date.
// Also cross-references fbclid dedup keys against Webhook Cache to surface actual emails.
router.get('/debug-sheet-search', async (req, res) => {
  const nameHint = (req.query.adsetNameContains || '').toLowerCase();
  const dateHint = req.query.date || '';
  try {
    const auth   = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });
    // Load events tab
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${EVENTS_TAB}!A:J` });
    const rows = (r.data.values || []).slice(1);
    // Load webhook cache: fbclid → email
    const fbclidToEmail = {};
    try {
      const wc = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${WEBHOOK_TAB}!C:E` });
      for (const [fbclid, , email] of (wc.data.values || []).slice(1)) {
        if (fbclid && email && !fbclidToEmail[fbclid]) fbclidToEmail[fbclid] = email;
      }
    } catch { /* webhook cache may not exist */ }
    // Collect unique adset IDs and look up names
    const adsetIds = [...new Set(rows.map(row => row[2]).filter(Boolean))];
    const info = await getAdsetInfo(adsetIds);
    const matches = [];
    for (const row of rows) {
      const rowDate   = row[1] || '';
      const adsetId   = row[2] || '';
      const dedupKey  = row[8] || '';
      const verified  = row[9] || '';
      if (dateHint && rowDate !== dateHint) continue;
      const adsetName = info[adsetId]?.name || '';
      if (nameHint && !adsetName.toLowerCase().includes(nameHint)) continue;
      const email = dedupKey.startsWith('email:') ? dedupKey.slice(6)
                  : (fbclidToEmail[dedupKey] || '');
      matches.push({ date: rowDate, adsetId, adsetName, email, dedupKey, verified });
    }
    res.json({ matches });
  } catch (e) { res.json({ error: e.message }); }
});

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
  // Reject unresolved GHL template variables (e.g. {{adset.id}})
  const rawFbcId = (fbc_id || '').includes('{{') ? '' : (fbc_id || '');

  const now     = new Date();
  const dateStr = isoDatePT(now);

  try {
    const auth   = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    // Load Hyros webhook cache from sheet if not yet in memory
    await loadFbclidCache(sheets);

    // Resolve adset ID — prefer Hyros-verified lookup, fall back to URL fbc_id
    const hyrosAdsetId = _fbclidCache.get(fbclid);
    const adsetId      = hyrosAdsetId || rawFbcId;
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

// GET /api/hyros/probe-attr-fields?date=<YYYY-MM-DD>
// Probes Hyros attribution API with many candidate lead field names to find which one works.
router.get('/probe-attr-fields', async (req, res) => {
  const key     = process.env.HYROS_API_KEY;
  const headers = { 'API-Key': key };

  const dateStr = req.query.date || (() => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  const acct1 = '1125965718442560';
  const attrBase = `startDate=${dateStr}&endDate=${dateStr}&level=facebook_adset&attributionModel=last_click&isAdAccountId=true&ids=${acct1}`;

  // State abbreviations (custom goals per state), generic names, and common Hyros goal names
  const candidates = [
    'leads', 'lead', 'new_leads', 'total_leads',
    'qualified_lead', 'qualified_leads',
    'WA', 'TX', 'CA', 'FL', 'NY', 'IL', 'PA', 'OH', 'GA', 'NC', 'MI', 'NJ', 'VA', 'AZ', 'TN',
    'wa', 'tx', 'ca', 'fl', 'ny', 'il', 'pa', 'oh', 'ga', 'nc', 'mi', 'nj', 'va', 'az', 'tn',
    'opt_in', 'opt_ins', 'form_submit', 'form_submits',
    'intake', 'intakes', 'submission', 'submissions',
    'calls', 'appointments', 'conversions',
    'legal_intake', 'case_intake', 'accident_lead',
  ];

  const working = [], errors = [];
  for (const field of candidates) {
    try {
      const r    = await fetch(`${HYROS_BASE}/attribution?${attrBase}&fields=${field},cost`, { headers });
      const data = await r.json();
      if (data.result === 'ERROR') {
        errors.push({ field, message: data.message });
      } else if (Array.isArray(data.result)) {
        const total = data.result.reduce((s, row) => s + (row[field] || 0), 0);
        const sample = data.result.filter(r => r[field] > 0).slice(0, 3).map(row => ({ id: row.id, [field]: row[field], cost: row.cost }));
        working.push({ field, rows: data.result.length, total, sample });
      }
    } catch (e) { errors.push({ field, error: e.message }); }
    await delay(150);
  }

  res.json({ date: dateStr, working, errorCount: errors.length, errors: errors.slice(0, 5) });
});

// GET /api/hyros/probe-hyros-endpoints
// Tries many Hyros API endpoint paths to discover goals, events, tags, and custom fields.
router.get('/probe-hyros-endpoints', async (req, res) => {
  const key     = process.env.HYROS_API_KEY;
  const headers = { 'API-Key': key };

  const paths = [
    '/goals', '/goals/', '/goal',
    '/events', '/events/', '/event',
    '/conversions', '/conversion-goals', '/custom-conversions',
    '/tags', '/tags/', '/lead-tags',
    '/attribution/fields', '/attribution/metrics',
    '/metrics', '/fields',
    '/leads/tags', '/leads/goals',
    '/sources', '/ad-sources',
    '/custom-fields', '/settings', '/account',
  ];

  const results = {};
  for (const path of paths) {
    try {
      const r    = await fetch(`${HYROS_BASE}${path}`, { headers });
      const text = await r.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 300); }
      // Only include non-404/non-error responses
      const isError = typeof parsed === 'string' || parsed?.result === 'ERROR' || parsed?.message === 'Not found' || (Array.isArray(parsed?.message) && parsed.message[0]?.includes('not found'));
      if (!isError) results[path] = parsed;
      else          results[path] = { skipped: true, hint: typeof parsed === 'string' ? parsed.slice(0, 100) : parsed?.message };
    } catch (e) { results[path] = { error: e.message }; }
    await delay(150);
  }

  res.json(results);
});


// DELETE /api/hyros/cleanup-template-rows — remove rows where adset ID is an unresolved template variable
router.delete('/cleanup-template-rows', async (req, res) => {
  const auth   = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const meta   = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const tab    = meta.data.sheets.find(s => s.properties.title === EVENTS_TAB);
  if (!tab) return res.json({ ok: false, error: 'Lead Events tab not found' });
  const sheetId = tab.properties.sheetId;

  const data = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: `${EVENTS_TAB}!A:J`,
  });
  const rows = (data.data.values || []).slice(1);
  // Collect row indices (0-based from row 2) where adset ID contains '{{'
  const badIndices = rows
    .map((r, i) => ({ idx: i, adset: r[2] || '' }))
    .filter(({ adset }) => adset.includes('{{'))
    .map(({ idx }) => idx + 1); // +1 because sheet rows are 1-indexed after header

  if (!badIndices.length) return res.json({ ok: true, deleted: 0 });

  // Delete from bottom to top so row indices stay valid
  const requests = [...badIndices].reverse().map(rowIdx => ({
    deleteDimension: {
      range: { sheetId, dimension: 'ROWS', startIndex: rowIdx, endIndex: rowIdx + 1 },
    },
  }));
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
  res.json({ ok: true, deleted: badIndices.length, rows: badIndices });
});

// GET /api/hyros/investigate — audit Lead Events for bad rows, phantom adsets, missing leads
router.get('/investigate', async (req, res) => {
  const key    = process.env.HYROS_API_KEY;
  const auth   = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  // ── 1. Read Lead Events ────────────────────────────────────────────────────
  const sheetData = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: `${EVENTS_TAB}!A:J`,
  });
  const rows = (sheetData.data.values || []).slice(1); // skip header

  // ── 2. Find template rows + build adset→emails map ────────────────────────
  const templateRows = [];
  const adsetEmails  = {}; // adsetId → [{ date, email }]
  for (let i = 0; i < rows.length; i++) {
    const [, date, adsetId, , , , , , dedup] = rows[i];
    const email = (dedup || '').replace(/^email:/, '');
    if ((adsetId || '').includes('{{')) {
      templateRows.push({ sheetRow: i + 2, date, adsetId, email });
      continue;
    }
    if (!adsetEmails[adsetId]) adsetEmails[adsetId] = [];
    adsetEmails[adsetId].push({ date, email });
  }

  // ── 3. Phantom adset probe (our sheet has, Hyros won't know about) ─────────
  const PHANTOM_IDS = [
    '120244242304590070','120247680992620558','120244166158410070',
    '120246691916110558','120247147218960558','120247147759000558',
    '120244700465100070','120247679363450558','120247681013030558',
    '120247681752650558',
  ];
  const phantomProbe = {};
  for (const id of PHANTOM_IDS) {
    const entries = adsetEmails[id] || [];
    const probeResults = [];
    for (const { date, email } of entries.slice(0, 3)) {
      if (!email || email.startsWith('email:')) { probeResults.push({ date, email, hyrosAdset: 'no-email-key' }); continue; }
      try {
        const p = new URLSearchParams({ emails: `"${email}"` });
        const r = await fetch(`${HYROS_BASE}/leads?${p}`, { headers: { 'API-Key': key } });
        const d = await r.json();
        const lead = d.result?.[0];
        probeResults.push({
          date,
          email,
          hyrosLastAdset: lead?.lastSource?.adSource?.adSourceId || 'none',
          hyrosFirstAdset: lead?.firstSource?.adSource?.adSourceId || 'none',
          hyrosLastSourceName: lead?.lastSource?.name || '',
        });
      } catch { probeResults.push({ date, email, error: true }); }
      await delay(200);
    }
    phantomProbe[id] = probeResults;
  }

  // ── 4. Missing adset probe (Hyros has, we don't) ──────────────────────────
  const MISSING_IDS = [
    { id: '120243264294520070', date: '2026-04-14' },
    { id: '120246233317420558', date: '2026-04-14' },
    { id: '120246832674280558', date: '2026-04-14' },
    { id: '120243999587790070', date: '2026-04-15' },
    { id: '120246445934420558', date: '2026-04-15' },
    { id: '120244048636620070', date: '2026-04-17' },
    { id: '120247039691420558', date: '2026-04-18' },
  ];
  const missingProbe = [];
  for (const { id, date } of MISSING_IDS) {
    try {
      const p = new URLSearchParams({ fromDate: date, toDate: date, pageSize: 50 });
      const r = await fetch(`${HYROS_BASE}/leads?${p}`, { headers: { 'API-Key': key } });
      const d = await r.json();
      const matches = (d.result || []).filter(l =>
        l.lastSource?.adSource?.adSourceId === id || l.firstSource?.adSource?.adSourceId === id
      );
      for (const lead of matches.slice(0, 3)) {
        const clicks = await fetch(`${HYROS_BASE}/leads/clicks?${new URLSearchParams({ email: lead.email, pageSize: 20 })}`, { headers: { 'API-Key': key } });
        const cd = await clicks.json();
        const hasNS = (cd.result || []).some(c => (c.trackedUrl || '').includes('/next-steps'));
        missingProbe.push({ id, date, email: lead.email, hasNextSteps: hasNS,
          lastAdset: lead.lastSource?.adSource?.adSourceId, firstAdset: lead.firstSource?.adSource?.adSourceId });
        await delay(200);
      }
      if (!matches.length) missingProbe.push({ id, date, email: null, note: 'no leads found on this date' });
    } catch (e) { missingProbe.push({ id, date, error: String(e) }); }
    await delay(300);
  }

  res.json({ templateRows, phantomProbe, missingProbe,
    summary: { totalRows: rows.length, templateRowCount: templateRows.length } });
});

// Daily backfill + sync at 8:15am PT
let _lastDailyRunDate = '';
function runDailySchedule() {
  const now = new Date();
  const pt  = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', hour12: false,
  }).format(now).split(':');
  const todayPT = isoToday();
  if (parseInt(pt[0], 10) === 8 && parseInt(pt[1], 10) === 15 && todayPT !== _lastDailyRunDate) {
    _lastDailyRunDate = todayPT;
    (async () => {
      await runBackfillNextSteps(false);
      if (!_syncRunning) runSync();
    })().catch(e => console.error('[daily] error:', e.message));
  }
}
setInterval(runDailySchedule, 60 * 1000);

// GET /api/hyros/probe-adsets?ids=id1,id2 — return all Lead Events rows for given adset IDs, grouped by date
router.get('/probe-adsets', async (req, res) => {
  const ids    = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
  const key    = process.env.HYROS_API_KEY;
  const auth   = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const data = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: `${EVENTS_TAB}!A:J`,
  });
  const rows = (data.data.values || []).slice(1);

  // Group by adsetId → date → list of dedup keys
  const byAdset = {};
  for (const row of rows) {
    const [, date, adsetId, , , , , , dedup] = row;
    if (!ids.includes(adsetId)) continue;
    if (!byAdset[adsetId]) byAdset[adsetId] = {};
    if (!byAdset[adsetId][date]) byAdset[adsetId][date] = [];
    byAdset[adsetId][date].push(dedup || '');
  }

  // For each dedup key that's an fbclid (not email:...), resolve to email via Hyros
  const fbclidToEmail = {};
  const allFbclids = [];
  for (const dates of Object.values(byAdset))
    for (const keys of Object.values(dates))
      for (const k of keys)
        if (!k.startsWith('email:')) allFbclids.push(k);

  for (const fbclid of [...new Set(allFbclids)].slice(0, 40)) {
    try {
      const p = new URLSearchParams({ fbclid });
      const r = await fetch(`${HYROS_BASE}/leads/by-click?${p}`, { headers: { 'API-Key': key } });
      const d = await r.json();
      if (d.result?.email) fbclidToEmail[fbclid] = d.result.email;
    } catch { /* ignore */ }
    await delay(150);
  }

  // Annotate with resolved emails
  const result = {};
  for (const [adsetId, dates] of Object.entries(byAdset)) {
    result[adsetId] = {};
    for (const [date, keys] of Object.entries(dates)) {
      result[adsetId][date] = keys.map(k => ({
        dedup: k,
        email: k.startsWith('email:') ? k.slice(6) : (fbclidToEmail[k] || null),
      }));
    }
  }
  res.json(result);
});

export default router;
