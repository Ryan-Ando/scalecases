export const REPORT_TZ = 'America/Los_Angeles';

export function reportWindow(now = new Date()) {
  const end = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ }).format(now);
  const start = new Date(`${end}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 4);
  return { start: start.toISOString().slice(0, 10), end };
}

export function campaignTotals(rows, ledger, metadata = [], sortBy = 'fb') {
  const campaigns = new Map(), adsets = new Map();
  function campaign(row) {
    const name = row.campaign_name || row.campaignName;
    if (!name) return null;
    const key = row.campaign_id || row.campaignId || `${row.account || row.accountId || ''}:${name}`;
    if (!campaigns.has(key)) campaigns.set(key, { id: key, name, spend: 0, fbLeads: 0, hyLeads: 0 });
    return campaigns.get(key);
  }
  for (const row of rows) {
    const c = campaign(row);
    if (!c) throw new Error('Facebook returned spend without a campaign identity');
    c.spend += Number(row.spend) || 0;
    c.fbLeads += Number(row.results) || 0;
    adsets.set(String(row.adset_id), c);
  }
  // Include attributed leads on adsets with no spend during this window.
  for (const row of metadata) {
    if (!adsets.has(String(row.id))) {
      const c = campaign(row);
      if (c) adsets.set(String(row.id), c);
    }
  }
  let unmatched = 0;
  for (const [id, count] of Object.entries(ledger.windowByAdset)) {
    const c = adsets.get(String(id));
    if (c) c.hyLeads += count;
    else unmatched += count;
  }
  const result = [...campaigns.values()].filter(c => c.spend > 0 || c.fbLeads > 0 || c.hyLeads > 0);
  const leads = sortBy === 'hyros' ? 'hyLeads' : 'fbLeads';
  const cpl = c => c[leads] > 0 ? c.spend / c[leads] : Infinity;
  result.sort((a, b) => cpl(b) - cpl(a) || b.spend - a.spend || a.name.localeCompare(b.name));
  return { campaigns: result, unmatched };
}

export function formatCampaignReport({ campaigns, unmatched }, { start, end }, sortBy = 'fb') {
  const money = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const cpl = (spend, leads) => leads > 0 ? money(spend / leads) : 'N/A (0 leads)';
  return [
    `Campaign CPL | ${start} through ${end}`,
    '5 days: previous 4 days + today so far. Pacific time.',
    `Sorted by ${sortBy === 'hyros' ? 'Hyros' : 'Facebook'} CPL, highest first; zero-lead spend first.`,
    'CPL = total window spend / total window leads.',
    'Hyros = the bot\'s attributed /next-steps leads; both CPLs use Facebook spend.',
    '',
    ...campaigns.flatMap((c, i) => [
      `${i + 1}. ${c.name}`,
      `FB CPL ${cpl(c.spend, c.fbLeads)} | Hyros CPL ${cpl(c.spend, c.hyLeads)}`,
      `Spend ${money(c.spend)} | FB leads ${c.fbLeads} | Hyros leads ${c.hyLeads}`, '',
    ]),
    ...(campaigns.length ? [] : ['No campaign activity in this window.']),
    ...(unmatched ? [`Note: ${unmatched} Hyros leads could not be matched to a campaign and are excluded.`] : []),
  ].join('\n');
}

export function createCampaignSchedule({ run, load = () => ({}), save = () => {}, now = () => new Date(), enabled = () => true, notifyFailure = async () => {}, log = console }) {
  const state = { lastSuccessDate: null, nextRetryAt: 0, lastError: null, ...load(), running: false };
  async function tick() {
    const date = now(), { end } = reportWindow(date);
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: REPORT_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
    if (!enabled() || state.running || time < '06:30' || state.lastSuccessDate === end || date.getTime() < state.nextRetryAt) return;
    state.running = true;
    try {
      await run(date);
      state.lastSuccessDate = end;
      state.lastSuccessAt = now().toISOString();
      state.lastError = null;
      state.nextRetryAt = 0;
    } catch (error) {
      state.lastError = error.message;
      state.nextRetryAt = now().getTime() + 65 * 60_000;
      log.error('[campaign-cpl]', error.message);
      if (state.lastNoticeDate !== end) {
        try { await notifyFailure(); state.lastNoticeDate = end; }
        catch (noticeError) { log.error('[campaign-cpl] notice failed:', noticeError.message); }
      }
    } finally {
      state.running = false;
      try { save(state); } catch (error) { log.error('[campaign-cpl] checkpoint failed:', error.message); }
    }
  }
  return { tick, status: () => ({ ...state, enabled: enabled(), scheduledTime: '06:30', timezone: REPORT_TZ }) };
}
