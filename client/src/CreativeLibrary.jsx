import { useMemo, useState } from 'react';
import { groupLibrary } from './creativeMatching.js';
import { useCreativeLibrary, refreshLibrary, enableLocalPreviews, LOCAL_LIBRARY_URL } from './useCreativeLibrary.js';

export function CreativePreview({ file, enabled }) {
  if (!file || !enabled) return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{file?.kind === 'video' ? 'Video' : 'Image'}</span>;
  const src = `${LOCAL_LIBRARY_URL}/preview/${file.id}`;
  return file.kind === 'video'
    ? <video key={src} crossOrigin="anonymous" src={src} controls preload="none" style={{ width: 110, height: 70, objectFit: 'contain' }} />
    : <img key={src} crossOrigin="anonymous" src={src} loading="lazy" alt={file.name} style={{ width: 110, height: 70, objectFit: 'contain' }} />;
}

export default function CreativeLibrary({ ads = [], merges = [], deleted = new Set() }) {
  const library = useCreativeLibrary();
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(30);
  const groups = useMemo(() => groupLibrary(library.files, [...ads, ...(library.evidence?.inventory.ads || [])], merges, deleted), [library.files, library.evidence, ads, merges, deleted]);
  const complete = library.connected && library.evidence?.inventory.complete && !library.evidenceError;
  const fresh = groups.filter(g => !g.known);
  const filtered = fresh.filter(g => `${g.name} ${g.files.map(f => f.relativePath).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return <section style={{ margin: '16px 0 24px', padding: 16, border: '1px solid var(--border)', borderRadius: 10 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <strong>Local creative library</strong>
      <span style={{ fontSize: 12 }}>{library.connected ? `${library.files.length} files / ${groups.length} combined creatives` : 'Not connected'}</span>
      <button className="btn btn--sm" onClick={refreshLibrary} disabled={library.loading}>{library.loading ? 'Connecting...' : 'Connect / Refresh'}</button>
      <label style={{ fontSize: 12 }}><input type="checkbox" checked={library.previews} onChange={enableLocalPreviews} /> Local previews</label>
    </div>
    <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Automatically checks this computer every minute. Files and previews stay on this computer. New files are grouped using your existing ad combinations.</p>
    {library.error && <p role="status" style={{ fontSize: 12, color: '#b45309' }}>{library.error}</p>}
    {library.evidenceError && <p role="status" style={{ fontSize: 12, color: '#b45309' }}>Facebook check: {library.evidenceError}</p>}
    {library.connected && !complete && <p role="status">Facebook inventory is incomplete or still loading. New-ad recommendations are withheld until all connected accounts are checked.</p>}
    {library.files.length > 0 && <details>
      <summary style={{ cursor: 'pointer', marginBottom: 12 }}>{fresh.length} {complete ? 'creatives not found in synced Facebook accounts' : 'creatives awaiting confirmation'} — view library</summary>
      <input aria-label="Search local creatives" placeholder="Search ad name or folder" value={query} onChange={e => { setQuery(e.target.value); setLimit(30); }} style={{ marginBottom: 12, padding: 6 }} />
      <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <thead><tr>{['Preview', 'Ad', 'Folder / date', 'Versions', 'Status'].map(h => <th key={h} style={{ textAlign: 'left', padding: 8 }}>{h}</th>)}</tr></thead>
        <tbody>{filtered.slice(0, limit).map(group => <tr key={group.key}>
          <td style={{ padding: 8 }}><CreativePreview file={group.files[0]} enabled={library.previews && library.connected} /></td>
          <td style={{ padding: 8 }}>{group.name}</td>
          <td style={{ padding: 8 }}>{group.files[0].folder || '/'}<br />{group.date || 'Date unknown'}</td>
          <td style={{ padding: 8 }}>{group.files.length} file(s){group.files.some(f => f.state) ? `; ${[...new Set(group.files.map(f => f.state).filter(Boolean))].join(', ')}` : ''}<details><summary>File paths</summary>{group.files.map(f => <div key={f.id}>{f.relativePath}</div>)}</details></td>
          <td style={{ padding: 8 }}>{complete ? 'Untested in synced accounts' : 'Unverified'}</td>
        </tr>)}</tbody>
      </table></div>
      {filtered.length > limit && <button className="btn btn--sm" onClick={() => setLimit(n => n + 30)}>Show more</button>}
      <p style={{ fontSize: 11 }}>Facebook matches use all available statuses, including inactive ads. Permanently deleted or inaccessible ads may not be available in Facebook's inventory. Existing saved matches are retained.</p>
    </details>}
  </section>;
}
