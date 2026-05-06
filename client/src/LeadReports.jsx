import { useState, useEffect, useCallback } from 'react';

const BASE     = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const SHEET_ID = '16c7rc3LmPcRRMpw5u4lbk5wq8Mwizma8ynNB1nu9Prw';
const SHEET_URL  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
const SHEET_EMBED = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/htmlview?embedded=true`;

const fmt$ = v => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = d => { const [y, m, day] = d.split('-'); return `${m}/${day}/${y}`; };

export default function LeadReports() {
  const [reports, setReports]     = useState([]);
  const [dragging, setDragging]   = useState(false);
  const [uploading, setUploading] = useState(false);
  const [results, setResults]     = useState(null);
  const [error, setError]         = useState(null);

  const loadReports = useCallback(async () => {
    try {
      const j = await fetch(`${BASE}/api/hyros/reports`).then(r => r.json());
      if (j.ok) setReports(j.reports);
    } catch {}
  }, []);

  useEffect(() => { loadReports(); }, [loadReports]);

  const uploadFiles = useCallback(async (files) => {
    const csvFiles = [...files].filter(f => f.name.toLowerCase().endsWith('.csv'));
    if (!csvFiles.length) return;
    setUploading(true); setResults(null); setError(null);
    try {
      const fd = new FormData();
      csvFiles.forEach(f => fd.append('files', f));
      const j = await fetch(`${BASE}/api/hyros/upload-report`, { method: 'POST', body: fd }).then(r => r.json());
      setResults(j.results || []);
      await loadReports();
    } catch (e) { setError(e.message); }
    finally { setUploading(false); }
  }, [loadReports]);

  const deleteReport = useCallback(async (date) => {
    await fetch(`${BASE}/api/hyros/reports/${date}`, { method: 'DELETE' });
    setReports(prev => prev.filter(r => r.date !== date));
  }, []);

  const clearAll = useCallback(async () => {
    if (!window.confirm('Delete all stored reports? You will need to re-upload all CSV files.')) return;
    await fetch(`${BASE}/api/hyros/reports`, { method: 'DELETE' });
    setReports([]);
  }, []);

  const onDrop = useCallback(e => {
    e.preventDefault(); setDragging(false);
    uploadFiles(e.dataTransfer.files);
  }, [uploadFiles]);

  return (
    <div className="lr-page">
      {/* Left column: upload */}
      <div className="lr-sidebar">
        <div className="lr-header">
          <h2 className="lr-title">Lead Reports</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {reports.length > 0 && (
              <button onClick={clearAll} className="lr-clear-btn" title="Delete all stored reports">
                Clear All
              </button>
            )}
            <a href={SHEET_URL} target="_blank" rel="noopener noreferrer" className="lr-sheet-link">
              Open Sheet ↗
            </a>
          </div>
        </div>
        <p className="lr-subtitle">
          Upload daily Hyros CSV exports. Re-uploading the same day replaces existing data.
          Uploaded days use CSV spend + leads; other days fall back to the Hyros API.
        </p>

        {/* Drop zone */}
        <label
          className={`lr-zone${dragging ? ' lr-zone--active' : ''}${uploading ? ' lr-zone--uploading' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input type="file" accept=".csv" multiple onChange={e => { uploadFiles(e.target.files); e.target.value = ''; }} style={{ display: 'none' }} />
          <div className="lr-zone-icon">{uploading ? '…' : '↑'}</div>
          <div className="lr-zone-text">
            {uploading ? 'Uploading…' : dragging ? 'Drop to upload' : 'Drop CSVs here or click to browse'}
          </div>
          <div className="lr-zone-hint">Report MM-DD-YYYY - MM-DD-YYYY.csv · Multiple files OK</div>
        </label>

        {/* Results */}
        {results && results.length > 0 && (
          <div className="lr-results">
            {results.map((r, i) => (
              <div key={i} className={`lr-result${r.ok ? ' lr-result--ok' : ' lr-result--err'}`}>
                {r.ok
                  ? `✓ ${fmtDate(r.date)} · ${r.rowCount} adsets · ${r.totalLeads} leads · ${fmt$(r.totalSpend)}`
                  : `✗ ${r.file} — ${r.error}`}
              </div>
            ))}
          </div>
        )}
        {error && <div className="lr-results"><div className="lr-result lr-result--err">Upload error: {error}</div></div>}

        {/* Uploaded dates */}
        {reports.length > 0 ? (
          <div className="lr-table-wrap">
            <table className="lr-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Leads</th>
                  <th>Spend</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {reports.map(r => (
                  <tr key={r.date}>
                    <td className="lr-td-date">{fmtDate(r.date)}</td>
                    <td className="lr-td-leads">{r.totalLeads}</td>
                    <td className="lr-td-spend">{fmt$(r.totalSpend)}</td>
                    <td>
                      <button className="lr-del" onClick={() => deleteReport(r.date)} title="Remove">×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !uploading && <div className="lr-empty">No reports uploaded yet.</div>
        )}
      </div>

      {/* Right column: embedded sheet */}
      <div className="lr-sheet-wrap">
        <iframe
          src={SHEET_EMBED}
          className="lr-sheet-iframe"
          title="Google Sheet"
          allowFullScreen
        />
      </div>
    </div>
  );
}
