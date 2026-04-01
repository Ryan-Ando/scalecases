import { useState } from 'react';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const AUDIT_DATE = '2026-03-28';
const LEAD_SUBTRACTIONS_LSKEY = 'lead_subtractions';

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

function extractState(campaignName) {
  if (!campaignName) return null;
  const tokens = campaignName.trim().split(/[-–—\s_/|]+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i].toUpperCase();
    if (US_STATES.has(t)) return t;
  }
  return null;
}

const LEAD_ACTION_TYPES = [
  'offsite_conversion.fb_pixel_lead',
  'onsite_conversion.lead_grouped',
  'contact', 'schedule', 'submit_application',
];

function extractLeads(actions = []) {
  for (const type of LEAD_ACTION_TYPES) {
    const a = actions.find(x => x.action_type === type);
    if (a) return parseInt(a.value, 10) || 0;
  }
  return 0;
}

function loadSubtractions() {
  try { return JSON.parse(localStorage.getItem(LEAD_SUBTRACTIONS_LSKEY) || '{}'); } catch { return {}; }
}

// Normalize ad name for fuzzy matching (lowercase, collapse spaces)
function norm(s) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

export default function LeadAudit() {
  const [rows, setRows]             = useState([]);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState('');
  const [trueLeads, setTrueLeads]   = useState({});  // key → string input value
  const [saved, setSaved]           = useState(false);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sheetError, setSheetError]     = useState('');
  const [sheetMeta, setSheetMeta]       = useState(null); // { matched, unmatched, totalRows, tab }

  async function fetchAuditData() {
    setLoading(true);
    setError('');
    setRows([]);
    setTrueLeads({});
    try {
      const res  = await fetch(`${BASE}/api/facebook/daily?date=${AUDIT_DATE}&full=true`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);

      // Group by adName|state to collapse any duplicate rows
      const grouped = {};
      for (const r of json) {
        const adName = (r.ad_name || '').trim();
        const state  = extractState(r.campaign_name);
        const leads  = extractLeads(r.actions);
        const spend  = parseFloat(r.spend) || 0;
        if (!adName) continue;
        const key = `${adName}|${state || '?'}`;
        if (!grouped[key]) grouped[key] = { adName, campaignName: r.campaign_name || '', state, fbLeads: 0, spend: 0 };
        grouped[key].fbLeads += leads;
        grouped[key].spend   += spend;
      }

      const sorted = Object.values(grouped)
        .filter(r => r.fbLeads > 0)        // only rows that reported leads
        .sort((a, b) => b.fbLeads - a.fbLeads);

      setRows(sorted);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadFromSheet() {
    if (!rows.length) { setSheetError('Fetch FB data first.'); return; }
    setSheetLoading(true);
    setSheetError('');
    setSheetMeta(null);
    try {
      const res  = await fetch(`${BASE}/api/sheets/lead-audit`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);

      const { leads, unmatched, tab, totalRows } = json;
      const next = { ...trueLeads };
      let matched = 0;

      for (const { state, utmContent, actualLeads } of leads) {
        // Find the FB row whose adName matches utm_content (exact then case-insensitive)
        const fbRow = rows.find(r =>
          r.state === state && (r.adName === utmContent || norm(r.adName) === norm(utmContent))
        );
        if (!fbRow) continue;
        const key = `${fbRow.adName}|${fbRow.state}`;
        // Sum in case multiple utm_content values map to the same fb ad
        const existing = parseInt(next[key] || '0', 10) || 0;
        next[key] = String(existing + actualLeads);
        matched++;
      }

      setTrueLeads(next);
      setSheetMeta({ matched, unmatched, totalRows, tab, sheetTotal: leads.length });
    } catch (e) {
      setSheetError(e.message);
    } finally {
      setSheetLoading(false);
    }
  }

  function setTrue(key, val) {
    setTrueLeads(prev => ({ ...prev, [key]: val }));
  }

  function applySubtractions() {
    const existing = loadSubtractions();
    const next = { ...existing };
    for (const row of rows) {
      const key    = `${row.adName}|${row.state}`;
      if (!row.state) continue; // can't key without a state
      const actual = parseInt(trueLeads[key] ?? '', 10);
      if (isNaN(actual)) continue;
      const overcount = Math.max(0, row.fbLeads - actual);
      if (overcount > 0) next[key] = (existing[key] || 0) + overcount;
      else delete next[key];
    }
    localStorage.setItem(LEAD_SUBTRACTIONS_LSKEY, JSON.stringify(next));
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  // Totals
  const totalFb    = rows.reduce((s, r) => s + r.fbLeads, 0);
  const totalTrue  = rows.reduce((s, r) => {
    const key = `${r.adName}|${r.state}`;
    const v = parseInt(trueLeads[key] ?? '', 10);
    return s + (isNaN(v) ? 0 : v);
  }, 0);
  const totalOver  = rows.reduce((s, r) => {
    const key = `${r.adName}|${r.state}`;
    const v   = parseInt(trueLeads[key] ?? '', 10);
    if (isNaN(v)) return s;
    return s + Math.max(0, r.fbLeads - v);
  }, 0);
  const anyTrue = Object.keys(trueLeads).some(k => trueLeads[k] !== '');

  // Styles
  const th = {
    padding: '8px 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.05em', color: 'var(--text-muted)', textAlign: 'left',
    background: 'var(--surface)', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap',
  };
  const thR = { ...th, textAlign: 'right' };
  const td  = { padding: '8px 12px', fontSize: 13, borderBottom: '1px solid var(--border)', color: 'var(--text)' };
  const tdR = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
  const inp = {
    width: 70, textAlign: 'right', padding: '4px 6px', fontSize: 13,
    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4,
    color: 'var(--text)', outline: 'none', fontVariantNumeric: 'tabular-nums',
  };

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1100 }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>
          Lead Audit — {AUDIT_DATE}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18 }}>
          Pull every ad's FB-reported leads for the 28th, enter the actual count from your sheet,
          and apply the difference as a permanent lead subtraction on the Ads Tracking tab.
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn" onClick={fetchAuditData} disabled={loading}>
            {loading ? 'Fetching…' : rows.length ? 'Re-fetch FB' : 'Fetch March 28th Leads'}
          </button>
          {rows.length > 0 && (
            <button className="btn" onClick={loadFromSheet} disabled={sheetLoading}>
              {sheetLoading ? 'Matching…' : 'Auto-match from Sheet'}
            </button>
          )}
          {error      && <span style={{ fontSize: 12, color: '#dc2626' }}>{error}</span>}
          {sheetError && <span style={{ fontSize: 12, color: '#dc2626' }}>{sheetError}</span>}
          {sheetMeta  && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Sheet: <strong>{sheetMeta.totalRows}</strong> leads · matched <strong style={{ color: '#16a34a' }}>{sheetMeta.matched}</strong> ads
              {sheetMeta.unmatched > 0 && <> · <strong style={{ color: '#f59e0b' }}>{sheetMeta.unmatched}</strong> no UTM</>}
            </span>
          )}
        </div>
      </div>

      {rows.length > 0 && (
        <>
          {/* Summary cards */}
          <div style={{ display: 'flex', gap: 14, marginBottom: 24, flexWrap: 'wrap' }}>
            {[
              { label: 'FB Reported',  value: totalFb,   color: 'var(--text)' },
              { label: 'Actual (entered)', value: anyTrue ? totalTrue : '—', color: '#2563eb' },
              { label: 'Overcount',    value: anyTrue ? totalOver : '—', color: totalOver > 0 ? '#dc2626' : '#16a34a' },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 20px', minWidth: 130 }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            Enter the <strong>actual</strong> lead count for each ad from your sheet. Leave blank to skip that row.
            Overcount = FB reported − Actual.
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 20 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={th}>Ad Name</th>
                  <th style={th}>Campaign</th>
                  <th style={{ ...thR, width: 60 }}>State</th>
                  <th style={{ ...thR, width: 100 }}>FB Leads</th>
                  <th style={{ ...thR, width: 110 }}>Actual Leads</th>
                  <th style={{ ...thR, width: 100 }}>Overcount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const key      = `${row.adName}|${row.state}`;
                  const rawTrue  = trueLeads[key] ?? '';
                  const actual   = parseInt(rawTrue, 10);
                  const hasTrue  = !isNaN(actual);
                  const overcount = hasTrue ? Math.max(0, row.fbLeads - actual) : null;

                  return (
                    <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'var(--bg)' }}>
                      <td style={{ ...td, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.adName}>
                        {row.adName}
                      </td>
                      <td style={{ ...td, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: 12 }} title={row.campaignName}>
                        {row.campaignName}
                      </td>
                      <td style={tdR}>
                        {row.state
                          ? <span style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 700 }}>{row.state}</span>
                          : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                      <td style={{ ...tdR, fontWeight: 600 }}>{row.fbLeads}</td>
                      <td style={tdR}>
                        <input
                          style={inp}
                          type="number"
                          min="0"
                          placeholder="—"
                          value={rawTrue}
                          onChange={e => setTrue(key, e.target.value)}
                        />
                      </td>
                      <td style={{
                        ...tdR,
                        fontWeight: 700,
                        color: overcount == null ? 'var(--text-muted)'
                          : overcount > 0 ? '#dc2626' : '#16a34a',
                      }}>
                        {overcount == null ? '—' : overcount > 0 ? `+${overcount}` : '✓'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} style={{ ...td, fontWeight: 700, borderTop: '2px solid var(--border)' }}>Total</td>
                  <td style={{ ...tdR, fontWeight: 700, borderTop: '2px solid var(--border)' }}>{totalFb}</td>
                  <td style={{ ...tdR, fontWeight: 700, borderTop: '2px solid var(--border)', color: '#2563eb' }}>{anyTrue ? totalTrue : '—'}</td>
                  <td style={{ ...tdR, fontWeight: 700, borderTop: '2px solid var(--border)', color: totalOver > 0 ? '#dc2626' : '#16a34a' }}>
                    {anyTrue ? (totalOver > 0 ? `+${totalOver}` : '✓') : '—'}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button
              className="btn"
              onClick={applySubtractions}
              disabled={!anyTrue}
              style={{ background: anyTrue ? '#dc2626' : undefined, color: anyTrue ? '#fff' : undefined, borderColor: anyTrue ? '#dc2626' : undefined }}
            >
              Apply Overcounts as Lead Subtractions
            </button>
            {saved && <span style={{ fontSize: 13, color: '#16a34a', fontWeight: 600 }}>✓ Saved — Ads Tracking will reflect these subtractions</span>}
            {!anyTrue && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Enter at least one actual count to enable</span>}
          </div>

          <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Subtractions are <strong>additive</strong> — if a row already has a subtraction saved, the new overcount is added on top.
            Rows left blank are skipped. Rows where Actual ≥ FB Leads clear any existing subtraction for that ad.
          </div>
        </>
      )}

      {!loading && rows.length === 0 && !error && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Click <strong>Fetch March 28th Leads</strong> to load the data.
        </div>
      )}
    </div>
  );
}
