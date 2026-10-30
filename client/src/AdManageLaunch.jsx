import { useState, useEffect, useMemo } from 'react';
import { LOCAL_LIBRARY_URL } from './useCreativeLibrary.js';
import { creativeKey } from './creativeMatching.js';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const CAMPAIGN_KEY = 'admanageCampaigns';

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}/api/admanage${path}`, opts);
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) { const e = new Error(data.error || res.statusText); e.data = data; throw e; }
  return data;
}
function savedCampaigns() {
  try { return JSON.parse(localStorage.getItem(CAMPAIGN_KEY) || '{}'); } catch { return {}; }
}

// State versions first (prefer the disclaimer tool's "new disclaimer" output), then the rest.
function rankFiles(files, state) {
  return [...files].sort((a, b) =>
    Number(b.state === state) - Number(a.state === state) ||
    Number(/\/new disclaimer\//i.test(b.relativePath)) - Number(/\/new disclaimer\//i.test(a.relativePath)) ||
    b.relativePath.localeCompare(a.relativePath));
}
const fileName = f => f.relativePath.split('/').pop();

// One new ad set per checked ad, in the checked campaign, using the state's AdManage copy template.
export default function AdManageLaunch({ brand, state, picked, onUnpick, onPick, groups, library }) {
  const group = `${brand} ${state}`;
  const [setup, setSetup] = useState(null);
  const [error, setError] = useState('');
  const [campaignId, setCampaignId] = useState(() => savedCampaigns()[group] || '');
  const [templateId, setTemplateId] = useState('');
  const [fileChoice, setFileChoice] = useState({});   // ad name → library file id
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);

  useEffect(() => {
    let live = true;
    api(`/setup?brand=${encodeURIComponent(brand)}&state=${encodeURIComponent(state)}`)
      .then(d => { if (!live) return; setSetup(d); setTemplateId(t => t || d.templates[0]?.id || ''); })
      .catch(e => live && setError(e.message));
    return () => { live = false; };
  }, [brand, state]);

  const byKey = useMemo(() => new Map(groups.map(g => [g.key, g])), [groups]);
  const rows = useMemo(() => [...picked].map(name => {
    const g = byKey.get(creativeKey(name));
    const files = g ? rankFiles(g.files, state) : [];
    const file = files.find(f => f.id === fileChoice[name]) || files[0] || null;
    return { name, files, file, stateVersion: file?.state === state };
  }), [picked, byKey, state, fileChoice]);

  const campaign = setup?.campaigns.find(c => c.campaignId === campaignId);
  const template = setup?.templates.find(t => t.id === templateId);
  const ready = campaign && template && rows.length && rows.every(r => r.file) && library.connected && !busy;
  const matches = query.trim().length < 2 ? [] : groups
    .filter(g => g.name.toLowerCase().includes(query.trim().toLowerCase()) && !picked.has(g.name)).slice(0, 8);

  function chooseCampaign(id) {
    const next = id === campaignId ? '' : id;
    setCampaignId(next);
    try { localStorage.setItem(CAMPAIGN_KEY, JSON.stringify({ ...savedCampaigns(), [group]: next })); } catch { /* storage blocked */ }
  }
  const note = line => setLog(l => [...l, line]);

  async function launch() {
    const ads = rows.map(r => ({ pick: r.name, adName: r.file.name, file: r.file }));
    const missing = rows.filter(r => !r.stateVersion).map(r => r.name);
    const ok = window.confirm(
      `Launch ${ads.length} ad${ads.length > 1 ? 's' : ''} LIVE in "${campaign.name}" (${campaign.accountName})?\n\n` +
      `Each gets its own new ad set copied from the campaign's newest active ad set, with the "${template.name}" copy.\n\n` +
      ads.map(a => `• ${a.adName}`).join('\n') +
      (missing.length ? `\n\nNot a ${state} version (check the disclaimer): ${missing.join(', ')}` : ''));
    if (!ok) return;
    setBusy(true); setLog([]);
    try {
      for (const a of ads) {
        note(`Uploading ${fileName(a.file)}…`);
        const blob = await (await fetch(`${LOCAL_LIBRARY_URL}/preview/${a.file.id}`, { targetAddressSpace: 'loopback' })).blob();
        const up = await api(`/upload?fileName=${encodeURIComponent(fileName(a.file))}`, {
          method: 'POST', body: blob, headers: { 'Content-Type': blob.type || 'application/octet-stream' },
        });
        a.mediaUrl = up.url;
      }
      note('Creating ad sets and ads…');
      const r = await api('/launch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: campaign.accountId, campaignId, templateId, ads: ads.map(a => ({ adName: a.adName, mediaUrl: a.mediaUrl })) }),
      });
      note(`Copied ad set "${r.source.name}" ${r.adSets.length}× — AdManage batch ${r.batchId} is launching the ads…`);
      for (let i = 0; i < 40; i++) {
        await new Promise(ok => setTimeout(ok, 5000));
        const s = await api(`/batch/${r.batchId}`);
        const status = String(s.summaryStatus || s.status || '').toLowerCase();
        if (s.batchSucceeded || status === 'success') { note(`✓ Launched ${ads.length} ad${ads.length > 1 ? 's' : ''} live.`); ads.forEach(a => onUnpick(a.pick)); return; }
        if (status === 'error' || status === 'failed' || s.batchSucceeded === false) {
          note(`✗ AdManage reported a problem: ${s.message || s.error || JSON.stringify(s.failedDetails || '')}`); return;
        }
      }
      note(`Still running after 3 minutes — check batch ${r.batchId} in AdManage.`);
    } catch (e) {
      note(`✗ ${e.message}`);
      if (e.data?.adSets?.length) note(`Empty ad sets already created (no spend): ${e.data.adSets.map(s => s.adName).join(', ')}`);
    } finally { setBusy(false); }
  }

  const box = { fontSize: 12, padding: '10px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 10 };
  if (error) return <div style={{ ...box, color: '#fb9292' }}>AdManage: {error}</div>;
  if (!setup) return <div style={{ ...box, color: 'var(--text-muted)' }}>Loading AdManage campaigns for {group}…</div>;

  return (
    <div style={box}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>Launch with AdManage — 1 ad per new ad set</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginBottom: 8 }}>
        {setup.campaigns.length === 0 && <span style={{ color: 'var(--text-muted)' }}>No {group} campaigns found in AdManage.</span>}
        {setup.campaigns.map(c => (
          <label key={c.campaignId} style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={c.campaignId === campaignId} onChange={() => chooseCampaign(c.campaignId)} />
            <span style={{ fontWeight: c.campaignId === campaignId ? 700 : 400 }}>{c.name}</span>
            <span style={{ color: c.status === 'ACTIVE' ? '#15803d' : 'var(--text-muted)', fontSize: 11 }}>{c.status.toLowerCase()} · {c.accountName}</span>
          </label>
        ))}
      </div>
      <div style={{ marginBottom: 8 }}>
        Copy template:{' '}
        {setup.templates.length === 0 ? <span style={{ color: '#fb9292' }}>no "{group}" template in AdManage</span>
          : setup.templates.length === 1 ? <strong>{setup.templates[0].name}</strong>
          : <select value={templateId} onChange={e => setTemplateId(e.target.value)}>
              {setup.templates.map(t => <option key={t.id} value={t.id}>{t.name} ({t.businessId})</option>)}
            </select>}
        {campaign && template && template.businessId !== campaign.accountId &&
          <span style={{ color: 'var(--text-muted)' }}> · template was saved under another ad account; its copy is still used</span>}
      </div>

      {rows.length === 0 && <div style={{ color: 'var(--text-muted)', marginBottom: 6 }}>Check ads in the table below, or add any creative:</div>}
      {rows.map(r => (
        <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
          <button className="btn btn--sm" onClick={() => onUnpick(r.name)} disabled={busy} title="Remove">✕</button>
          <span style={{ fontWeight: 600 }}>{r.name}</span>
          {r.files.length === 0
            ? <span style={{ color: '#fb9292' }}>no local file found{library.connected ? '' : ' (connect the local creative library)'}</span>
            : <select value={r.file.id} onChange={e => setFileChoice(m => ({ ...m, [r.name]: e.target.value }))} disabled={busy}>
                {r.files.map(f => <option key={f.id} value={f.id}>{f.relativePath}</option>)}
              </select>}
          {r.file && !r.stateVersion && <span style={{ color: '#d97706' }}>not a {state} version</span>}
        </div>
      ))}
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Add another creative by name…" disabled={busy}
        style={{ fontSize: 12, padding: '3px 6px', width: 260, marginTop: 4, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)' }} />
      {matches.map(g => (
        <div key={g.key}><button className="btn btn--sm" style={{ marginTop: 2 }} onClick={() => { onPick(g.name); setQuery(''); }}>+ {g.name}</button></div>
      ))}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <button className="btn btn--sm" onClick={launch} disabled={!ready}>
          {busy ? 'Launching…' : `Launch ${rows.length || ''} live`}
        </button>
        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
          {!campaign ? 'Check a campaign. ' : ''}{!template ? 'No copy template. ' : ''}{!library.connected ? 'Local creative library not connected. ' : ''}
        </span>
      </div>
      {log.length > 0 && <div style={{ marginTop: 8, lineHeight: 1.5 }}>{log.map((l, i) => <div key={i}>{l}</div>)}</div>}
    </div>
  );
}
