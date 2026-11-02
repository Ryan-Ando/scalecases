// Phone layouts for the law site's tabs. The desktop tabs compute everything as before and hand
// their results here when the screen is narrow, so the numbers match the desktop exactly.
import { Fragment, useState } from 'react';

const money = v => (v == null ? '—' : `$${Math.round(v).toLocaleString()}`);
const page = { padding: '14px 12px 24px' };
const title = { fontSize: 18, fontWeight: 700, color: 'var(--text)' };
const muted = { fontSize: 11, color: 'var(--text-muted)' };
const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10 };
const chip = on => ({
  fontSize: 12, padding: '5px 10px', borderRadius: 999, cursor: 'pointer', whiteSpace: 'nowrap',
  border: `1px solid ${on ? 'var(--green)' : 'var(--border)'}`, background: on ? 'var(--green-light)' : 'var(--bg)',
  color: on ? 'var(--green-dark)' : 'var(--text-muted)', fontWeight: on ? 700 : 500,
});
const input = { fontSize: 14, padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)', color: 'var(--text)', width: '100%', boxSizing: 'border-box' };
function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function store(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage blocked */ } }

// ── Ads Tracking: ad name, date created, total leads in the chosen states ──────────────
export function MobileTracking({ adNames, grid, createdOf, states, stateLabel, leadsSince, lastSync, syncing, onSync, loading }) {
  const [picked, setPicked] = useState(() => stored('mobileTrackingStates', []));   // [] = all states
  const [sort, setSort] = useState(() => stored('mobileTrackingSort', 'leads'));
  const [query, setQuery] = useState('');
  const [showZero, setShowZero] = useState(false);
  const chosen = picked.filter(s => states.includes(s));
  const active = chosen.length ? chosen : states;
  const toggle = st => { const next = chosen.includes(st) ? chosen.filter(s => s !== st) : [...chosen, st]; setPicked(next); store('mobileTrackingStates', next); };
  const q = query.trim().toLowerCase();
  const rows = adNames
      .map(name => ({ name, created: createdOf(name), leads: active.reduce((s, st) => s + (grid[name]?.[st] || 0), 0) }))
      .filter(r => (showZero || r.leads > 0) && (!q || r.name.toLowerCase().includes(q)))
      .sort(sort === 'newest' ? (a, b) => (b.created || '').localeCompare(a.created || '') || b.leads - a.leads
        : (a, b) => b.leads - a.leads || (b.created || '').localeCompare(a.created || ''));
  const total = rows.reduce((s, r) => s + r.leads, 0);

  return (
    <div style={page}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={title}>Ads Tracking</div>
        <button className="btn btn--sm btn--primary" style={{ marginLeft: 'auto' }} onClick={onSync} disabled={syncing}>{syncing ? 'Syncing…' : 'Sync'}</button>
      </div>
      <div style={{ ...muted, marginBottom: 8 }}>Leads since {leadsSince} · synced {lastSync || 'never'}</div>
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 6, marginBottom: 8 }}>
        <span style={chip(!chosen.length)} onClick={() => { setPicked([]); store('mobileTrackingStates', []); }}>All states</span>
        {states.map(st => <span key={st} style={chip(chosen.includes(st))} onClick={() => toggle(st)}>{stateLabel(st)}</span>)}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search ads" style={input} />
        <select value={sort} onChange={e => { setSort(e.target.value); store('mobileTrackingSort', e.target.value); }} style={{ ...input, width: 'auto' }}>
          <option value="leads">Most leads</option>
          <option value="newest">Newest</option>
        </select>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', ...muted, marginBottom: 6 }}>
        <span>{rows.length} ads · {total.toLocaleString()} leads</span>
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={showZero} onChange={e => setShowZero(e.target.checked)} /> show 0-lead ads
        </label>
      </div>
      {loading && !adNames.length && <div style={muted}>Loading…</div>}
      <div style={card}>
        {rows.map((r, i) => (
          <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderTop: i ? '1px solid var(--border)' : 'none' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>{r.name}</div>
              <div style={muted}>{r.created ? `created ${r.created}` : 'created —'}</div>
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, minWidth: 36, textAlign: 'right' }}>{r.leads}</div>
          </div>
        ))}
        {!rows.length && !loading && <div style={{ ...muted, padding: 12 }}>No ads with leads in {chosen.length ? chosen.map(stateLabel).join(', ') : 'any state'}.</div>}
      </div>
    </div>
  );
}

