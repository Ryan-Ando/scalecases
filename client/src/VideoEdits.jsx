// Video Edits tab: review Claude's video edits before the final export. Each project is a timeline
// file in the Shared Drive (ScaleCases Cloud/Edits/<project>), rendered by the Scale Cases Helper
// (tools/disclaimer-worker/video_edit.py). Drafts stay inside the project; only Export writes a
// video into the ad library. Notes are pinned to a time and version: "Fix" notes are for this
// video, "Lesson" notes become rules in Edits/_editor/RULES.md once approved, which the
// video-editor skill reads before every edit.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { w, WORKER_URL } from './disclaimerWorker.js';
import HelperSetup from './HelperSetup.jsx';

const NEEDS_VERSION = 5;
const fmtT = t => (t == null ? '—' : `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`);
const mmdd = () => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };
const box = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10 };
const input = { fontSize: 12, padding: '5px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)' };
const muted = { fontSize: 11, color: 'var(--text-muted)' };
const ROW_COLORS = { video: '#3b82f6', overlays: '#a855f7', captions: '#f59e0b', audio: '#10b981' };

export default function VideoEdits() {
  const [health, setHealth] = useState(null);     // null = checking, false = offline
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(() => localStorage.getItem('videoEditsProject') || '');
  const [showRules, setShowRules] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const h = await w('/health', { timeout: 4000 });
      setHealth(h);
      if (h.version < NEEDS_VERSION) return;
      setList(await w('/edits')); setError('');
    } catch (e) {
      if (/fetch|network|load failed|timed out|abort/i.test(e.message)) setHealth(false); else setError(e.message);
    }
  }, []);
  useEffect(() => {
    const first = setTimeout(() => void loadList(), 0);
    const t = setInterval(() => { if (document.visibilityState === 'visible') void loadList(); }, 20000);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [loadList]);
  const open = name => { setCurrent(name); try { localStorage.setItem('videoEditsProject', name); } catch { /* storage blocked */ } };

  if (health === null) return <div style={{ padding: 24, ...muted }}>Connecting to the Scale Cases Helper…</div>;
  if (health === false) return (
    <div style={{ padding: 24 }}>
      <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Video Edits</div>
      <div style={{ ...box, padding: 14 }}><HelperSetup what="Video Edits" /></div>
    </div>
  );
  if (health.version < NEEDS_VERSION) return (
    <div style={{ padding: 24 }}>
      <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Video Edits</div>
      <div style={{ ...box, padding: 14, fontSize: 13 }}>This computer's Scale Cases Helper is out of date (version {health.version}). Run the setup again to update it: <HelperSetup what="Video Edits" /></div>
    </div>
  );

  const projects = list?.projects || [];
  const shown = projects.find(p => p.name === current) ? current : projects[0]?.name;
  return (
    <div style={{ padding: '20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>Video Edits</div>
        <span style={muted}>review Claude's edits before the final export · notes become fixes or lessons</span>
        <button className="btn btn--sm" style={{ marginLeft: 'auto' }} onClick={() => setShowRules(s => !s)}>
          {showRules ? 'Hide' : 'Show'} editor rules ({(list?.rules.match(/^- /gm) || []).length})
        </button>
        <button className="btn btn--sm" onClick={() => void loadList()}>↺</button>
      </div>
      {error && <div style={{ color: '#fb9292', marginBottom: 8 }}>{error}</div>}
      {showRules && (
        <pre style={{ ...box, padding: 12, fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto', marginBottom: 12 }}>
          {list?.rules || 'No rules yet. Approved "Lesson" notes land here.'}
        </pre>
      )}
      {list && !list.root && <div style={{ ...box, padding: 14, fontSize: 13 }}>Google Drive's "ScaleCases Cloud" folder wasn't found on this computer.</div>}
      {list?.root && projects.length === 0 && (
        <div style={{ ...box, padding: 14, fontSize: 13 }}>No video projects yet. Ask Claude to edit a video; it creates the project in <code>{list.root}</code>.</div>
      )}
      {projects.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          {projects.map(p => (
            <button key={p.name} className={`btn btn--sm${p.name === shown ? ' btn--primary' : ''}`} onClick={() => open(p.name)}
              title={`${p.versions} versions · updated ${p.updated ? new Date(p.updated).toLocaleString() : '—'}`}>
              {p.title}{p.open_notes ? ` · ${p.open_notes} open` : ''}{p.pending_rules ? ` · ${p.pending_rules} rule${p.pending_rules > 1 ? 's' : ''} to approve` : ''}{p.exported ? ' · exported' : ''}
            </button>
          ))}
        </div>
      )}
      {shown && <Project key={shown} name={shown} onChanged={loadList} />}
    </div>
  );
}

function Project({ name, onChanged }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(null);
  const [time, setTime] = useState(0);
  const [zoom, setZoom] = useState(40);              // pixels per second
  const [noteText, setNoteText] = useState('');
  const [noteKind, setNoteKind] = useState('fix');
  const [showDone, setShowDone] = useState(false);
  const [exportName, setExportName] = useState('');
  const [busy, setBusy] = useState('');
  const video = useRef(null);
  const enc = encodeURIComponent;
  const fileUrl = src => `${WORKER_URL}/edits/${enc(name)}/file?src=${enc(src)}`;

  const load = useCallback(async () => {
    try { setD(await w(`/edits/${enc(name)}`)); setError(''); } catch (e) { setError(e.message); }
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 8000);
    return () => clearInterval(t);
  }, [load]);
  const running = d?.job?.state === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [running, load]);
  useEffect(() => {   // job finished: refresh the project list (counts, exported flag)
    if (d?.job && d.job.state !== 'running') onChanged();
  }, [d?.job?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const playable = (d?.versions || []).filter(v => v.file);
  const latest = playable[playable.length - 1];
  const shownV = playable.find(v => v.v === version) || latest;
  useEffect(() => { if (d && !exportName) setExportName(`${mmdd()}-${(d.timeline.title || name).replace(/[\\/:*?"<>|]/g, '')}-1`); }, [d]); // eslint-disable-line react-hooks/exhaustive-deps

  const seek = t => { if (video.current) { video.current.currentTime = Math.max(0, t); setTime(t); } };
  const notes = d?.notes || [];
  const visibleNotes = notes.filter(n => showDone || n.status === 'open' || n.rule_status === 'pending');

  async function act(label, fn) {
    setBusy(label); setError('');
    try { await fn(); await load(); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  }
  const addNote = () => act('note', async () => {
    await w(`/edits/${enc(name)}/notes`, { method: 'POST', body: { text: noteText, t: Math.round(time * 10) / 10, version: shownV?.v ?? null, kind: noteKind } });
    setNoteText('');
  });
  const editNote = (id, body) => act('note', () => w(`/edits/${enc(name)}/notes/${id}`, { method: 'POST', body }));

  if (error && !d) return <div style={{ color: '#fb9292' }}>{error}</div>;
  if (!d) return <div style={muted}>Loading {name}…</div>;
  const tl = d.timeline;
  const portrait = (tl.height || 1920) > (tl.width || 1080);

  return (
    <div>
      {error && <div style={{ color: '#fb9292', marginBottom: 8 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Player + versions */}
        <div style={{ flex: portrait ? '0 0 auto' : '1 1 560px' }}>
          {shownV ? (
            <video ref={video} key={shownV.file} src={fileUrl(shownV.file)} controls playsInline
              onTimeUpdate={e => setTime(e.currentTarget.currentTime)} onSeeked={e => setTime(e.currentTarget.currentTime)}
              style={{ display: 'block', background: '#000', borderRadius: 10, ...(portrait ? { height: 'min(62vh, 640px)' } : { width: '100%' }) }} />
          ) : (
            <div style={{ ...box, padding: 20, width: portrait ? 300 : '100%', ...muted }}>No draft rendered yet.</div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <select value={shownV?.v ?? ''} onChange={e => setVersion(Number(e.target.value))} style={input}>
              {playable.slice().reverse().map(v => <option key={v.v} value={v.v}>v{v.v}{v === latest ? ' (latest)' : ''}</option>)}
            </select>
            <span style={muted}>{fmtT(time)} / {fmtT(d.duration)}</span>
          </div>
          {shownV?.note && <div style={{ ...muted, marginTop: 4, maxWidth: portrait ? 360 : undefined }}>v{shownV.v}: {shownV.note}</div>}
        </div>

        {/* Notes */}
        <div style={{ flex: '1 1 340px', minWidth: 300 }}>
          <div style={{ ...box, padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Note at {fmtT(time)} on v{shownV?.v ?? '—'}</div>
            <textarea value={noteText} onChange={e => setNoteText(e.target.value)} rows={3} placeholder="What should change here?"
              style={{ ...input, width: '100%', boxSizing: 'border-box', fontSize: 13, resize: 'vertical' }}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && noteText.trim()) void addNote(); }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12 }}><input type="radio" checked={noteKind === 'fix'} onChange={() => setNoteKind('fix')} /> Fix this video</label>
              <label style={{ fontSize: 12 }} title="A rule for every future edit. Claude turns it into a general rule for you to approve."><input type="radio" checked={noteKind === 'lesson'} onChange={() => setNoteKind('lesson')} /> Lesson for all edits</label>
              <button className="btn btn--sm btn--primary" style={{ marginLeft: 'auto' }} disabled={!noteText.trim() || !!busy} onClick={() => void addNote()}>Save note</button>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>Notes</span>
            <label style={{ ...muted, marginLeft: 'auto' }}><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} /> show done</label>
          </div>
          <div style={{ maxHeight: 360, overflow: 'auto' }}>
            {visibleNotes.length === 0 && <div style={muted}>No open notes.</div>}
            {visibleNotes.map(n => (
              <div key={n.id} style={{ ...box, padding: '8px 10px', marginBottom: 6, opacity: n.status === 'open' || n.rule_status === 'pending' ? 1 : 0.6 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <button className="btn btn--sm" onClick={() => n.t != null && seek(n.t)} title="Jump to this moment">{fmtT(n.t)}</button>
                  <span style={{ fontSize: 10, fontWeight: 700, color: n.kind === 'lesson' ? '#a855f7' : '#3b82f6', textTransform: 'uppercase' }}>{n.kind}</span>
                  <span style={muted}>v{n.version ?? '—'} · {n.author}</span>
                  <span style={{ ...muted, marginLeft: 'auto' }}>{n.status}</span>
                </div>
                <div style={{ fontSize: 13, marginTop: 4, whiteSpace: 'pre-wrap' }}>{n.text}</div>
                {n.reply && <div style={{ fontSize: 12, marginTop: 4, color: 'var(--text-muted)' }}>Claude: {n.reply}</div>}
                {n.rule && (
                  <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 6, background: 'var(--bg)', fontSize: 12 }}>
                    <div><strong>Proposed rule:</strong> {n.rule}</div>
                    {n.rule_status === 'pending' ? (
                      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                        <button className="btn btn--sm btn--primary" disabled={!!busy} onClick={() => void editNote(n.id, { rule_status: 'approved', status: 'done' })}>Approve rule</button>
                        <button className="btn btn--sm" disabled={!!busy} onClick={() => void editNote(n.id, { rule_status: 'rejected' })}>Reject</button>
                      </div>
                    ) : <div style={{ ...muted, marginTop: 4 }}>rule {n.rule_status}</div>}
                  </div>
                )}
                {n.status === 'open' && n.kind === 'fix' && (
                  <button className="btn btn--sm" style={{ marginTop: 6 }} disabled={!!busy} onClick={() => void editNote(n.id, { status: 'done' })}>Mark done</button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Timeline */}
      <Timeline name={name} tl={tl} duration={d.duration} sources={d.sources} time={time} zoom={zoom} setZoom={setZoom}
        notes={notes.filter(n => n.t != null)} onSeek={seek} />

      {/* Render / export */}
      <div style={{ ...box, padding: 12, marginTop: 14, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn--sm" disabled={running || !!busy} onClick={() => void act('render', () => w(`/edits/${enc(name)}/render`, { method: 'POST', body: {} }))}>Render new draft</button>
        <span style={{ width: 1, height: 22, background: 'var(--border)' }} />
        <input value={exportName} onChange={e => setExportName(e.target.value)} style={{ ...input, width: 260 }} title="File name in the ad library (2026 B2C/<mmdd>/)" />
        <button className="btn btn--sm btn--primary" disabled={running || !!busy || !exportName.trim()}
          onClick={() => void act('export', () => w(`/edits/${enc(name)}/export`, { method: 'POST', body: { name: exportName.trim() } }))}>Export final to library</button>
        {d.versions.some(v => v.export) && playable.length > 0 && (
          <button className="btn btn--sm" disabled={running || !!busy} onClick={() => void act('cleanup', () => w(`/edits/${enc(name)}/cleanup`, { method: 'POST' }))}>Delete drafts</button>
        )}
        {running && <span style={{ fontSize: 12 }}>{d.job.kind} running…</span>}
        {d.job?.state === 'error' && <span style={{ fontSize: 12, color: '#fb9292' }}>{d.job.kind} failed: {d.job.error}</span>}
        {d.job?.state === 'done' && d.job.kind === 'final export' && <span style={{ fontSize: 12, color: '#16a34a' }}>Exported: {d.job.result}</span>}
        {d.versions.filter(v => v.export).slice(-1).map(v => <span key={v.v} style={muted}>last export: {v.export.split(/[\\/]/).slice(-2).join('/')}</span>)}
      </div>
    </div>
  );
}

function Timeline({ name, tl, duration, sources, time, zoom, setZoom, notes, onSeek }) {
  const enc = encodeURIComponent;
  const scroller = useRef(null);
  const width = Math.max(600, Math.ceil(duration * zoom) + 40);
  const rows = [
    ['video', 'Video', tl.video || []],
    ['overlays', 'Overlays', tl.overlays || []],
    ['captions', 'Captions', tl.captions || []],
    ['audio', 'Audio', tl.audio || []],
  ].filter(([, , items]) => items.length);
  const span = (kind, it) => {
    if (kind === 'video') {
      const len = it.dur != null ? it.dur : (it.out - (it.in || 0)) / (it.speed || 1);
      return [it.start || 0, (it.start || 0) + len];
    }
    if (kind === 'audio') {
      const src = sources[it.src]?.duration;
      const len = it.out != null ? it.out - (it.in || 0) : (src ? src - (it.in || 0) : duration - (it.start || 0));
      return [it.start || 0, Math.min(duration, (it.start || 0) + len)];
    }
    return [it.start, it.end];
  };
  const ticks = useMemo(() => {
    const step = zoom >= 80 ? 1 : zoom >= 30 ? 2 : zoom >= 12 ? 5 : 10;
    return Array.from({ length: Math.floor(duration / step) + 1 }, (_, i) => i * step);
  }, [duration, zoom]);
  useEffect(() => {   // keep the playhead in view
    const el = scroller.current;
    const x = time * zoom;
    if (el && (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40)) el.scrollLeft = Math.max(0, x - 80);
  }, [time, zoom]);
  const click = e => {
    const r = e.currentTarget.getBoundingClientRect();
    onSeek(Math.min(duration, Math.max(0, (e.clientX - r.left) / zoom)));
  };
  const H = 46;

  return (
    <div style={{ ...box, marginTop: 14, padding: '8px 0 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px 6px' }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Timeline</span>
        <span style={muted}>click to jump · shows the latest edit</span>
        <label style={{ ...muted, marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          zoom <input type="range" min="8" max="160" value={zoom} onChange={e => setZoom(Number(e.target.value))} />
        </label>
      </div>
      <div style={{ display: 'flex' }}>
        <div style={{ flex: '0 0 76px', paddingTop: 20 }}>
          {rows.map(([k, label]) => <div key={k} style={{ height: H, marginBottom: 4, display: 'flex', alignItems: 'center', paddingLeft: 12, fontSize: 11, fontWeight: 700, color: ROW_COLORS[k] }}>{label}</div>)}
        </div>
        <div ref={scroller} style={{ overflowX: 'auto', flex: 1 }}>
          <div style={{ position: 'relative', width, cursor: 'pointer' }} onClick={click}>
            {/* ruler + note markers */}
            <div style={{ height: 20, position: 'relative', borderBottom: '1px solid var(--border)' }}>
              {ticks.map(t => <span key={t} style={{ position: 'absolute', left: t * zoom, fontSize: 10, color: 'var(--text-muted)', paddingLeft: 3, borderLeft: '1px solid var(--border)', height: 20 }}>{fmtT(t).replace(/\.0$/, '')}</span>)}
              {notes.map(n => <span key={n.id} title={`${n.kind}: ${n.text}`} style={{ position: 'absolute', left: n.t * zoom - 5, top: 6, width: 10, height: 10, borderRadius: 5, background: n.kind === 'lesson' ? '#a855f7' : n.status === 'open' ? '#ef4444' : '#9ca3af' }} />)}
            </div>
            {rows.map(([k, , items]) => (
              <div key={k} style={{ position: 'relative', height: H, marginTop: 4 }}>
                {items.map((it, i) => {
                  const [s, e] = span(k, it);
                  const left = s * zoom, wpx = Math.max(3, (e - s) * zoom);
                  const thumb = (k === 'video' || k === 'overlays') && it.src
                    ? `${WORKER_URL}/edits/${enc(name)}/thumb?src=${enc(it.src)}&t=${(it.in || 0) + 0.1}` : null;
                  const missing = it.src && sources[it.src] && !sources[it.src].exists;
                  return (
                    <div key={it.id || i} title={`${it.label || it.text || it.src || ''}\n${fmtT(s)} → ${fmtT(e)}${missing ? '\nFILE MISSING' : ''}`}
                      style={{ position: 'absolute', left, width: wpx, top: 0, bottom: 0, borderRadius: 5, overflow: 'hidden',
                        background: missing ? '#7f1d1d' : `${ROW_COLORS[k]}33`, border: `1px solid ${ROW_COLORS[k]}`, boxSizing: 'border-box' }}>
                      {thumb && <img src={thumb} alt="" loading="lazy" style={{ height: '100%', float: 'left', marginRight: 4, opacity: 0.9 }} />}
                      {k === 'audio' && it.src && <Wave name={name} src={it.src} start={it.in || 0} seconds={e - s} width={wpx} height={H - 2} color={ROW_COLORS.audio} />}
                      <span style={{ position: 'relative', fontSize: 10, padding: '2px 4px', whiteSpace: 'nowrap', color: 'var(--text)', textShadow: '0 0 3px var(--surface)' }}>
                        {it.label || it.text || (it.src || '').split('/').pop()}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: time * zoom, width: 2, background: '#ef4444', pointerEvents: 'none' }} />
          </div>
        </div>
      </div>
      {Object.entries(sources).some(([, s]) => !s.exists) && (
        <div style={{ fontSize: 11, color: '#fb9292', padding: '6px 12px 0' }}>
          Missing on this computer (still syncing from Drive?): {Object.entries(sources).filter(([, s]) => !s.exists).map(([k]) => k.split('/').pop()).join(', ')}
        </div>
      )}
    </div>
  );
}

const waveCache = new Map();
function Wave({ name, src, start, seconds, width, height, color }) {
  const key = `${name}|${src}`;
  const [data, setData] = useState(() => waveCache.get(key) || null);
  useEffect(() => {
    if (data) return;
    let live = true;
    w(`/edits/${encodeURIComponent(name)}/wave?src=${encodeURIComponent(src)}`, { timeout: 60000 })
      .then(d => { waveCache.set(key, d); if (live) setData(d); }).catch(() => {});
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;
  const from = Math.floor(start * data.pps), n = Math.max(1, Math.round(seconds * data.pps));
  const peaks = data.peaks.slice(from, from + n);
  const bw = width / n;
  return (
    <svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0 }} aria-hidden>
      {peaks.map((p, i) => { const h = Math.max(1, p * height); return <rect key={i} x={i * bw} y={(height - h) / 2} width={Math.max(1, bw - 0.5)} height={h} fill={color} opacity="0.55" />; })}
    </svg>
  );
}
