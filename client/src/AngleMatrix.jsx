import { useState, useEffect, useMemo } from 'react';
import { dbGetAll } from './db.js';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Find which angle from the list appears in an adset name as a whole token
function findAngle(name, angles) {
  for (const angle of angles) {
    const re = new RegExp(`(^|[\\s\\-])${angle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s\\-\\d]|$)`, 'i');
    if (re.test(name)) return angle;
  }
  return null;
}

// Strip the angle (and any trailing -N variant suffix) to get the base creative name
function getBase(name, angle) {
  const escaped = angle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Remove: optional separator + angle + optional -number suffix
  return name.replace(new RegExp(`[\\s\\-]?${escaped}(?:[\\s\\-]\\d+)?$`, 'i'), '').trim();
}

export default function AngleMatrix() {
  const [ads, setAds]           = useState([]);
  const [ghlLeads, setGhlLeads] = useState({});
  const [angles, setAngles]     = useState(() => {
    try { return JSON.parse(localStorage.getItem('angleMatrix_angles') || '[]'); } catch { return []; }
  });
  const [input, setInput] = useState('');

  // Load ads from IndexedDB (same store as Ads Tracking — no FB API call)
  useEffect(() => {
    dbGetAll('fbAds').then(setAds).catch(() => {});
  }, []);

  // Load GHL lead counts (server cache — no FB API call)
  useEffect(() => {
    fetch(`${BASE}/api/ghl/leads-by-adid`)
      .then(r => r.json())
      .then(d => { if (d.byAdId) setGhlLeads(d.byAdId); })
      .catch(() => {});
  }, []);

  function addAngle() {
    const val = input.trim();
    if (!val || angles.some(a => a.toLowerCase() === val.toLowerCase())) { setInput(''); return; }
    const next = [...angles, val];
    setAngles(next);
    localStorage.setItem('angleMatrix_angles', JSON.stringify(next));
    setInput('');
  }

  function removeAngle(a) {
    const next = angles.filter(x => x !== a);
    setAngles(next);
    localStorage.setItem('angleMatrix_angles', JSON.stringify(next));
  }

  // Deduplicate ads by adsetId — keep unique adsets only (multiple ads per adset share the same name/leads)
  const adsets = useMemo(() => {
    const seen = new Set();
    const out  = [];
    for (const ad of ads) {
      if (!ad.adsetId || seen.has(ad.adsetId)) continue;
      seen.add(ad.adsetId);
      out.push({ adsetId: ad.adsetId, adsetName: ad.adsetName || ad.name || '', campaignName: ad.campaignName || '' });
    }
    return out;
  }, [ads]);

  // Build matrix: baseName → { angle → totalLeads }
  const { matrix, bases } = useMemo(() => {
    if (!angles.length) return { matrix: {}, bases: [] };
    const matrix = {};
    for (const adset of adsets) {
      const angle = findAngle(adset.adsetName, angles);
      if (!angle) continue;
      const base   = getBase(adset.adsetName, angle);
      const leads  = ghlLeads[adset.adsetId]?.total || 0;
      if (!matrix[base]) matrix[base] = {};
      if (!matrix[base][angle]) matrix[base][angle] = 0;
      matrix[base][angle] += leads;
    }
    const bases = Object.keys(matrix).sort((a, b) => {
      // Sort by total leads desc
      const ta = angles.reduce((s, ang) => s + (matrix[a][ang] || 0), 0);
      const tb = angles.reduce((s, ang) => s + (matrix[b][ang] || 0), 0);
      return tb - ta;
    });
    return { matrix, bases };
  }, [adsets, angles, ghlLeads]);

  const totalRow = useMemo(() => {
    const t = {};
    for (const ang of angles) {
      t[ang] = bases.reduce((s, b) => s + (matrix[b]?.[ang] || 0), 0);
    }
    return t;
  }, [matrix, bases, angles]);

  return (
    <div style={{ padding: '24px', minHeight: '100vh', boxSizing: 'border-box' }}>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 700 }}>Angle Matrix</h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
          Add angles as columns. Each row is a base creative with that angle stripped. Green = used, shows lead count.
        </p>
      </div>

      {/* Angle input */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 20 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addAngle(); }}
          placeholder="Add angle (e.g. pr, neck, back)…"
          style={{ fontSize: 13, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', outline: 'none', width: 220 }}
        />
        <button className="btn btn--sm btn--primary" onClick={addAngle}>Add</button>
        {angles.map(a => (
          <span key={a} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 600 }}>
            {a}
            <button onClick={() => removeAngle(a)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, lineHeight: 1, fontSize: 13 }}>×</button>
          </span>
        ))}
      </div>

      {/* No data states */}
      {angles.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)', fontSize: 13 }}>
          Add at least one angle to build the matrix.
        </div>
      )}
      {angles.length > 0 && bases.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)', fontSize: 13 }}>
          No ads found matching those angles. Make sure Ads Tracking has been synced.
        </div>
      )}

      {/* Matrix grid */}
      {bases.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: '100%' }}>
            <thead>
              <tr>
                <th style={thStyle(true)}>Creative</th>
                {angles.map(a => (
                  <th key={a} style={{ ...thStyle(true), textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.05em', minWidth: 90 }}>{a}</th>
                ))}
                <th style={{ ...thStyle(true), textAlign: 'center', minWidth: 70 }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {/* Totals row */}
              <tr style={{ background: 'var(--surface)' }}>
                <td style={{ ...tdStyle(), fontWeight: 700, color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>TOTALS</td>
                {angles.map(a => (
                  <td key={a} style={{ ...tdStyle(), textAlign: 'center', fontWeight: 700 }}>
                    {totalRow[a] > 0 ? totalRow[a] : '—'}
                  </td>
                ))}
                <td style={{ ...tdStyle(), textAlign: 'center', fontWeight: 700 }}>
                  {angles.reduce((s, a) => s + (totalRow[a] || 0), 0) || '—'}
                </td>
              </tr>

              {bases.map((base, i) => {
                const rowTotal = angles.reduce((s, a) => s + (matrix[base]?.[a] || 0), 0);
                return (
                  <tr key={base} style={{ background: i % 2 === 0 ? 'var(--bg)' : 'var(--surface)' }}>
                    <td style={{ ...tdStyle(), maxWidth: 340, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={base}>
                      {base}
                    </td>
                    {angles.map(a => {
                      const leads = matrix[base]?.[a];
                      const used  = leads !== undefined;
                      return (
                        <td key={a} style={{
                          ...tdStyle(),
                          textAlign: 'center',
                          background: used ? 'rgba(34,197,94,0.15)' : undefined,
                          color:      used ? 'var(--green, #16a34a)' : 'var(--text-muted)',
                          fontWeight: used ? 700 : 400,
                          border:     used ? '1px solid rgba(34,197,94,0.3)' : '1px solid var(--border)',
                        }}>
                          {used ? (leads > 0 ? leads : '✓') : '—'}
                        </td>
                      );
                    })}
                    <td style={{ ...tdStyle(), textAlign: 'center', color: 'var(--text-muted)', fontWeight: 500 }}>
                      {rowTotal > 0 ? rowTotal : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function thStyle(header = false) {
  return {
    padding: '8px 12px',
    textAlign: 'left',
    fontWeight: 700,
    fontSize: header ? 11 : 12,
    borderBottom: '2px solid var(--border)',
    background: 'var(--surface)',
    position: 'sticky',
    top: 0,
    whiteSpace: 'nowrap',
    color: header ? 'var(--text-muted)' : 'var(--text)',
    textTransform: header ? 'uppercase' : 'none',
    letterSpacing: header ? '0.05em' : 'normal',
  };
}

function tdStyle() {
  return {
    padding: '7px 12px',
    border: '1px solid var(--border)',
    verticalAlign: 'middle',
  };
}
