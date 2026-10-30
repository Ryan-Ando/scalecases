import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import './disclaimers.css';

// Local worker (tools/disclaimer-worker). Loopback only; see README there.
export const WORKER_URL = 'http://127.0.0.1:43128';
const START_CMD = 'python tools/disclaimer-worker/worker.py';

async function w(path, opts = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    signal: opts.signal || AbortSignal.timeout(opts.timeout || 15000),
    targetAddressSpace: 'loopback',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || res.statusText);
  return data;
}

async function upload(file) {
  const fd = new FormData(); fd.append('file', file, file.name);
  const res = await fetch(`${WORKER_URL}/upload`, { method: 'POST', body: fd, targetAddressSpace: 'loopback' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

const FLAG_LABELS = {
  inserted_opening: 'no opening disclaimer found, one was added (first 5s)',
  samples_disagree: 'sampled frames disagreed on method',
  multiple_ranges: 'more than one disclaimer range',
  card_solid: 'solid card fill',
  top_region: 'top-of-frame disclaimer',
  manual_ranges: 'manual frame ranges',
  forced_method: 'method forced',
  range_unlocated: 'a text range could not be located',
  band_scaled: 'band size changed',
  median_failed: 'median erase failed, frost used',
};
const STATUS_LABEL = { queued: 'Queued', running: 'Rendering…', review: 'Needs review', approved: 'Approved', rejected: 'Rejected', error: 'Error' };

function fmtTime(iso) { try { return new Date(iso).toLocaleString(); } catch { return iso; } }
function baseName(p) { return (p || '').split(/[\\/]/).pop(); }

// ───────────────────────────── folder / file browser ─────────────────────────────
function Browser({ mode, initial, recents, onPick, onClose }) {
  const [path, setPath] = useState(initial || '');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState(new Set());
  const [typed, setTyped] = useState(initial || '');
  const load = useCallback(async p => {
    try { const d = await w(`/fs?path=${encodeURIComponent(p)}`); setData(d); setPath(d.path); setTyped(d.path); setSel(new Set()); setErr(''); }
    catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { const id = setTimeout(() => void load(initial || ''), 0); return () => clearTimeout(id); }, [initial, load]);
  const pickFiles = mode === 'files';
  function toggle(name) { setSel(s => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n; }); }
  const sep = data?.sep || '\\';
  function join(dir) { return path ? (path.endsWith(sep) ? path + dir : path + sep + dir) : dir; }
  return (
    <div className="dz-overlay" onClick={onClose}>
      <div className="dz-modal" onClick={e => e.stopPropagation()}>
        <div className="dz-modal-head">
          <strong>{pickFiles ? 'Choose files' : 'Choose folder'}</strong>
          <button className="btn btn--sm" onClick={onClose}>✕</button>
        </div>
        <div className="dz-row">
          <input className="settings-input dz-grow" value={typed} onChange={e => setTyped(e.target.value)}
                 onKeyDown={e => { if (e.key === 'Enter') void load(typed); }} placeholder="Type a path and press Enter" />
          <button className="btn btn--sm" onClick={() => void load(typed)}>Go</button>
          <button className="btn btn--sm" disabled={!data || data.parent === null} onClick={() => void load(data.parent || '')}>Up</button>
        </div>
        {recents?.length > 0 && (
          <div className="dz-recents">{recents.map(r => <button key={r} className="dz-chip" onClick={() => void load(r)}>{r}</button>)}</div>
        )}
        {err && <div className="dz-err">{err}</div>}
        <div className="dz-list">
          {data?.dirs.map(d => (
            <div key={d} className="dz-item dz-item--dir" onDoubleClick={() => void load(join(d))} onClick={() => void load(join(d))}>📁 {d}</div>
          ))}
          {pickFiles && data?.files.map(f => (
            <label key={f.name} className={`dz-item${sel.has(f.name) ? ' dz-item--sel' : ''}`}>
              <input type="checkbox" checked={sel.has(f.name)} onChange={() => toggle(f.name)} /> {f.kind === 'video' ? '🎬' : '🖼️'} {f.name}
            </label>
          ))}
          {data && !data.dirs.length && !(pickFiles && data.files.length) && <div className="dz-muted">Nothing here.</div>}
        </div>
        <div className="dz-modal-foot">
          {pickFiles && data?.files.length > 0 && (
            <button className="btn btn--sm" onClick={() => setSel(sel.size === data.files.length ? new Set() : new Set(data.files.map(f => f.name)))}>
              {sel.size === data.files.length ? 'Clear' : 'Select all'}
            </button>
          )}
          <span className="dz-muted dz-grow">{path}</span>
          {pickFiles
            ? <button className="btn btn--primary btn--sm" disabled={!sel.size} onClick={() => onPick([...sel].map(join))}>Add {sel.size || ''} file{sel.size === 1 ? '' : 's'}</button>
            : <button className="btn btn--primary btn--sm" disabled={!path} onClick={() => onPick(path)}>Use this folder</button>}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── overrides form ─────────────────────────────
const DEFAULT_OV = { method: 'auto', frost: -0.15, blur_sigma: '', band_scale: 1, bold: false, region: 'auto', ranges: '' };
function parseRanges(text) {
  const out = [];
  for (const line of (text || '').split(/\n|,/)) {
    const m = line.trim().match(/^(top|bottom)?\s*(\d+)\s*-\s*(\d+)$/i);
    if (m) out.push({ region: (m[1] || 'bottom').toLowerCase(), a: +m[2], b: +m[3] });
  }
  return out;
}
function toWorkerOverrides(o, kind) {
  const ov = {};
  if (o.method && o.method !== 'auto') ov.method = o.method;
  if (kind === 'video') {
    if (o.frost !== '' && o.frost !== null && Number(o.frost) !== -0.15) ov.frost = Number(o.frost);
    if (o.blur_sigma !== '' && o.blur_sigma !== null) ov.blur_sigma = Number(o.blur_sigma);
    if (o.region && o.region !== 'auto') ov.region = o.region;
    const r = parseRanges(o.ranges); if (r.length) ov.ranges = r;
  } else if (o.frost !== '' && o.frost !== null && Number(o.frost) !== -0.15) ov.frost_white = Number(o.frost);
  if (Number(o.band_scale) && Number(o.band_scale) !== 1) ov.band_scale = Number(o.band_scale);
  if (o.bold) ov.bold = true;
  return ov;
}
function Overrides({ kind, value, onChange }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <div className="dz-ov">
      <label>Method
        <select className="settings-select" value={value.method} onChange={e => set('method', e.target.value)}>
          <option value="auto">auto</option><option value="solid">solid fill</option>
          {kind === 'image' ? <option value="median">median erase</option> : null}
          <option value="frost">frosted box</option>
          {kind === 'video' ? <option value="soft">soft blur</option> : null}
        </select>
      </label>
      <label>Frost tint <span className="dz-muted">(−1 dark … +1 light)</span>
        <input className="settings-input" type="number" step="0.05" min="-1" max="1" value={value.frost} onChange={e => set('frost', e.target.value)} />
      </label>
      {kind === 'video' && <label>Blur sigma <span className="dz-muted">(blank = auto)</span>
        <input className="settings-input" type="number" step="0.5" min="0" value={value.blur_sigma} onChange={e => set('blur_sigma', e.target.value)} />
      </label>}
      <label>Band size <span className="dz-muted">(1 = old text height)</span>
        <input className="settings-input" type="number" step="0.05" min="0.5" max="2" value={value.band_scale} onChange={e => set('band_scale', e.target.value)} />
      </label>
      <label className="dz-check"><input type="checkbox" checked={!!value.bold} onChange={e => set('bold', e.target.checked)} /> Bold text</label>
      {kind === 'video' && <>
        <label>Region
          <select className="settings-select" value={value.region} onChange={e => set('region', e.target.value)}>
            <option value="auto">auto (scan both)</option><option value="bottom">bottom only</option><option value="top">top only</option>
          </select>
        </label>
        <label className="dz-wide">Manual frame ranges <span className="dz-muted">(one per line, e.g. "0-183" or "top 0-167"; replaces detection)</span>
          <textarea className="settings-input" rows={2} value={value.ranges} onChange={e => set('ranges', e.target.value)} />
        </label>
      </>}
    </div>
  );
}

// ───────────────────────────── review card ─────────────────────────────
function ItemCard({ job, item, onChanged }) {
  const [ovOpen, setOvOpen] = useState(false);
  const [ov, setOv] = useState({ ...DEFAULT_OV, ...(item.overrides?.ranges ? { ranges: item.overrides.ranges.map(r => `${r.region} ${r.a}-${r.b}`).join('\n') } : {}), ...pickUi(item.overrides) });
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  function pickUi(o) {
    if (!o) return {};
    const u = {};
    if (o.method) u.method = o.method; if (o.frost != null) u.frost = o.frost; if (o.frost_white != null) u.frost = o.frost_white;
    if (o.blur_sigma != null) u.blur_sigma = o.blur_sigma; if (o.band_scale != null) u.band_scale = o.band_scale; if (o.bold) u.bold = true; if (o.region) u.region = o.region;
    return u;
  }
  async function act(kind, body) {
    setBusy(kind); setErr('');
    try { await w(`/jobs/${job.id}/items/${item.idx}/${kind}`, { method: 'POST', body: body || {} }); onChanged(); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  const res = item.result;
  const previews = item.previews || [];
  const url = n => `${WORKER_URL}/preview/${job.id}/${item.idx}/${n}?t=${item.finished || ''}`;
  const groups = useMemo(() => {
    if (!res) return [];
    if (res.kind === 'image') return [{ title: 'Disclaimer band', shots: [['before', 'Before'], ['after', 'After']] }];
    return (res.ranges || []).map((r, i) => ({
      title: `${r.region} range, frames ${r.a}–${r.b} (${(r.a / res.fps).toFixed(2)}s–${((r.b + 1) / res.fps).toFixed(2)}s)`,
      shots: [[`r${i}_before`, 'Before (mid)'], [`r${i}_after`, 'After (mid)'], [`r${i}_last`, 'Last disclaimer frame'], [`r${i}_next`, 'First clean frame']],
    }));
  }, [res]);
  return (
    <div className={`dz-card dz-card--${item.status}`}>
      <div className="dz-card-head">
        <div>
          <div className="dz-card-title">{item.name} <span className="dz-arrow">→</span> {item.out_name}</div>
          <div className="dz-muted">{item.parent} · {item.disclaimer_name} v{item.version} · {item.kind}</div>
        </div>
        <span className={`dz-status dz-status--${item.status}`}>{STATUS_LABEL[item.status] || item.status}</span>
      </div>
      {item.flags?.length > 0 && (
        <div className="dz-flags">{item.flags.map(f => <span key={f} className="dz-flag" title={f}>⚑ {FLAG_LABELS[f] || f}</span>)}</div>
      )}
      {item.error && <div className="dz-err">{item.error}</div>}
      {previews.length > 0 && (
        <div className="dz-previews">
          {groups.map(g => (
            <div key={g.title} className="dz-pgroup">
              <div className="dz-pgroup-title">{g.title}</div>
              <div className="dz-shots">
                {g.shots.filter(([n]) => previews.includes(n)).map(([n, label]) => (
                  <figure key={n} className="dz-shot"><img src={url(n)} alt={label} loading="lazy" /><figcaption>{label}</figcaption></figure>
                ))}
              </div>
            </div>
          ))}
          {previews.includes('full') && <figure className="dz-shot dz-shot--full"><img src={url('full')} alt="full frame" loading="lazy" /><figcaption>Full frame</figcaption></figure>}
        </div>
      )}
      {item.log?.length > 0 && <details className="dz-log"><summary>Log</summary><pre>{item.log.join('\n')}</pre></details>}
      {res?.rejected?.length > 0 && (
        <div className="dz-muted dz-small">Left untouched: {res.rejected.map(r => `${r.region} ${r.a}–${r.b} (${r.reason})`).join('; ')}</div>
      )}
      <div className="dz-card-actions">
        {item.status === 'review' && <>
          <button className="btn btn--primary btn--sm" disabled={!!busy} onClick={() => act('approve')}>{busy === 'approve' ? '…' : 'Approve → write to destination'}</button>
          <button className="btn btn--sm" disabled={!!busy} onClick={() => act('reject')}>Reject</button>
        </>}
        {['review', 'rejected', 'error', 'approved'].includes(item.status) && (
          <button className="btn btn--sm" onClick={() => setOvOpen(o => !o)}>{ovOpen ? 'Hide overrides' : 'Overrides / re-render'}</button>
        )}
        {err && <span className="dz-err">{err}</span>}
      </div>
      {ovOpen && (
        <div className="dz-ovwrap">
          <Overrides kind={item.kind} value={ov} onChange={setOv} />
          <button className="btn btn--primary btn--sm" disabled={!!busy} onClick={() => act('rerender', { overrides: toWorkerOverrides(ov, item.kind) })}>
            {busy === 'rerender' ? '…' : 'Re-render with these settings'}
          </button>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── main tab ─────────────────────────────
export default function Disclaimers() {
  const [health, setHealth] = useState(null);
  const [online, setOnline] = useState(false);
  const [disclaimers, setDisclaimers] = useState([]);
  const [settings, setSettings] = useState({ tags: [], out_folder: 'new disclaimer', recent_parents: [] });
  const [jobs, setJobs] = useState([]);
  const [sub, setSub] = useState(() => localStorage.getItem('dz_sub') || 'process');
  const [err, setErr] = useState('');
  const pollRef = useRef();

  const refreshState = useCallback(async () => {
    try {
      const h = await w('/health', { timeout: 4000 }); setHealth(h); setOnline(true);
      const s = await w('/state'); setDisclaimers(s.disclaimers); setSettings(s.settings);
      setJobs(await w('/jobs'));
      setErr('');
    } catch { setOnline(false); }
  }, []);
  const refreshJobs = useCallback(async () => { try { setJobs(await w('/jobs')); } catch { /* offline */ } }, []);
  useEffect(() => { const id = setTimeout(() => void refreshState(), 0); return () => clearTimeout(id); }, [refreshState]);
  const active = jobs.some(j => j.items.some(i => i.status === 'queued' || i.status === 'running'));
  useEffect(() => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(() => { if (document.visibilityState !== 'visible') return; active ? void refreshJobs() : void refreshState(); }, active ? 2500 : 20000);
    return () => clearInterval(pollRef.current);
  }, [active, refreshJobs, refreshState]);
  function go(s) { setSub(s); localStorage.setItem('dz_sub', s); }

  const reviewCount = jobs.reduce((n, j) => n + j.items.filter(i => i.status === 'review').length, 0);
  const SUBS = [['process', 'Process'], ['review', `Review${reviewCount ? ` (${reviewCount})` : ''}`], ['library', 'Library'], ['history', 'History'], ['tools', 'Tools'], ['settings', 'Settings']];

  return (
    <div className="dz">
      <div className="tab-header dz-head">
        <div>
          <div className="tab-title">Disclaimers</div>
          <div className="tab-desc">Replace burned-in disclaimers on image and video ads. Renders locally, reviewed before anything is written.</div>
        </div>
        <div className={`dz-worker ${online ? 'dz-worker--on' : 'dz-worker--off'}`}>
          <span className="s-dot" /> {online ? `Worker online${health?.ffmpeg ? '' : ' · ffmpeg missing'}${active ? ' · rendering' : ''}${health && !health.library_root_ok ? ' · library root not set' : ''}` : 'Worker offline'}
          {!online && <div className="dz-muted dz-small">Start it on this PC: <code>{START_CMD}</code> then <button className="dz-link" onClick={() => void refreshState()}>retry</button></div>}
        </div>
      </div>
      <div className="dz-subnav">{SUBS.map(([k, l]) => <button key={k} className={`status-btn${sub === k ? ' status-btn--active' : ''}`} onClick={() => go(k)}>{l}</button>)}</div>
      {err && <div className="dz-err">{err}</div>}
      {sub === 'process' && <Process disclaimers={disclaimers} settings={settings} online={online} onStarted={() => { void refreshJobs(); go('review'); }} />}
      {sub === 'review' && <Review jobs={jobs} onChanged={refreshJobs} />}
      {sub === 'library' && <Library disclaimers={disclaimers} onChanged={refreshState} />}
      {sub === 'history' && <History disclaimers={disclaimers} onStarted={() => { void refreshJobs(); go('review'); }} />}
      {sub === 'tools' && <Tools settings={settings} />}
      {sub === 'settings' && <SettingsPane key={`${(settings.tags || []).join('|')}|${settings.out_folder}|${settings.library_root}`} settings={settings} health={health} onChanged={refreshState} />}
    </div>
  );
}

// ───────────────────────────── Process ─────────────────────────────
function Process({ disclaimers, settings, online, onStarted }) {
  const [files, setFiles] = useState([]);
  const [targets, setTargets] = useState([{ parent: '', disclaimer_id: '' }]);
  const [browse, setBrowse] = useState(null);     // {mode, idx}
  const [diff, setDiff] = useState(null);
  const [diffParent, setDiffParent] = useState('');
  const [ovOpen, setOvOpen] = useState(false);
  const [ov, setOv] = useState(DEFAULT_OV);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [drop, setDrop] = useState({ over: false, busy: 0, msg: '' });
  // first saved disclaimer is the default for any target that has not chosen one; a target
  // with no folder typed uses the disclaimer's saved destination
  const discFor = t => t.disclaimer_id || disclaimers[0]?.id || '';
  const parentFor = t => t.parent || disclaimers.find(d => d.id === discFor(t))?.parent || '';

  function addFiles(list) { setFiles(f => [...new Set([...f, ...list])]); setBrowse(null); }
  async function onDrop(e) {
    e.preventDefault(); setDrop(d => ({ ...d, over: false }));
    const list = [...(e.dataTransfer?.files || [])].filter(f => /\.(png|jpe?g|webp|mp4|mov|m4v)$/i.test(f.name));
    if (!list.length) { setDrop(d => ({ ...d, msg: 'No image or video files in that drop.' })); return; }
    setDrop(d => ({ ...d, busy: list.length, msg: `Copying ${list.length} file${list.length === 1 ? '' : 's'} to the worker…` }));
    const added = [];
    for (const f of list) {
      try { const r = await upload(f); added.push(r.path); }
      catch (err) { setErr(`${f.name}: ${err.message}`); }
      setDrop(d => ({ ...d, busy: d.busy - 1 }));
    }
    setFiles(x => [...new Set([...x, ...added])]);
    setDrop(d => ({ ...d, msg: added.length ? `Added ${added.length} dropped file${added.length === 1 ? '' : 's'}.` : '' }));
  }
  async function loadDiff(parent) {
    setErr(''); setDiffParent(parent);
    try { setDiff(await w(`/diff?parent=${encodeURIComponent(parent)}`)); } catch (e) { setErr(e.message); }
  }
  async function start() {
    setBusy(true); setErr('');
    try {
      const t = targets.map(x => ({ parent: parentFor(x), disclaimer_id: discFor(x) })).filter(x => x.parent && x.disclaimer_id);
      if (!files.length || !t.length) throw new Error('Add at least one file and one destination with a disclaimer.');
      await w('/jobs', { method: 'POST', body: { files, targets: t, overrides: toWorkerOverrides(ov, 'video') } });
      setFiles([]); onStarted();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  const kindHint = files.length ? `${files.filter(f => /\.(mp4|mov|m4v)$/i.test(f)).length} video · ${files.filter(f => /\.(png|jpe?g|webp)$/i.test(f)).length} image` : '';
  return (
    <div className="dz-grid">
      <section className={`dz-panel${drop.over ? ' dz-panel--drop' : ''}`}
               onDragOver={e => { e.preventDefault(); if (!drop.over) setDrop(d => ({ ...d, over: true })); }}
               onDragLeave={() => setDrop(d => ({ ...d, over: false }))} onDrop={onDrop}>
        <h3>1 · Source files</h3>
        <div className="dz-dropzone">{drop.busy ? drop.msg : 'Drop image or video ads anywhere on this panel'}{!drop.busy && drop.msg ? ` · ${drop.msg}` : ''}</div>
        <div className="dz-row">
          <button className="btn btn--sm" disabled={!online} onClick={() => setBrowse({ mode: 'files' })}>Add files…</button>
          <button className="btn btn--sm" disabled={!online} onClick={() => setBrowse({ mode: 'diff' })}>Pick a parent folder → show what is not done</button>
          {files.length > 0 && <button className="btn btn--sm" onClick={() => setFiles([])}>Clear</button>}
          <span className="dz-muted">{kindHint}</span>
        </div>
        {diff && (
          <div className="dz-diff">
            <div className="dz-row">
              <strong>{diff.parent}</strong><span className="dz-muted">{diff.done} of {diff.total} done · output folder "{baseName(diff.out_root)}"</span>
              <button className="btn btn--sm" onClick={() => setFiles(f => [...new Set([...f, ...diff.items.filter(i => !i.done).map(i => i.path)])])}>Add all not done</button>
              <button className="btn btn--sm" onClick={() => setDiff(null)}>Hide</button>
            </div>
            {diff.loose.length > 0 && <div className="dz-muted dz-small">Loose files not in a date folder (use Tools → Sort by date): {diff.loose.join(', ')}</div>}
            <div className="dz-list dz-list--tall">
              {diff.items.map(i => (
                <label key={i.path} className={`dz-item${files.includes(i.path) ? ' dz-item--sel' : ''}`}>
                  <input type="checkbox" checked={files.includes(i.path)} onChange={e => setFiles(f => e.target.checked ? [...new Set([...f, i.path])] : f.filter(x => x !== i.path))} />
                  <span className={`dz-done ${i.done ? 'dz-done--yes' : ''}`}>{i.done ? 'done' : 'not done'}</span> {i.folder}\{i.name}
                </label>
              ))}
            </div>
          </div>
        )}
        {files.length > 0 && (
          <ul className="dz-files">{files.map(f => <li key={f}><span>{f}</span><button className="dz-link" onClick={() => setFiles(x => x.filter(y => y !== f))}>remove</button></li>)}</ul>
        )}
      </section>
      <section className="dz-panel">
        <h3>2 · Destinations</h3>
        <div className="dz-muted dz-small">Each file is rendered once per destination. Choosing a disclaimer fills in its saved destination; you can still change the folder. Output goes to <code>&lt;folder&gt;\{settings.out_folder}\&lt;mmdd&gt;\</code>. Names ending in a state tag are kept; others get " - &lt;disclaimer name&gt;".</div>
        {targets.map((t, i) => (
          <div key={i} className="dz-row dz-target">
            <select className="settings-select dz-sel" value={discFor(t)} onChange={e => setTargets(ts => ts.map((x, j) => j === i ? { ...x, disclaimer_id: e.target.value, parent: '' } : x))}>
              <option value="">— disclaimer —</option>{disclaimers.map(d => <option key={d.id} value={d.id}>{d.name} (v{d.version})</option>)}
            </select>
            <input className="settings-input dz-grow" value={parentFor(t)} placeholder="Destination folder (saved per disclaimer in Library)" onChange={e => setTargets(ts => ts.map((x, j) => j === i ? { ...x, parent: e.target.value } : x))} />
            <button className="btn btn--sm" disabled={!online} onClick={() => setBrowse({ mode: 'folder', idx: i })}>Browse…</button>
            {targets.length > 1 && <button className="btn btn--sm" onClick={() => setTargets(ts => ts.filter((_, j) => j !== i))}>✕</button>}
          </div>
        ))}
        <button className="btn btn--sm" onClick={() => setTargets(ts => [...ts, { parent: '', disclaimer_id: disclaimers[0]?.id || '' }])}>+ Another destination</button>
        {!disclaimers.length && <div className="dz-err">No disclaimers yet. Add one in Library.</div>}
      </section>
      <section className="dz-panel">
        <h3>3 · Render</h3>
        <button className="btn btn--sm" onClick={() => setOvOpen(o => !o)}>{ovOpen ? 'Hide' : 'Default overrides for this batch'}</button>
        {ovOpen && <Overrides kind="video" value={ov} onChange={setOv} />}
        <div className="dz-row">
          <button className="btn btn--primary" disabled={busy || !online || !files.length} onClick={start}>{busy ? 'Starting…' : `Render ${files.length || ''} file${files.length === 1 ? '' : 's'} → review`}</button>
          <span className="dz-muted dz-small">Nothing is written to the destination until you approve it in Review.</span>
        </div>
        {err && <div className="dz-err">{err}</div>}
      </section>
      {browse?.mode === 'files' && <Browser mode="files" initial={settings.recent_parents?.[0] || ''} recents={settings.recent_parents} onPick={addFiles} onClose={() => setBrowse(null)} />}
      {browse?.mode === 'folder' && <Browser mode="folder" initial={parentFor(targets[browse.idx]) || settings.recent_parents?.[0] || ''} recents={settings.recent_parents}
        onPick={p => { setTargets(ts => ts.map((x, j) => j === browse.idx ? { ...x, parent: p } : x)); setBrowse(null); }} onClose={() => setBrowse(null)} />}
      {browse?.mode === 'diff' && <Browser mode="folder" initial={diffParent || settings.recent_parents?.[0] || ''} recents={settings.recent_parents}
        onPick={p => { setBrowse(null); void loadDiff(p); }} onClose={() => setBrowse(null)} />}
    </div>
  );
}

// ───────────────────────────── Review ─────────────────────────────
function Review({ jobs, onChanged }) {
  const [filter, setFilter] = useState('review');
  const [busy, setBusy] = useState(false);
  const items = jobs.flatMap(j => j.items.map(i => ({ job: j, item: i })));
  const shown = items.filter(({ item }) => filter === 'all' || item.status === filter);
  const clean = items.filter(({ item }) => item.status === 'review' && !(item.flags || []).length);
  async function approveClean() {
    setBusy(true);
    for (const { job, item } of clean) { try { await w(`/jobs/${job.id}/items/${item.idx}/approve`, { method: 'POST', body: {} }); } catch { /* shown on card */ } }
    setBusy(false); onChanged();
  }
  async function removeJob(id) { await w(`/jobs/${id}`, { method: 'DELETE' }); onChanged(); }
  const counts = {}; for (const { item } of items) counts[item.status] = (counts[item.status] || 0) + 1;
  return (
    <div>
      <div className="dz-row dz-toolbar">
        {['review', 'running', 'approved', 'rejected', 'error', 'all'].map(s => (
          <button key={s} className={`status-btn${filter === s ? ' status-btn--active' : ''}`} onClick={() => setFilter(s)}>{STATUS_LABEL[s] || 'All'}{s === 'all' ? ` (${items.length})` : counts[s] ? ` (${counts[s]})` : ''}</button>
        ))}
        <span className="dz-grow" />
        <button className="btn btn--sm" disabled={busy || !clean.length} onClick={approveClean} title="Approve every item awaiting review that has no flags">{busy ? '…' : `Approve all unflagged (${clean.length})`}</button>
      </div>
      {!shown.length && <div className="empty"><div className="empty-title">Nothing here</div><div className="empty-desc">Start a render from Process.</div></div>}
      {jobs.filter(j => j.items.some(i => filter === 'all' || i.status === filter)).map(j => (
        <div key={j.id} className="dz-job">
          <div className="dz-job-head"><span className="dz-muted">Job {j.id} · {fmtTime(j.created)}{j.regenerate ? ' · regenerate' : ''} · {j.items.length} item{j.items.length === 1 ? '' : 's'}</span>
            {j.items.every(i => ['approved', 'rejected', 'error'].includes(i.status)) && <button className="dz-link" onClick={() => removeJob(j.id)}>remove job</button>}
          </div>
          {j.items.filter(i => filter === 'all' || i.status === filter).map(i => <ItemCard key={i.idx} job={j} item={i} onChanged={onChanged} />)}
        </div>
      ))}
    </div>
  );
}

// ───────────────────────────── Library ─────────────────────────────
function Library({ disclaimers, onChanged }) {
  const [edit, setEdit] = useState(null);   // {id?, name, text, parent}
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [browse, setBrowse] = useState(false);
  async function saveD() {
    setBusy(true); setErr('');
    try {
      const body = { name: edit.name, text: edit.text, parent: edit.parent || '' };
      if (edit.id) await w(`/disclaimers/${edit.id}`, { method: 'PUT', body });
      else await w('/disclaimers', { method: 'POST', body });
      setEdit(null); onChanged();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function del(d) {
    if (!window.confirm(`Delete "${d.name}"? History entries stay, but they can no longer be regenerated.`)) return;
    await w(`/disclaimers/${d.id}`, { method: 'DELETE' }); onChanged();
  }
  return (
    <div className="dz-grid">
      <section className="dz-panel">
        <div className="dz-row"><h3 className="dz-grow">Saved disclaimers</h3><button className="btn btn--primary btn--sm" onClick={() => setEdit({ name: '', text: '', parent: '' })}>+ New</button></div>
        {!disclaimers.length && <div className="dz-muted">None yet.</div>}
        {disclaimers.map(d => (
          <div key={d.id} className="dz-disc">
            <div className="dz-row"><strong>{d.name}</strong><span className="dz-muted">v{d.version} · updated {fmtTime(d.updated)}</span><span className="dz-grow" />
              <button className="btn btn--sm" onClick={() => setEdit({ id: d.id, name: d.name, text: d.text, parent: d.parent || '' })}>Edit</button>
              <button className="btn btn--sm" onClick={() => del(d)}>Delete</button></div>
            <div className="dz-small">{d.parent ? <>Destination: <code>{d.parent}</code>{d.parent_resolved && d.parent_resolved !== d.parent ? <span className="dz-muted"> → {d.parent_resolved}</span> : null}</> : <span className="dz-muted">No saved destination</span>}</div>
            <div className="dz-disc-text">{d.text}</div>
            {d.versions.length > 1 && <details className="dz-log"><summary>{d.versions.length} versions</summary>
              {d.versions.slice().reverse().map(v => <div key={v.version} className="dz-small"><strong>v{v.version}</strong> · {fmtTime(v.ts)}<div className="dz-disc-text">{v.text}</div></div>)}</details>}
          </div>
        ))}
      </section>
      {edit && (
        <section className="dz-panel">
          <h3>{edit.id ? 'Edit disclaimer' : 'New disclaimer'}</h3>
          <div className="settings-field"><label className="settings-label">Name <span className="dz-muted">(used as the filename suffix, e.g. "lss co")</span></label>
            <input className="settings-input" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} /></div>
          <div className="settings-field"><label className="settings-label">Default destination <span className="dz-muted">(parent folder; the mmdd subfolder is added automatically. Paths inside the library root are saved as <code>{'{root}'}/…</code> so they work on both machines)</span></label>
            <div className="dz-row"><input className="settings-input dz-grow" value={edit.parent} placeholder="C:\…\2026 B2C\CO" onChange={e => setEdit({ ...edit, parent: e.target.value })} />
              <button className="btn btn--sm" onClick={() => setBrowse(true)}>Browse…</button></div></div>
          <div className="settings-field"><label className="settings-label">Text</label>
            <textarea className="settings-input dz-textarea" rows={9} value={edit.text} onChange={e => setEdit({ ...edit, text: e.target.value })} /></div>
          {edit.id && <div className="dz-muted dz-small">Changing the text saves a new version. Outputs made with the old version show as stale in History.</div>}
          {err && <div className="dz-err">{err}</div>}
          <div className="dz-row"><button className="btn btn--primary" disabled={busy || !edit.name.trim() || !edit.text.trim()} onClick={saveD}>{busy ? 'Saving…' : 'Save'}</button><button className="btn" onClick={() => setEdit(null)}>Cancel</button></div>
          {browse && <Browser mode="folder" initial={edit.parent || ''} recents={[]} onPick={p => { setEdit({ ...edit, parent: p }); setBrowse(false); }} onClose={() => setBrowse(false)} />}
        </section>
      )}
    </div>
  );
}

// ───────────────────────────── History ─────────────────────────────
function History({ disclaimers, onStarted }) {
  const [rows, setRows] = useState([]);
  const [filt, setFilt] = useState('');
  const [sel, setSel] = useState(new Set());
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    w(`/history?disclaimer_id=${filt}`).then(r => { if (live) setRows(r); }).catch(e => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [filt, tick]);
  const stale = rows.filter(r => r.stale);
  async function regen(ids) {
    setErr('');
    try { await w('/history/regenerate', { method: 'POST', body: { ids } }); setSel(new Set()); onStarted(); } catch (e) { setErr(e.message); }
  }
  async function forget(id) { await w(`/history/${id}`, { method: 'DELETE' }); setTick(t => t + 1); }
  return (
    <div>
      <div className="dz-row dz-toolbar">
        <select className="settings-select dz-sel" value={filt} onChange={e => setFilt(e.target.value)}><option value="">All disclaimers</option>{disclaimers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <span className="dz-muted">{rows.length} outputs · {stale.length} stale</span><span className="dz-grow" />
        <button className="btn btn--sm" disabled={!stale.length} onClick={() => regen(stale.map(r => r.id))}>Regenerate all stale ({stale.length})</button>
        <button className="btn btn--primary btn--sm" disabled={!sel.size} onClick={() => regen([...sel])}>Regenerate selected ({sel.size})</button>
      </div>
      {err && <div className="dz-err">{err}</div>}
      <div className="table-wrap"><table className="dz-table">
        <thead><tr><th /><th>Output</th><th>Destination</th><th>Disclaimer</th><th>Version</th><th>Method</th><th>Approved</th><th /></tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.id} className={r.stale ? 'dz-stale' : ''}>
            <td><input type="checkbox" checked={sel.has(r.id)} onChange={e => setSel(s => { const n = new Set(s); e.target.checked ? n.add(r.id) : n.delete(r.id); return n; })} /></td>
            <td className="td-name">{r.name}{!r.exists && <span className="dz-muted dz-small"> (file missing)</span>}{!r.src_exists && <span className="dz-muted dz-small"> (source missing)</span>}</td>
            <td className="td-muted">{r.parent}</td><td>{r.disclaimer_name}</td>
            <td>v{r.version}{r.stale && <span className="dz-flag"> stale → v{r.current_version}</span>}</td>
            <td>{r.method || '—'}</td><td className="td-muted">{fmtTime(r.ts)}</td>
            <td><button className="dz-link" onClick={() => forget(r.id)}>forget</button></td>
          </tr>))}</tbody>
      </table></div>
    </div>
  );
}

// ───────────────────────────── Tools ─────────────────────────────
function Tools({ settings }) {
  const [parent, setParent] = useState(settings.recent_parents?.[0] || '');
  const [browse, setBrowse] = useState(false);
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function run(apply) {
    setBusy(true); setErr('');
    try { setPlan(await w('/sort', { method: 'POST', body: { parent, apply }, timeout: 120000 })); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="dz-panel">
      <h3>Sort by date</h3>
      <div className="dz-muted dz-small">Moves every ad under the parent folder into an <code>mmdd</code> subfolder from its 4-digit filename prefix, including files sitting in wrongly named subfolders. Empty folders are removed. Collisions are reported and never overwritten. The output folder "{settings.out_folder}" is left alone.</div>
      <div className="dz-row">
        <input className="settings-input dz-grow" value={parent} onChange={e => setParent(e.target.value)} placeholder="Parent folder" />
        <button className="btn btn--sm" onClick={() => setBrowse(true)}>Browse…</button>
        <button className="btn btn--sm" disabled={busy || !parent} onClick={() => run(false)}>Dry run</button>
        <button className="btn btn--primary btn--sm" disabled={busy || !plan || plan.parent !== parent || !plan.moves} onClick={() => { if (window.confirm(`Move ${plan.moves} file(s) now?`)) void run(true); }}>Apply</button>
      </div>
      {err && <div className="dz-err">{err}</div>}
      {plan && (
        <div>
          <div className="dz-muted">{plan.moves} to move · {plan.collisions} collisions · {plan.plan.filter(p => p.status.startsWith('skip')).length} skipped{plan.removed?.length ? ` · removed empty: ${plan.removed.map(baseName).join(', ')}` : ''}</div>
          <div className="dz-list dz-list--tall">{plan.plan.map(p => <div key={p.from} className="dz-item dz-small"><span className={`dz-done ${p.status === 'moved' ? 'dz-done--yes' : ''}`}>{p.status}</span> {p.from}{p.to ? ` → ${p.to}` : ''}</div>)}</div>
        </div>
      )}
      {browse && <Browser mode="folder" initial={parent} recents={settings.recent_parents} onPick={p => { setParent(p); setBrowse(false); setPlan(null); }} onClose={() => setBrowse(false)} />}
    </div>
  );
}

// ───────────────────────────── Settings ─────────────────────────────
function SettingsPane({ settings, health, onChanged }) {
  const [tags, setTags] = useState((settings.tags || []).join('\n'));
  const [out, setOut] = useState(settings.out_folder || 'new disclaimer');
  const [root, setRoot] = useState(settings.library_root || '');
  const [browse, setBrowse] = useState(false);
  const [msg, setMsg] = useState('');
  const fileRef = useRef();
  async function save() {
    try { await w('/settings', { method: 'PUT', body: { tags: tags.split('\n').map(t => t.trim()).filter(Boolean), out_folder: out.trim() || 'new disclaimer', library_root: root.trim() } }); setMsg('Saved.'); onChanged(); }
    catch (e) { setMsg(e.message); }
  }
  async function exportLib() {
    const data = await w('/export');
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `disclaimers-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  async function importLib(e) {
    const f = e.target.files?.[0]; if (!f) return;
    try { const r = await w('/import', { method: 'POST', body: JSON.parse(await f.text()) }); setMsg(`Imported: ${r.added} added, ${r.updated} updated.`); onChanged(); }
    catch (err) { setMsg(`Import failed: ${err.message}`); }
    e.target.value = '';
  }
  return (
    <div className="dz-panel">
      <div className="settings-field"><label className="settings-label">Library root <span className="dz-muted">(this machine's path to the synced Google Drive "My Drive"; saved destinations use <code>{'{root}'}</code> so the library works on both the PC and the Mac)</span></label>
        <div className="dz-row"><input className="settings-input dz-grow" value={root} onChange={e => setRoot(e.target.value)} placeholder={health?.library_root_guess || 'G:\\My Drive'} />
          <button className="btn btn--sm" onClick={() => setBrowse(true)}>Browse…</button>
          {health?.library_root_guess && health.library_root_guess !== root && <button className="btn btn--sm" onClick={() => setRoot(health.library_root_guess)}>Use detected: {health.library_root_guess}</button>}</div>
        {root && health && !health.library_root_ok && root === health.library_root && <div className="dz-err">That folder does not exist on this machine.</div>}
      </div>
      <div className="settings-field"><label className="settings-label">State tags <span className="dz-muted">(one per line; a filename ending in one of these keeps its name, otherwise " - &lt;disclaimer name&gt;" is appended)</span></label>
        <textarea className="settings-input dz-textarea" rows={6} value={tags} onChange={e => setTags(e.target.value)} /></div>
      <div className="settings-field"><label className="settings-label">Output folder name inside each destination</label>
        <input className="settings-input" value={out} onChange={e => setOut(e.target.value)} /></div>
      <div className="dz-row"><button className="btn btn--primary" onClick={save}>Save settings</button><span className="dz-muted">{msg}</span></div>
      <div className="dz-row" style={{ marginTop: 10 }}>
        <button className="btn btn--sm" onClick={exportLib}>Export library (JSON)</button>
        <button className="btn btn--sm" onClick={() => fileRef.current?.click()}>Import library…</button>
        <input ref={fileRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={importLib} />
        <span className="dz-muted dz-small">Move your saved disclaimers and tags to the other machine. History stays per machine.</span>
      </div>
      <div className="dz-muted dz-small" style={{ marginTop: 16 }}>Worker: <code>{WORKER_URL}</code> · {health?.platform || ''} · data: <code>{health?.data || ''}</code> · recent destinations: {(settings.recent_parents || []).join(' · ') || 'none yet'}</div>
      {browse && <Browser mode="folder" initial={root || ''} recents={[]} onPick={p => { setRoot(p); setBrowse(false); }} onClose={() => setBrowse(false)} />}
    </div>
  );
}
