import { useState, useEffect, useMemo, useCallback } from 'react';
import { LOCAL_LIBRARY_URL, refreshLibrary } from './useCreativeLibrary.js';
import { creativeKey } from './creativeMatching.js';
import { ItemCard } from './Disclaimers.jsx';
import { w } from './disclaimerWorker.js';

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

const STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
// The state a file was made for: its state folder, or a "LSS CO" / "CA LSS" tag in the name.
// null = the default version, which carries the default disclaimer.
function fileState(f) {
  if (f.state) return f.state;
  const m = f.name.match(/\bLSS[ _-]*([A-Za-z]{2})\b/i) || f.name.match(/\b([A-Za-z]{2})[ _-]+LSS\b/i);
  const st = m?.[1].toUpperCase();
  return STATES.has(st) ? st : null;
}

// Only this state's own versions (the disclaimer tool's "new disclaimer" output first), then the
// default versions. Another state's version is never offered: it carries that state's disclaimer.
function rankFiles(files, state) {
  return files.filter(f => [state, null].includes(fileState(f))).sort((a, b) =>
    Number(fileState(b) === state) - Number(fileState(a) === state) ||
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
  // States with their own disclaimer have state versions in the library; the rest use the default
  const ownDisclaimer = useMemo(() => groups.some(g => g.files.some(f => fileState(f) === state)), [groups, state]);
  const rows = useMemo(() => [...picked].map(name => {
    const g = byKey.get(creativeKey(name));
    const files = g ? rankFiles(g.files, state) : [];
    const file = files.find(f => f.id === fileChoice[name]) || files[0] || null;
    const stateVersion = !!file && fileState(file) === state;
    // A state with its own disclaimer can't run the default version; the default is what gets converted
    const needsVersion = !!file && ownDisclaimer && !stateVersion;
    const problem = !g ? 'no local file found' : !file ? `only other states' versions exist — no default or ${state} version`
      : needsVersion ? `no ${state} version yet` : '';
    return { name, files, file, stateVersion, needsVersion, problem };
  }), [picked, byKey, state, fileChoice, ownDisclaimer]);

  // ── State versions through the local disclaimer worker (same render → review → approve flow
  // as the Disclaimers tab; nothing is written to the library until approved) ──
  const [made, setMade] = useState({});        // ad name → { jobId, idx }
  const [workerJobs, setWorkerJobs] = useState({}); // jobId → job
  const [makeErr, setMakeErr] = useState('');
  const [making, setMaking] = useState(false);
  const missing = rows.filter(r => r.needsVersion && !made[r.name]);

  async function makeVersions(list) {
    setMaking(true); setMakeErr('');
    try {
      const { disclaimers } = await w('/state');
      const disc = disclaimers.filter(d => (d.parent || '').split(/[\\/]/).filter(Boolean).pop()?.toUpperCase() === state);
      if (!disc.length) throw new Error(`No ${state} disclaimer saved in the Disclaimers tab library (its destination folder must end in /${state})`);
      if (disc.length > 1) throw new Error(`More than one ${state} disclaimer in the library (${disc.map(d => d.name).join(', ')}) — use the Disclaimers tab to pick one`);
      // The library folder that holds the state folders, e.g. {root}/2026 B2C
      const base = disc[0].parent.replace(/[\\/]+[^\\/]+[\\/]*$/, '');
      const job = await w('/jobs', { method: 'POST', timeout: 60000,
        body: { files: list.map(r => `${base}/${r.file.relativePath}`), targets: [{ parent: disc[0].parent, disclaimer_id: disc[0].id }] } });
      setWorkerJobs(j => ({ ...j, [job.id]: job }));
      setMade(m => ({ ...m, ...Object.fromEntries(list.map((r, idx) => [r.name, { jobId: job.id, idx }])) }));
    } catch (e) {
      setMakeErr(/fetch|network|load failed/i.test(e.message) ? 'The disclaimer worker is not running on this computer' : e.message);
    } finally { setMaking(false); }
  }

  const trackedJobs = [...new Set(Object.values(made).map(m => m.jobId))];
  const refreshJobs = useCallback(async () => {
    const fresh = await Promise.all(trackedJobs.map(id => w(`/jobs/${id}`).catch(() => null)));
    setWorkerJobs(j => ({ ...j, ...Object.fromEntries(fresh.filter(Boolean).map(x => [x.id, x])) }));
  }, [trackedJobs.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const itemFor = name => { const m = made[name]; return m && workerJobs[m.jobId]?.items[m.idx]; };
  const rendering = Object.keys(made).some(n => ['queued', 'running'].includes(itemFor(n)?.status));
  const approved = Object.keys(made).filter(n => itemFor(n)?.status === 'approved');
  useEffect(() => {   // follow renders until they reach review
    if (!rendering) return;
    const t = setInterval(() => void refreshJobs(), 3000);
    return () => clearInterval(t);
  }, [rendering, refreshJobs]);
  useEffect(() => {   // approved files reach the creative helper on its next scan (once a minute)
    if (!approved.length) return;
    const t = setInterval(() => void refreshLibrary(), 20000);
    return () => clearInterval(t);
  }, [approved.length]);
  useEffect(() => {   // once the library has the state version, the row is fixed: stop tracking it
    const done = Object.keys(made).filter(n => rows.find(r => r.name === n)?.stateVersion);
    if (done.length) setMade(m => Object.fromEntries(Object.entries(m).filter(([n]) => !done.includes(n))));
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const campaign = setup?.campaigns.find(c => c.campaignId === campaignId);
  const template = setup?.templates.find(t => t.id === templateId);
  const ready = campaign && template && rows.length && rows.every(r => !r.problem) && library.connected && !busy;
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
    const ok = window.confirm(
      `Launch ${ads.length} ad${ads.length > 1 ? 's' : ''} LIVE in "${campaign.name}" (${campaign.accountName})?\n\n` +
      `Each gets its own new ad set copied from the campaign's newest active ad set, with the "${template.name}" copy.\n\n` +
      rows.map(r => `• ${r.file.name} (${r.stateVersion ? `${state} disclaimer` : 'default disclaimer'})`).join('\n'));
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
        // batchSucceeded is false while the batch is still running, so only the summary decides
        const status = String(s.summaryStatus || s.status || '').toLowerCase();
        if (status === 'success') { note(`✓ Launched ${ads.length} ad${ads.length > 1 ? 's' : ''} live.`); ads.forEach(a => onUnpick(a.pick)); return; }
        if (/error|fail|partial/.test(status)) {
          const failed = (s.ads || []).filter(a => a.status !== 'success');
          note(`✗ AdManage: ${s.finalMessage || s.message || status}`);
          failed.forEach(a => note(`   ${a.adName}: ${a.errorMessage || a.status}`));
          ads.filter(a => !failed.some(f => f.adName === a.adName)).forEach(a => onUnpick(a.pick));
          return;
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
      {missing.length > 1 && (
        <button className="btn btn--sm" style={{ marginBottom: 6 }} disabled={making || busy} onClick={() => void makeVersions(missing)}>
          {making ? 'Starting…' : `Make all ${missing.length} missing ${state} versions`}
        </button>
      )}
      {makeErr && <div style={{ color: '#fb9292', marginBottom: 6 }}>{makeErr}</div>}
      {rows.map(r => {
        const item = itemFor(r.name);
        return (
          <div key={r.name} style={{ marginBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn--sm" onClick={() => onUnpick(r.name)} disabled={busy} title="Remove">✕</button>
              <span style={{ fontWeight: 600 }}>{r.name}</span>
              {r.file && <select value={r.file.id} onChange={e => setFileChoice(m => ({ ...m, [r.name]: e.target.value }))} disabled={busy}>
                {r.files.map(f => <option key={f.id} value={f.id}>{f.relativePath}{fileState(f) ? '' : ' (default)'}</option>)}
              </select>}
              {r.problem
                ? <span style={{ color: '#fb9292' }}>{r.problem}{r.problem === 'no local file found' && !library.connected ? ' (connect the local creative library)' : ''}</span>
                : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{r.stateVersion ? `${state} disclaimer` : 'default disclaimer'}</span>}
              {r.needsVersion && !made[r.name] && (
                <button className="btn btn--sm" disabled={making || busy} onClick={() => void makeVersions([r])}>Make {state} version</button>
              )}
              {item?.status === 'approved' && <span style={{ color: '#15803d', fontSize: 11 }}>approved — appears here within ~2 minutes</span>}
            </div>
            {item && item.status !== 'approved' && (
              <div style={{ marginTop: 6 }}><ItemCard job={workerJobs[made[r.name].jobId]} item={item} onChanged={() => void refreshJobs()} /></div>
            )}
          </div>
        );
      })}
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
          {!campaign ? 'Check a campaign. ' : ''}{!template ? 'No copy template. ' : ''}{!library.connected ? 'Local creative library not connected. ' : ''}{rows.some(r => r.problem) ? 'Fix or remove the ads marked in red. ' : ''}
        </span>
      </div>
      {log.length > 0 && <div style={{ marginTop: 8, lineHeight: 1.5 }}>{log.map((l, i) => <div key={i}>{l}</div>)}</div>}
    </div>
  );
}