// ── Spend Sheet: live daily budget (compact), pacing as over/under + active ad sets ─────
export function MobileSpendTop({ monthLabel, onPrev, onNext, onRefresh, budgetGroups, budgetByState, totalDaily, budgetLoading, budgetError,
  pacingGroups, liveAdsets, countsReady, pacingLoading, onFetchSpend, stateLabel }) {
  const [open, setOpen] = useState(false);
  const brandRows = budgetGroups.map(([brand, sts]) => ({ brand, sts, total: sts.reduce((s, st) => s + (budgetByState[st] || 0), 0) }));
  const th = { padding: '7px 8px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', textAlign: 'right', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap' };
  const td = { padding: '7px 8px', fontSize: 13, textAlign: 'right', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
  const pace = s => s == null ? <span style={{ color: 'var(--text-muted)' }}>—</span>
    : Math.abs(s) < 1 ? <span style={{ color: '#16a34a' }}>on pace</span>
    : s > 0 ? <span style={{ color: '#dc2626', fontWeight: 700 }}>under {money(s)}/d</span>
    : <span style={{ color: '#16a34a', fontWeight: 700 }}>over {money(-s)}/d</span>;
  const count = (st, k) => (countsReady ? liveAdsets[st]?.[k] || 0 : '—');

  return (
    <div style={{ ...page, paddingBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
        <div style={title}>Spend Sheet</div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
          <button className="btn btn--sm" onClick={onPrev}>‹</button>
          <span style={{ fontSize: 13, fontWeight: 600, minWidth: 92, textAlign: 'center' }}>{monthLabel}</span>
          <button className="btn btn--sm" onClick={onNext}>›</button>
          <button className="btn btn--sm" onClick={onRefresh}>↺</button>
        </div>
      </div>

      <div style={{ ...card, padding: '8px 12px', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }} onClick={() => setOpen(o => !o)}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>Live daily</span>
          {budgetLoading ? <span style={muted}>loading…</span> : brandRows.map(b => (
            <span key={b.brand} style={{ fontSize: 13 }}><span style={muted}>{b.brand}</span> <strong>{money(b.total)}</strong></span>
          ))}
          {brandRows.length > 1 && <span style={{ fontSize: 13 }}><span style={muted}>All</span> <strong>{money(totalDaily)}</strong></span>}
          <span style={{ ...muted, marginLeft: 'auto' }}>{open ? '▲' : '▼ states'}</span>
        </div>
        {budgetError && <div style={{ fontSize: 12, color: '#fb9292', marginTop: 4 }}>{budgetError}</div>}
        {open && brandRows.map(b => (
          <div key={b.brand} style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 6, fontSize: 12 }}>
            {b.sts.map(st => <span key={st}><span style={muted}>{stateLabel(st, b.brand)}</span> {money(budgetByState[st])}</span>)}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Pacing</span>
        <button className="btn btn--sm" style={{ marginLeft: 'auto' }} onClick={onFetchSpend} disabled={pacingLoading}>{pacingLoading ? 'Fetching…' : 'Fetch spend'}</button>
      </div>
      <div style={{ ...card, overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 0 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>State</th>
              <th style={th}>Over / under</th>
              <th style={th} title="Active ad sets in CBO campaigns">CBO</th>
              <th style={th} title="Active ad sets in normal campaigns">Normal</th>
            </tr>
          </thead>
          <tbody>
            {pacingGroups.map(([brand, rows]) => (
              <Fragment key={brand}>
                <tr><td colSpan={4} style={{ ...td, textAlign: 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', background: 'var(--bg)' }}>{brand}</td></tr>
                {rows.map(r => (
                  <tr key={r.st}>
                    <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>{stateLabel(r.st, brand)}</td>
                    <td style={td}>{r.enabled === false ? <span style={{ color: 'var(--text-muted)' }}>off</span> : pace(r.shortfall)}</td>
                    <td style={td}>{count(r.st, 'cbo')}</td>
                    <td style={td}>{count(r.st, 'normal')}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ ...muted, marginTop: 6 }}>Under/over = daily spend needed to hit the budget vs. the live daily budget. Budgets and dates are edited on a computer.</div>
    </div>
  );
}

// ── Relaunch: which states are underspending, and the top picks for each ──────────────
export function MobileRelaunch({ recommendations, adsetsByGroup, loading, onRefresh, error }) {
  const [openGroup, setOpenGroup] = useState(null);
  return (
    <div style={page}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <div style={title}>Relaunch</div>
        <button className="btn btn--sm" style={{ marginLeft: 'auto' }} onClick={onRefresh} disabled={loading}>{loading ? 'Loading…' : '↺ Refresh'}</button>
      </div>
      <div style={{ ...muted, marginBottom: 10 }}>Underspending states first, with their best ads to put live. Launching (AdManage drafts) needs a computer with the Scale Cases Helper.</div>
      {error && <div style={{ fontSize: 12, color: '#fb9292', marginBottom: 8 }}>{error}</div>}
      {recommendations.map(rec => {
        const sets = adsetsByGroup[rec.group];
        const isOpen = openGroup === rec.group;
        return (
          <div key={rec.group} style={{ ...card, marginBottom: 8 }}>
            <div style={{ padding: '10px 12px', cursor: 'pointer' }} onClick={() => setOpenGroup(isOpen ? null : rec.group)}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 15, fontWeight: 700 }}>{rec.group}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: rec.under ? '#dc2626' : rec.paced ? '#16a34a' : 'var(--text-muted)' }}>
                  {rec.under ? `under ${money(rec.shortfall)}/d` : rec.paced ? 'on pace' : 'no pacing'}
                </span>
                <span style={{ ...muted, marginLeft: 'auto' }}>{isOpen ? '▲' : `▼ ${rec.candidates.length} picks`}</span>
              </div>
              <div style={muted}>
                live {money(rec.liveBudget)}/d · {rec.activeAds} active ads{sets ? ` · ad sets ${sets.cbo} CBO · ${sets.normal} normal` : ''}
              </div>
            </div>
            {isOpen && (
              <div style={{ borderTop: '1px solid var(--border)' }}>
                {rec.candidates.slice(0, 10).map(c => (
                  <div key={c.name} style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>{c.name}</div>
                    <div style={muted}>
                      {c.tier === 0 ? 'new creative' : `${c.hereLeads ?? 0} leads here${c.hereCpl ? ` · ${money(c.hereCpl)} CPL` : ''} · ${c.totalLeads ?? 0} total${c.totalCpl ? ` · ${money(c.totalCpl)} CPL` : ''}`}
                    </div>
                  </div>
                ))}
                {!rec.candidates.length && <div style={{ ...muted, padding: '8px 12px' }}>No candidates clear the bar.</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function MobileDisclaimers() {
  return (
    <div style={page}>
      <div style={title}>Disclaimers</div>
      <div style={{ ...card, padding: 14, marginTop: 10, fontSize: 13, lineHeight: 1.5 }}>
        Disclaimer versions are rendered and reviewed on a computer running the Scale Cases Helper (it reads the ad files
        from Google Drive and runs the video tools). Open this page on your Mac or PC to make or review versions.
      </div>
    </div>
  );
}
