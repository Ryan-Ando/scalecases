import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { extractStateFromFilename, extractStateFromCampaign, STATE_NAMES } from './launcherStates.js';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const SETTINGS_KEY = 'launcher_settings';

const CTA_TYPES = [
  'LEARN_MORE', 'SIGN_UP', 'GET_QUOTE', 'CONTACT_US', 'APPLY_NOW',
  'BOOK_TRAVEL', 'DOWNLOAD', 'GET_OFFER', 'GET_STARTED', 'SUBSCRIBE',
];

// ── Inline style tokens ───────────────────────────────────────────────────────
const S = {
  bg: '#0f172a',
  card: '#1e293b',
  border: '#334155',
  text: '#f1f5f9',
  muted: '#94a3b8',
  blue: '#3b82f6',
  green: '#22c55e',
  yellow: '#eab308',
  orange: '#f97316',
  red: '#ef4444',
};

const cardStyle = {
  background: S.card,
  border: `1px solid ${S.border}`,
  borderRadius: 10,
  padding: '16px 20px',
  marginBottom: 16,
};

const inputStyle = {
  background: '#0f172a',
  border: `1px solid ${S.border}`,
  borderRadius: 6,
  color: S.text,
  padding: '7px 10px',
  fontSize: 13,
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

const btnStyle = (color = S.blue, disabled = false) => ({
  background: disabled ? '#334155' : color,
  color: disabled ? S.muted : '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '7px 14px',
  fontSize: 13,
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontWeight: 600,
  whiteSpace: 'nowrap',
});

const labelStyle = {
  color: S.muted,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  marginBottom: 4,
  display: 'block',
};

function Spinner() {
  return (
    <span style={{ display: 'inline-block', width: 14, height: 14, border: `2px solid ${S.border}`, borderTopColor: S.blue, borderRadius: '50%', animation: 'spin 0.7s linear infinite', verticalAlign: 'middle' }} />
  );
}

export default function AdsLauncher() {
  // ── Settings ─────────────────────────────────────────────────────────────
  const [settings, setSettings] = useState(() => {
    try {
      const saved = localStorage.getItem(SETTINGS_KEY);
      return saved ? JSON.parse(saved) : { pageId: '', adCopy: '', ctaType: 'LEARN_MORE', ctaUrl: '' };
    } catch {
      return { pageId: '', adCopy: '', ctaType: 'LEARN_MORE', ctaUrl: '' };
    }
  });

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  function updateSetting(key, value) {
    setSettings(p => ({ ...p, [key]: value }));
  }

  // ── Campaigns ─────────────────────────────────────────────────────────────
  const [campaigns, setCampaigns] = useState([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignsError, setCampaignsError] = useState('');

  const fetchCampaigns = useCallback(async () => {
    setCampaignsLoading(true);
    setCampaignsError('');
    try {
      const r = await fetch(`${BASE}/api/launcher/campaigns`);
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || 'Failed to load campaigns');
      const withState = json.map(c => ({ ...c, stateCode: extractStateFromCampaign(c.name) }));
      setCampaigns(withState);
    } catch (e) {
      setCampaignsError(e.message);
    } finally {
      setCampaignsLoading(false);
    }
  }, []);

  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);

  // ── Files ─────────────────────────────────────────────────────────────────
  const [files, setFiles] = useState([]); // [{file: File, name: string, stateCode: string|null}]
  const fileInputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  function addFiles(fileList) {
    const newEntries = Array.from(fileList).map(f => ({
      file: f,
      name: f.name,
      stateCode: extractStateFromFilename(f.name),
    }));
    setFiles(p => [...p, ...newEntries]);
  }

  function removeFile(idx) {
    setFiles(p => p.filter((_, i) => i !== idx));
    setChosenCampaigns(p => {
      const next = { ...p };
      delete next[idx];
      return next;
    });
    setChosenAdsets(p => {
      const next = { ...p };
      delete next[idx];
      return next;
    });
    setRowStatuses(p => {
      const next = { ...p };
      delete next[idx];
      return next;
    });
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  }

  // ── Ad Sets ───────────────────────────────────────────────────────────────
  const [adsets, setAdsets] = useState({}); // campaignId → [{id, name, status}]
  const [loadingAdsets, setLoadingAdsets] = useState(new Set());

  const fetchAdsets = useCallback(async (campaignId) => {
    if (adsets[campaignId] || loadingAdsets.has(campaignId)) return;
    setLoadingAdsets(p => new Set([...p, campaignId]));
    try {
      const r = await fetch(`${BASE}/api/launcher/adsets/${campaignId}`);
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || 'Failed to load adsets');
      setAdsets(p => ({ ...p, [campaignId]: json }));
    } catch (e) {
      setAdsets(p => ({ ...p, [campaignId]: [] }));
    } finally {
      setLoadingAdsets(p => { const next = new Set(p); next.delete(campaignId); return next; });
    }
  }, [adsets, loadingAdsets]);

  // ── Chosen campaigns / adsets (user overrides) ────────────────────────────
  const [chosenCampaigns, setChosenCampaigns] = useState({}); // fileIdx → campaignId
  const [chosenAdsets, setChosenAdsets] = useState({}); // fileIdx → adsetId

  // ── Matches (derived) ─────────────────────────────────────────────────────
  const matches = useMemo(() => files.map((f, idx) => {
    if (!f.stateCode) return { ...f, idx, status: 'no_state', matchedCampaigns: [] };
    const matched = campaigns.filter(c => c.stateCode === f.stateCode);
    if (matched.length === 0) return { ...f, idx, status: 'no_match', matchedCampaigns: [] };
    if (matched.length > 1) {
      const chosen = chosenCampaigns[idx];
      const campaign = matched.find(c => c.id === chosen) || null;
      return { ...f, idx, status: campaign ? 'ready' : 'ambiguous', matchedCampaigns: matched, campaign };
    }
    return { ...f, idx, status: 'ready', matchedCampaigns: matched, campaign: matched[0] };
  }), [files, campaigns, chosenCampaigns]);

  // Auto-fetch adsets for ready matches
  useEffect(() => {
    for (const m of matches) {
      if (m.status === 'ready' && m.campaign && !adsets[m.campaign.id] && !loadingAdsets.has(m.campaign.id)) {
        fetchAdsets(m.campaign.id);
      }
    }
  }, [matches, adsets, loadingAdsets, fetchAdsets]);

  // Auto-set first adset when adsets load for a campaign
  useEffect(() => {
    setChosenAdsets(prev => {
      const next = { ...prev };
      for (const m of matches) {
        if (m.status === 'ready' && m.campaign) {
          const campaignAdsets = adsets[m.campaign.id];
          if (campaignAdsets && campaignAdsets.length > 0 && !next[m.idx]) {
            next[m.idx] = campaignAdsets[0].id;
          }
        }
      }
      return next;
    });
  }, [adsets, matches]);

  // ── Launch ────────────────────────────────────────────────────────────────
  const [confirmLaunch, setConfirmLaunch] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [rowStatuses, setRowStatuses] = useState({}); // fileIdx → {phase, error, adId}
  const [launchSummary, setLaunchSummary] = useState(null);

  const readyCount = matches.filter(m => m.status === 'ready').length;

  async function doLaunch() {
    setLaunching(true);
    setConfirmLaunch(false);
    setLaunchSummary(null);
    let succeeded = 0;
    let failed = 0;

    for (const m of matches) {
      if (m.status !== 'ready') continue;
      const adsetId = chosenAdsets[m.idx] || adsets[m.campaign.id]?.[0]?.id;
      if (!adsetId) continue;
      const idx = m.idx;
      try {
        setRowStatuses(p => ({ ...p, [idx]: { phase: 'uploading' } }));
        const fd = new FormData();
        fd.append('file', m.file);
        const upRes = await fetch(`${BASE}/api/launcher/upload`, { method: 'POST', body: fd });
        const upJson = await upRes.json();
        if (!upRes.ok) throw new Error(upJson.error);

        setRowStatuses(p => ({ ...p, [idx]: { phase: 'creative' } }));
        const crRes = await fetch(`${BASE}/api/launcher/creative`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: m.name,
            pageId: settings.pageId,
            adCopy: settings.adCopy,
            ctaType: settings.ctaType,
            ctaUrl: settings.ctaUrl,
            mediaType: upJson.type,
            videoId: upJson.video_id,
            imageHash: upJson.image_hash,
          }),
        });
        const crJson = await crRes.json();
        if (!crRes.ok) throw new Error(crJson.error);

        setRowStatuses(p => ({ ...p, [idx]: { phase: 'ad' } }));
        const adRes = await fetch(`${BASE}/api/launcher/ad`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: m.name, adsetId, creativeId: crJson.creative_id }),
        });
        const adJson = await adRes.json();
        if (!adRes.ok) throw new Error(adJson.error);

        setRowStatuses(p => ({ ...p, [idx]: { phase: 'done', adId: adJson.ad_id } }));
        succeeded++;
      } catch (e) {
        setRowStatuses(p => ({ ...p, [idx]: { phase: 'error', error: e.message } }));
        failed++;
      }
    }

    setLaunching(false);
    setLaunchSummary({ succeeded, failed });
  }

  // ── Render helpers ────────────────────────────────────────────────────────
  function renderRowStatus(m) {
    const rs = rowStatuses[m.idx];
    if (rs) {
      if (rs.phase === 'uploading') return <span style={{ color: S.blue }}><Spinner /> Uploading...</span>;
      if (rs.phase === 'creative') return <span style={{ color: S.blue }}><Spinner /> Creating creative...</span>;
      if (rs.phase === 'ad') return <span style={{ color: S.blue }}><Spinner /> Creating ad...</span>;
      if (rs.phase === 'done') return <span style={{ color: S.green }}>Done</span>;
      if (rs.phase === 'error') return <span style={{ color: S.red }}>Error: {rs.error}</span>;
    }
    if (m.status === 'no_state') return <span style={{ color: S.red }}>No state in filename</span>;
    if (m.status === 'no_match') return <span style={{ color: S.orange }}>No campaign match</span>;
    if (m.status === 'ambiguous') return <span style={{ color: S.yellow }}>Ambiguous ({m.matchedCampaigns.length} matches)</span>;
    if (m.status === 'ready') return <span style={{ color: S.green }}>Ready</span>;
    return null;
  }

  function renderAdsetCell(m) {
    if (m.status === 'no_state' || m.status === 'no_match') return <span style={{ color: S.muted }}>—</span>;
    if (!m.campaign) return <span style={{ color: S.muted }}>—</span>;

    const campaignAdsets = adsets[m.campaign.id];
    const isLoading = loadingAdsets.has(m.campaign.id);

    if (isLoading) return <span style={{ color: S.muted, fontSize: 12 }}><Spinner /> Loading adsets...</span>;
    if (!campaignAdsets || campaignAdsets.length === 0) return <span style={{ color: S.muted }}>No adsets</span>;

    return (
      <select
        value={chosenAdsets[m.idx] || campaignAdsets[0]?.id || ''}
        onChange={e => setChosenAdsets(p => ({ ...p, [m.idx]: e.target.value }))}
        style={{ ...inputStyle, padding: '4px 8px', fontSize: 12 }}
      >
        {campaignAdsets.map(a => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
    );
  }

  function renderCampaignCell(m) {
    if (m.status === 'no_state') return <span style={{ color: S.muted }}>—</span>;
    if (m.status === 'no_match') return <span style={{ color: S.orange }}>No match for {m.stateCode} ({STATE_NAMES[m.stateCode]})</span>;
    if (m.status === 'ambiguous' || (m.status === 'ready' && m.matchedCampaigns?.length > 1)) {
      return (
        <select
          value={chosenCampaigns[m.idx] || ''}
          onChange={e => setChosenCampaigns(p => ({ ...p, [m.idx]: e.target.value }))}
          style={{ ...inputStyle, padding: '4px 8px', fontSize: 12 }}
        >
          <option value="">— pick campaign —</option>
          {m.matchedCampaigns.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      );
    }
    if (m.campaign) return <span style={{ color: S.text, fontSize: 12 }}>{m.campaign.name}</span>;
    return <span style={{ color: S.muted }}>—</span>;
  }

  // ── JSX ───────────────────────────────────────────────────────────────────
  return (
    <div style={{ background: S.bg, minHeight: '100vh', padding: '24px 28px', color: S.text, fontFamily: 'system-ui, sans-serif', fontSize: 14 }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <h2 style={{ margin: '0 0 20px', fontWeight: 700, fontSize: 20 }}>Ads Launcher</h2>

      {/* A. Settings panel */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 600, marginBottom: 12, fontSize: 13, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Settings</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 1fr', gap: 12, alignItems: 'start' }}>
          <div>
            <label style={labelStyle}>Facebook Page ID</label>
            <input
              style={inputStyle}
              placeholder="Facebook Page ID"
              value={settings.pageId}
              onChange={e => updateSetting('pageId', e.target.value)}
            />
          </div>
          <div>
            <label style={labelStyle}>Ad Copy / Message</label>
            <textarea
              style={{ ...inputStyle, resize: 'vertical', minHeight: 56 }}
              placeholder="Ad copy / message"
              rows={2}
              value={settings.adCopy}
              onChange={e => updateSetting('adCopy', e.target.value)}
            />
          </div>
          <div>
            <label style={labelStyle}>CTA Type</label>
            <select
              style={inputStyle}
              value={settings.ctaType}
              onChange={e => updateSetting('ctaType', e.target.value)}
            >
              {CTA_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>CTA URL</label>
            <input
              style={inputStyle}
              placeholder="https://"
              value={settings.ctaUrl}
              onChange={e => updateSetting('ctaUrl', e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* B. Campaign section */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: 13, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Campaigns</span>
          {campaignsLoading ? (
            <span style={{ color: S.muted, fontSize: 13 }}><Spinner /> Loading campaigns...</span>
          ) : (
            <span style={{ background: '#0f172a', border: `1px solid ${S.border}`, borderRadius: 20, padding: '2px 10px', fontSize: 12, color: S.text }}>
              {campaigns.length} campaigns loaded
            </span>
          )}
          <button
            style={btnStyle(S.blue, campaignsLoading)}
            onClick={() => !campaignsLoading && fetchCampaigns()}
            disabled={campaignsLoading}
          >
            Refresh
          </button>
          {campaignsError && <span style={{ color: S.red, fontSize: 12 }}>{campaignsError}</span>}
        </div>
      </div>

      {/* C. File drop zone */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 600, marginBottom: 12, fontSize: 13, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Creative Files</div>
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          style={{
            border: `2px dashed ${dragOver ? S.blue : S.border}`,
            borderRadius: 8,
            padding: '32px 20px',
            textAlign: 'center',
            cursor: 'pointer',
            color: dragOver ? S.blue : S.muted,
            transition: 'border-color 0.15s, color 0.15s',
            fontSize: 14,
            userSelect: 'none',
          }}
        >
          Drop creative files here or click to browse
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*"
          style={{ display: 'none' }}
          onChange={e => { addFiles(e.target.files); e.target.value = ''; }}
        />

        {files.length > 0 && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {files.map((f, idx) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#0f172a', border: `1px solid ${S.border}`, borderRadius: 6, padding: '6px 10px' }}>
                <span style={{ flex: 1, fontSize: 12, color: S.text, wordBreak: 'break-all' }}>{f.name}</span>
                <span style={{ fontSize: 12, color: f.stateCode ? S.green : S.red, whiteSpace: 'nowrap' }}>
                  {f.stateCode ? `${f.stateCode} — ${STATE_NAMES[f.stateCode]}` : 'No state detected'}
                </span>
                <button
                  onClick={() => removeFile(idx)}
                  style={{ background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 16, padding: '0 2px', lineHeight: 1 }}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* D. Match table */}
      {files.length > 0 && campaigns.length > 0 && (
        <div style={{ ...cardStyle, overflowX: 'auto' }}>
          <div style={{ fontWeight: 600, marginBottom: 12, fontSize: 13, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Match Table</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: S.muted, textAlign: 'left' }}>
                {['File', 'State', 'Matched Campaign', 'Ad Set', 'Status'].map(h => (
                  <th key={h} style={{ padding: '6px 10px', borderBottom: `1px solid ${S.border}`, fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matches.map((m, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${S.border}` }}>
                  <td style={{ padding: '8px 10px', maxWidth: 220, wordBreak: 'break-all', fontSize: 12 }}>{m.name}</td>
                  <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', fontSize: 12 }}>
                    {m.stateCode ? <span style={{ color: S.text }}>{m.stateCode} — {STATE_NAMES[m.stateCode]}</span> : <span style={{ color: S.red }}>—</span>}
                  </td>
                  <td style={{ padding: '8px 10px', minWidth: 200 }}>{renderCampaignCell(m)}</td>
                  <td style={{ padding: '8px 10px', minWidth: 180 }}>{renderAdsetCell(m)}</td>
                  <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{renderRowStatus(m)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* E. Launch bar */}
      {files.length > 0 && (
        <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <span style={{ color: S.text, fontWeight: 600 }}>
            {readyCount} ready to launch
          </span>

          {!confirmLaunch && (
            <button
              style={btnStyle(S.green, readyCount === 0 || launching)}
              onClick={() => readyCount > 0 && !launching && setConfirmLaunch(true)}
              disabled={readyCount === 0 || launching}
            >
              {launching ? <><Spinner /> Launching...</> : 'Launch All'}
            </button>
          )}

          {confirmLaunch && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#0f172a', border: `1px solid ${S.border}`, borderRadius: 8, padding: '8px 14px' }}>
              <span style={{ color: S.yellow, fontWeight: 600, fontSize: 13 }}>
                Launch {readyCount} ads as PAUSED? This cannot be undone.
              </span>
              <button style={btnStyle(S.green)} onClick={doLaunch}>Confirm</button>
              <button style={btnStyle('#475569')} onClick={() => setConfirmLaunch(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}

      {/* F. Results summary */}
      {launchSummary && (
        <div style={{ ...cardStyle, borderColor: launchSummary.failed > 0 ? S.orange : S.green }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>
            {launchSummary.succeeded} launched successfully{launchSummary.failed > 0 ? `, ${launchSummary.failed} failed` : ''}
          </div>
          {launchSummary.failed > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {matches.map(m => {
                const rs = rowStatuses[m.idx];
                if (rs?.phase === 'error') {
                  return (
                    <div key={m.idx} style={{ fontSize: 12, color: S.red }}>
                      {m.name}: {rs.error}
                    </div>
                  );
                }
                return null;
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
