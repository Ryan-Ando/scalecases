import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { extractStateFromFilename, extractStateFromCampaign, STATE_NAMES } from './launcherStates.js';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const CONFIG_KEY   = 'launcher_config_v2';
const PRESETS_KEY  = 'launcher_presets_v1';
const TEMPLATE_KEY = 'launcher_templates_v1';

// ── Constants ─────────────────────────────────────────────────────────────────
const CTA_TYPES = [
  'LEARN_MORE','SIGN_UP','GET_QUOTE','CONTACT_US','APPLY_NOW',
  'BOOK_TRAVEL','DOWNLOAD','GET_OFFER','GET_STARTED','SUBSCRIBE',
  'CALL_NOW','WATCH_MORE','OPEN_LINK',
];

const CONVERSION_EVENTS = [
  { value: 'LEAD',                  label: 'Lead' },
  { value: 'PURCHASE',              label: 'Purchase' },
  { value: 'COMPLETE_REGISTRATION', label: 'Complete Registration' },
  { value: 'ADD_TO_CART',           label: 'Add to Cart' },
  { value: 'INITIATE_CHECKOUT',     label: 'Initiate Checkout' },
  { value: 'ADD_PAYMENT_INFO',      label: 'Add Payment Info' },
  { value: 'SEARCH',                label: 'Search' },
  { value: 'VIEW_CONTENT',          label: 'View Content' },
  { value: 'CONTACT',               label: 'Contact' },
  { value: 'SCHEDULE',              label: 'Schedule' },
  { value: 'SUBMIT_APPLICATION',    label: 'Submit Application' },
  { value: 'SUBSCRIBE',             label: 'Subscribe' },
  { value: 'START_TRIAL',           label: 'Start Trial' },
  { value: 'DONATE',                label: 'Donate' },
  { value: 'FIND_LOCATION',         label: 'Find Location' },
];

const PLACEMENT_OPTIONS = [
  { id: 'fb_feed',          label: 'Facebook Feed' },
  { id: 'ig_feed',          label: 'Instagram Feed' },
  { id: 'fb_story',         label: 'Facebook Stories' },
  { id: 'ig_story',         label: 'Instagram Stories' },
  { id: 'fb_reels',         label: 'Facebook Reels' },
  { id: 'ig_reels',         label: 'Instagram Reels' },
  { id: 'fb_marketplace',   label: 'FB Marketplace' },
  { id: 'fb_right_column',  label: 'FB Right Column' },
  { id: 'audience_network', label: 'Audience Network' },
  { id: 'messenger_inbox',  label: 'Messenger Inbox' },
  { id: 'messenger_story',  label: 'Messenger Stories' },
];

const DEFAULT_MANUAL_PLACEMENTS = Object.fromEntries(PLACEMENT_OPTIONS.map(p => [p.id, false]));

const DEFAULT_CONFIG = {
  // Ad Content
  pageId: '',
  adSetup: 'SINGLE',
  primaryText: '',
  headline: '',
  description: '',
  ctaType: 'LEARN_MORE',
  destinationUrl: '',
  urlParameters: '',
  // Adset Setup
  conversionLocation: 'WEBSITE',
  pixelId: '',
  conversionEvent: 'LEAD',
  costPerResultGoal: '',
  attributionSetting: '7D_CLICK_1D_VIEW',
  // Budget & Schedule
  budgetType: 'DAILY',
  budgetAmount: '',
  startTime: '',
  endTime: '',
  // Audience
  ageMin: 18,
  ageMax: 65,
  genders: '0',
  countries: 'US',
  advantagePlusAudience: true,
  customAudienceIds: '',
  targetingSpec: '',
  // Placements
  placementsType: 'ADVANTAGE_PLUS',
  manualPlacements: { ...DEFAULT_MANUAL_PLACEMENTS },
};

function loadStored(key, fallback) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; }
  catch { return fallback; }
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S = {
  bg: '#0f172a', card: '#1e293b', border: '#334155',
  text: '#f1f5f9', muted: '#94a3b8',
  blue: '#3b82f6', green: '#22c55e', yellow: '#eab308',
  orange: '#f97316', red: '#ef4444',
};
const cardStyle  = { background: S.card, border: `1px solid ${S.border}`, borderRadius: 10, padding: '14px 18px', marginBottom: 12 };
const inputStyle = { background: '#0f172a', border: `1px solid ${S.border}`, borderRadius: 6, color: S.text, padding: '6px 10px', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' };
const labelStyle = { color: S.muted, fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 3, display: 'block' };
const btn = (color = S.blue, disabled = false) => ({ background: disabled ? '#334155' : color, color: disabled ? S.muted : '#fff', border: 'none', borderRadius: 6, padding: '6px 13px', fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 600, whiteSpace: 'nowrap' });

function Spinner() {
  return <span style={{ display: 'inline-block', width: 13, height: 13, border: `2px solid ${S.border}`, borderTopColor: S.blue, borderRadius: '50%', animation: 'spin 0.7s linear infinite', verticalAlign: 'middle', marginRight: 5 }} />;
}

function Field({ label, children, col }) {
  return (
    <div style={col ? { gridColumn: col } : {}}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

function Section({ title, id, open, onToggle, children }) {
  return (
    <div style={cardStyle}>
      <button onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', color: S.text, cursor: 'pointer', width: '100%', textAlign: 'left', padding: 0 }}>
        <span style={{ color: S.muted, fontSize: 10, width: 10 }}>{open ? '▼' : '▶'}</span>
        <span style={{ fontWeight: 700, fontSize: 13, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</span>
      </button>
      {open && <div style={{ marginTop: 14 }}>{children}</div>}
    </div>
  );
}

// Extract concept name = everything before state code in filename
function extractConcept(filename) {
  const base = filename.replace(/\.[^.]+$/, '');
  const parts = base.split('-');
  const result = [];
  for (const p of parts) {
    if (STATE_NAMES[p.toUpperCase()]) break;
    result.push(p);
  }
  return result.join(' ') || base;
}

function resolveTemplate(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

// ── Main component ────────────────────────────────────────────────────────────
export default function AdsLauncher() {

  // Config (all preset-able settings)
  const [config, setConfig] = useState(() => ({ ...DEFAULT_CONFIG, ...loadStored(CONFIG_KEY, {}) }));
  const [presets, setPresets]           = useState(() => loadStored(PRESETS_KEY, {}));
  const [presetName, setPresetName]     = useState('');
  const [activePreset, setActivePreset] = useState('');
  const [openSections, setOpenSections] = useState(new Set(['adContent']));

  // Name templates (not saved in preset)
  const [adsetNameTpl, setAdsetNameTpl] = useState(() => loadStored(TEMPLATE_KEY, {}).adset || '{concept} - {state} - {date}');
  const [adNameTpl,    setAdNameTpl]    = useState(() => loadStored(TEMPLATE_KEY, {}).ad    || '{filename}');

  // Adset mode
  const [createNewAdset, setCreateNewAdset] = useState(true);

  // Campaigns
  const [campaigns, setCampaigns]               = useState([]);
  const [selectedCampaigns, setSelectedCampaigns] = useState(new Set()); // IDs toggled on
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignsError, setCampaignsError]     = useState('');

  // Files
  const [files, setFiles]     = useState([]);
  const fileInputRef           = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  // Adsets (existing, for "use existing" mode)
  const [adsets, setAdsets]             = useState({});
  const [loadingAdsets, setLoadingAdsets] = useState(new Set());
  const [chosenCampaigns, setChosenCampaigns] = useState({});
  const [chosenAdsets, setChosenAdsets]   = useState({});

  // Launch
  const [confirmLaunch, setConfirmLaunch] = useState(false);
  const [launching, setLaunching]         = useState(false);
  const [rowStatuses, setRowStatuses]     = useState({});
  const [launchSummary, setLaunchSummary] = useState(null);

  // ── Persistence ──────────────────────────────────────────────────────────
  useEffect(() => { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); }, [config]);
  useEffect(() => { localStorage.setItem(TEMPLATE_KEY, JSON.stringify({ adset: adsetNameTpl, ad: adNameTpl })); }, [adsetNameTpl, adNameTpl]);

  function updateConfig(key, value) { setConfig(p => ({ ...p, [key]: value })); }
  function toggleSection(id) {
    setOpenSections(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  // ── Presets ───────────────────────────────────────────────────────────────
  function savePreset(name) {
    const updated = { ...presets, [name]: { ...config } };
    setPresets(updated);
    localStorage.setItem(PRESETS_KEY, JSON.stringify(updated));
    setActivePreset(name);
  }
  function loadPresetByName(name) {
    if (!presets[name]) return;
    setConfig({ ...DEFAULT_CONFIG, ...presets[name] });
    setActivePreset(name);
  }
  function deletePreset(name) {
    const updated = { ...presets };
    delete updated[name];
    setPresets(updated);
    localStorage.setItem(PRESETS_KEY, JSON.stringify(updated));
    if (activePreset === name) setActivePreset('');
  }

  // ── Campaigns ─────────────────────────────────────────────────────────────
  const fetchCampaigns = useCallback(async () => {
    setCampaignsLoading(true); setCampaignsError('');
    try {
      const r = await fetch(`${BASE}/api/launcher/campaigns`);
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || 'Failed');
      const mapped = json.map(c => ({ ...c, stateCode: extractStateFromCampaign(c.name) }));
      setCampaigns(mapped);
      setSelectedCampaigns(new Set(mapped.map(c => c.id))); // all selected by default
    } catch (e) { setCampaignsError(e.message); }
    finally { setCampaignsLoading(false); }
  }, []);

  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);

  // ── Files ─────────────────────────────────────────────────────────────────
  function addFiles(fileList) {
    setFiles(p => [...p, ...Array.from(fileList).map(f => ({ file: f, name: f.name, stateCode: extractStateFromFilename(f.name) }))]);
  }
  function removeFile(idx) {
    setFiles(p => p.filter((_, i) => i !== idx));
    setChosenCampaigns(p => { const n = { ...p }; delete n[idx]; return n; });
    setChosenAdsets(p => { const n = { ...p }; delete n[idx]; return n; });
    setRowStatuses(p => { const n = { ...p }; delete n[idx]; return n; });
  }

  // ── Adsets (existing) ─────────────────────────────────────────────────────
  const fetchAdsets = useCallback(async (campaignId) => {
    if (adsets[campaignId] || loadingAdsets.has(campaignId)) return;
    setLoadingAdsets(p => new Set([...p, campaignId]));
    try {
      const r = await fetch(`${BASE}/api/launcher/adsets/${campaignId}`);
      const json = await r.json();
      setAdsets(p => ({ ...p, [campaignId]: r.ok ? json : [] }));
    } catch { setAdsets(p => ({ ...p, [campaignId]: [] })); }
    finally { setLoadingAdsets(p => { const n = new Set(p); n.delete(campaignId); return n; }); }
  }, [adsets, loadingAdsets]);

  // ── Matches ───────────────────────────────────────────────────────────────
  const matches = useMemo(() => files.map((f, idx) => {
    if (!f.stateCode) return { ...f, idx, status: 'no_state', matchedCampaigns: [] };
    const matched = campaigns.filter(c => c.stateCode === f.stateCode && selectedCampaigns.has(c.id));
    if (matched.length === 0) return { ...f, idx, status: 'no_match', matchedCampaigns: [] };
    if (matched.length > 1) {
      const campaign = matched.find(c => c.id === chosenCampaigns[idx]) || null;
      return { ...f, idx, status: campaign ? 'ready' : 'ambiguous', matchedCampaigns: matched, campaign };
    }
    return { ...f, idx, status: 'ready', matchedCampaigns: matched, campaign: matched[0] };
  }), [files, campaigns, chosenCampaigns, selectedCampaigns]);

  // Auto-fetch existing adsets for ready matches (when using existing mode)
  useEffect(() => {
    if (!createNewAdset) {
      for (const m of matches) {
        if (m.status === 'ready' && m.campaign && !adsets[m.campaign.id] && !loadingAdsets.has(m.campaign.id))
          fetchAdsets(m.campaign.id);
      }
    }
  }, [matches, adsets, loadingAdsets, fetchAdsets, createNewAdset]);

  // Auto-select first adset when adsets load
  useEffect(() => {
    setChosenAdsets(prev => {
      const next = { ...prev };
      for (const m of matches) {
        if (m.status === 'ready' && m.campaign) {
          const list = adsets[m.campaign.id];
          if (list?.length && !next[m.idx]) next[m.idx] = list[0].id;
        }
      }
      return next;
    });
  }, [adsets, matches]);

  const readyCount = matches.filter(m => m.status === 'ready').length;

  // ── Name resolution ───────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);

  function resolveAdsetName(m) {
    return resolveTemplate(adsetNameTpl, {
      concept: extractConcept(m.name),
      state: m.stateCode || '??',
      stateName: STATE_NAMES[m.stateCode] || m.stateCode || '??',
      date: today,
      filename: m.name.replace(/\.[^.]+$/, ''),
    });
  }
  function resolveAdName(m) {
    return resolveTemplate(adNameTpl, {
      concept: extractConcept(m.name),
      state: m.stateCode || '??',
      stateName: STATE_NAMES[m.stateCode] || m.stateCode || '??',
      date: today,
      filename: m.name.replace(/\.[^.]+$/, ''),
    });
  }

  // ── Launch ────────────────────────────────────────────────────────────────
  async function doLaunch() {
    setLaunching(true); setConfirmLaunch(false); setLaunchSummary(null);
    let succeeded = 0, failed = 0;

    for (const m of matches) {
      if (m.status !== 'ready') continue;
      const idx = m.idx;
      try {
        let adsetId;

        if (createNewAdset) {
          setRowStatuses(p => ({ ...p, [idx]: { phase: 'adset' } }));
          const asRes = await fetch(`${BASE}/api/launcher/adset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: resolveAdsetName(m),
              campaignId: m.campaign.id,
              ...config,
            }),
          });
          const asJson = await asRes.json();
          if (!asRes.ok) throw new Error(asJson.error);
          adsetId = asJson.adset_id;
        } else {
          adsetId = chosenAdsets[idx] || adsets[m.campaign.id]?.[0]?.id;
          if (!adsetId) throw new Error('No adset selected');
        }

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
            name: resolveAdName(m),
            pageId: config.pageId,
            primaryText: config.primaryText,
            headline: config.headline,
            description: config.description,
            ctaType: config.ctaType,
            destinationUrl: config.destinationUrl,
            urlParameters: config.urlParameters,
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
          body: JSON.stringify({ name: resolveAdName(m), adsetId, creativeId: crJson.creative_id }),
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
  function renderStatus(m) {
    const rs = rowStatuses[m.idx];
    if (rs) {
      if (rs.phase === 'adset')    return <span style={{ color: S.blue }}><Spinner />Creating adset…</span>;
      if (rs.phase === 'uploading')return <span style={{ color: S.blue }}><Spinner />Uploading…</span>;
      if (rs.phase === 'creative') return <span style={{ color: S.blue }}><Spinner />Creating creative…</span>;
      if (rs.phase === 'ad')       return <span style={{ color: S.blue }}><Spinner />Creating ad…</span>;
      if (rs.phase === 'done')     return <span style={{ color: S.green }}>✓ Done</span>;
      if (rs.phase === 'error')    return <span style={{ color: S.red, fontSize: 11 }}>✗ {rs.error}</span>;
    }
    if (m.status === 'no_state') return <span style={{ color: S.red }}>No state in filename</span>;
    if (m.status === 'no_match') return <span style={{ color: S.orange }}>No campaign match</span>;
    if (m.status === 'ambiguous') return <span style={{ color: S.yellow }}>Ambiguous ({m.matchedCampaigns.length} matches)</span>;
    if (m.status === 'ready') return <span style={{ color: S.green }}>Ready</span>;
    return null;
  }

  function renderCampaignCell(m) {
    if (m.status === 'no_state') return <span style={{ color: S.muted }}>—</span>;
    if (m.status === 'no_match') return <span style={{ color: S.orange }}>No match ({m.stateCode})</span>;
    if (m.status === 'ambiguous' || (m.status === 'ready' && m.matchedCampaigns?.length > 1)) {
      return (
        <select value={chosenCampaigns[m.idx] || ''} onChange={e => setChosenCampaigns(p => ({ ...p, [m.idx]: e.target.value }))} style={{ ...inputStyle, padding: '4px 8px', fontSize: 12 }}>
          <option value="">— pick campaign —</option>
          {m.matchedCampaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      );
    }
    return <span style={{ fontSize: 12 }}>{m.campaign?.name || '—'}</span>;
  }

  function renderAdsetCell(m) {
    if (!m.campaign) return <span style={{ color: S.muted }}>—</span>;
    if (createNewAdset) {
      return <span style={{ color: S.muted, fontSize: 11, fontStyle: 'italic' }}>{resolveAdsetName(m)}</span>;
    }
    const list = adsets[m.campaign.id];
    if (loadingAdsets.has(m.campaign.id)) return <span style={{ color: S.muted, fontSize: 12 }}><Spinner />Loading…</span>;
    if (!list?.length) return <span style={{ color: S.muted }}>No adsets</span>;
    return (
      <select value={chosenAdsets[m.idx] || list[0]?.id || ''} onChange={e => setChosenAdsets(p => ({ ...p, [m.idx]: e.target.value }))} style={{ ...inputStyle, padding: '4px 8px', fontSize: 12 }}>
        {list.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
    );
  }

  // ── JSX ───────────────────────────────────────────────────────────────────
  const grid2 = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };
  const grid3 = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 };
  const grid4 = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 };

  return (
    <div style={{ background: S.bg, minHeight: '100vh', padding: '22px 26px', color: S.text, fontFamily: 'system-ui, sans-serif', fontSize: 14 }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <h2 style={{ margin: '0 0 16px', fontWeight: 700, fontSize: 20 }}>Ads Launcher</h2>

      {/* ── Preset bar ─────────────────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 12, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Presets</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={activePreset}
            onChange={e => { setActivePreset(e.target.value); if (e.target.value) loadPresetByName(e.target.value); }}
            style={{ ...inputStyle, width: 210 }}
          >
            <option value="">— No preset loaded —</option>
            {Object.keys(presets).map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          {activePreset && <button style={btn('#64748b')} onClick={() => deletePreset(activePreset)}>Delete</button>}
          <div style={{ width: 1, height: 26, background: S.border, margin: '0 4px' }} />
          <input
            style={{ ...inputStyle, width: 170 }}
            placeholder="New preset name…"
            value={presetName}
            onChange={e => setPresetName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && presetName.trim()) { savePreset(presetName.trim()); setPresetName(''); } }}
          />
          <button
            style={btn(S.blue, !presetName.trim())}
            disabled={!presetName.trim()}
            onClick={() => { savePreset(presetName.trim()); setPresetName(''); }}
          >
            Save Preset
          </button>
          <span style={{ fontSize: 11, color: S.muted }}>Saves all settings below (not names)</span>
        </div>
      </div>

      {/* ── Ad Content ─────────────────────────────────────────────────── */}
      <Section title="Ad Content" id="adContent" open={openSections.has('adContent')} onToggle={() => toggleSection('adContent')}>
        <div style={grid2}>
          <Field label="Facebook Page ID">
            <input style={inputStyle} placeholder="e.g. 123456789" value={config.pageId} onChange={e => updateConfig('pageId', e.target.value)} />
          </Field>
          <Field label="Ad Setup">
            <select style={inputStyle} value={config.adSetup} onChange={e => updateConfig('adSetup', e.target.value)}>
              <option value="SINGLE">Single Image / Video</option>
              <option value="CAROUSEL">Carousel</option>
            </select>
          </Field>
          <Field label="Primary Text" col="1 / -1">
            <textarea rows={3} style={{ ...inputStyle, resize: 'vertical' }} placeholder="Ad body copy…" value={config.primaryText} onChange={e => updateConfig('primaryText', e.target.value)} />
          </Field>
          <Field label="Headline">
            <input style={inputStyle} placeholder="Short headline" value={config.headline} onChange={e => updateConfig('headline', e.target.value)} />
          </Field>
          <Field label="Description">
            <input style={inputStyle} placeholder="Optional description" value={config.description} onChange={e => updateConfig('description', e.target.value)} />
          </Field>
          <Field label="CTA Type">
            <select style={inputStyle} value={config.ctaType} onChange={e => updateConfig('ctaType', e.target.value)}>
              {CTA_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Destination URL">
            <input style={inputStyle} placeholder="https://" value={config.destinationUrl} onChange={e => updateConfig('destinationUrl', e.target.value)} />
          </Field>
          <Field label="URL Parameters" col="1 / -1">
            <input style={inputStyle} placeholder="utm_source=facebook&utm_medium=paid&utm_campaign=prospecting" value={config.urlParameters} onChange={e => updateConfig('urlParameters', e.target.value)} />
          </Field>
        </div>
      </Section>

      {/* ── Adset Setup ────────────────────────────────────────────────── */}
      <Section title="Adset Setup" id="adsetSetup" open={openSections.has('adsetSetup')} onToggle={() => toggleSection('adsetSetup')}>
        <div style={grid3}>
          <Field label="Conversion Location">
            <select style={inputStyle} value={config.conversionLocation} onChange={e => updateConfig('conversionLocation', e.target.value)}>
              <option value="WEBSITE">Website</option>
              <option value="LEAD_GENERATION">Instant Forms (Lead Gen)</option>
              <option value="MESSAGING">Messaging Apps</option>
              <option value="CALLS">Calls</option>
              <option value="APP">App</option>
            </select>
          </Field>
          <Field label="Dataset / Pixel ID">
            <input style={inputStyle} placeholder="Pixel or dataset ID" value={config.pixelId} onChange={e => updateConfig('pixelId', e.target.value)} />
          </Field>
          <Field label="Conversion Event">
            <select style={inputStyle} value={config.conversionEvent} onChange={e => updateConfig('conversionEvent', e.target.value)}>
              {CONVERSION_EVENTS.map(ev => <option key={ev.value} value={ev.value}>{ev.label}</option>)}
            </select>
          </Field>
          <Field label="Cost Per Result Goal ($)">
            <input style={inputStyle} type="number" min="0" step="0.01" placeholder="Leave blank = lowest cost" value={config.costPerResultGoal} onChange={e => updateConfig('costPerResultGoal', e.target.value)} />
          </Field>
          <Field label="Attribution Setting">
            <select style={inputStyle} value={config.attributionSetting} onChange={e => updateConfig('attributionSetting', e.target.value)}>
              <option value="7D_CLICK_1D_VIEW">7-day click, 1-day view</option>
              <option value="7D_CLICK">7-day click only</option>
              <option value="1D_CLICK">1-day click only</option>
              <option value="1D_VIEW">1-day view only</option>
            </select>
          </Field>
        </div>
      </Section>

      {/* ── Budget & Schedule ───────────────────────────────────────────── */}
      <Section title="Budget & Schedule" id="budget" open={openSections.has('budget')} onToggle={() => toggleSection('budget')}>
        <div style={grid4}>
          <Field label="Budget Type">
            <select style={inputStyle} value={config.budgetType} onChange={e => updateConfig('budgetType', e.target.value)}>
              <option value="DAILY">Daily Budget</option>
              <option value="LIFETIME">Lifetime Budget</option>
            </select>
          </Field>
          <Field label="Amount ($)">
            <input style={inputStyle} type="number" min="1" step="0.01" placeholder="e.g. 50" value={config.budgetAmount} onChange={e => updateConfig('budgetAmount', e.target.value)} />
          </Field>
          <Field label="Start Date / Time">
            <input style={inputStyle} type="datetime-local" value={config.startTime} onChange={e => updateConfig('startTime', e.target.value)} />
          </Field>
          <Field label="End Date / Time (optional)">
            <input style={inputStyle} type="datetime-local" value={config.endTime} onChange={e => updateConfig('endTime', e.target.value)} />
          </Field>
        </div>
      </Section>

      {/* ── Audience ───────────────────────────────────────────────────── */}
      <Section title="Audience" id="audience" open={openSections.has('audience')} onToggle={() => toggleSection('audience')}>
        <div style={grid4}>
          <Field label="Age Min">
            <input style={inputStyle} type="number" min={13} max={65} value={config.ageMin} onChange={e => updateConfig('ageMin', e.target.value)} />
          </Field>
          <Field label="Age Max">
            <input style={inputStyle} type="number" min={13} max={65} value={config.ageMax} onChange={e => updateConfig('ageMax', e.target.value)} />
          </Field>
          <Field label="Gender">
            <select style={inputStyle} value={config.genders} onChange={e => updateConfig('genders', e.target.value)}>
              <option value="0">All Genders</option>
              <option value="1">Male Only</option>
              <option value="2">Female Only</option>
            </select>
          </Field>
          <Field label="Countries (comma-separated)">
            <input style={inputStyle} placeholder="US,CA" value={config.countries} onChange={e => updateConfig('countries', e.target.value)} />
          </Field>
        </div>
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={config.advantagePlusAudience} onChange={e => updateConfig('advantagePlusAudience', e.target.checked)} />
            Enable Advantage+ Audience
          </label>
          <div>
            <label style={labelStyle}>Custom Audience IDs (comma-separated)</label>
            <input style={inputStyle} placeholder="123456,789012" value={config.customAudienceIds} onChange={e => updateConfig('customAudienceIds', e.target.value)} />
          </div>
          <div>
            <label style={{ ...labelStyle, marginBottom: 3 }}>Advanced Targeting JSON <span style={{ color: S.muted, fontWeight: 400, textTransform: 'none' }}>(overrides all fields above)</span></label>
            <textarea
              rows={3}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace', fontSize: 11 }}
              placeholder={'{"geo_locations": {"countries": ["US"]}, "age_min": 25, "interests": [...]}'}
              value={config.targetingSpec}
              onChange={e => updateConfig('targetingSpec', e.target.value)}
            />
          </div>
        </div>
      </Section>

      {/* ── Placements ─────────────────────────────────────────────────── */}
      <Section title="Placements" id="placements" open={openSections.has('placements')} onToggle={() => toggleSection('placements')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
            <input type="radio" checked={config.placementsType === 'ADVANTAGE_PLUS'} onChange={() => updateConfig('placementsType', 'ADVANTAGE_PLUS')} />
            Advantage+ Placements <span style={{ color: S.muted, fontSize: 12 }}>(recommended — Meta optimises automatically)</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
            <input type="radio" checked={config.placementsType === 'MANUAL'} onChange={() => updateConfig('placementsType', 'MANUAL')} />
            Manual Placements
          </label>
        </div>
        {config.placementsType === 'MANUAL' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {PLACEMENT_OPTIONS.map(p => (
              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={config.manualPlacements[p.id] || false}
                  onChange={e => updateConfig('manualPlacements', { ...config.manualPlacements, [p.id]: e.target.checked })}
                />
                {p.label}
              </label>
            ))}
          </div>
        )}
      </Section>

      {/* ── Name Templates ─────────────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 12, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Name Templates</div>
        <div style={{ fontSize: 11, color: S.muted, marginBottom: 10 }}>
          Variables: <code style={{ background: '#0f172a', padding: '1px 4px', borderRadius: 3 }}>{'{concept}'}</code>{' '}
          <code style={{ background: '#0f172a', padding: '1px 4px', borderRadius: 3 }}>{'{state}'}</code>{' '}
          <code style={{ background: '#0f172a', padding: '1px 4px', borderRadius: 3 }}>{'{stateName}'}</code>{' '}
          <code style={{ background: '#0f172a', padding: '1px 4px', borderRadius: 3 }}>{'{date}'}</code>{' '}
          <code style={{ background: '#0f172a', padding: '1px 4px', borderRadius: 3 }}>{'{filename}'}</code>
        </div>
        <div style={grid2}>
          <Field label="Adset Name Template">
            <input style={inputStyle} value={adsetNameTpl} onChange={e => setAdsetNameTpl(e.target.value)} />
          </Field>
          <Field label="Ad Name Template">
            <input style={inputStyle} value={adNameTpl} onChange={e => setAdNameTpl(e.target.value)} />
          </Field>
        </div>
      </div>

      {/* ── Campaigns ──────────────────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: campaigns.length ? 12 : 0 }}>
          <span style={{ fontWeight: 700, fontSize: 12, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Live Campaigns</span>
          {campaignsLoading
            ? <span style={{ color: S.muted, fontSize: 13 }}><Spinner />Loading…</span>
            : <span style={{ background: '#0f172a', border: `1px solid ${S.border}`, borderRadius: 20, padding: '2px 10px', fontSize: 12 }}>
                {selectedCampaigns.size} / {campaigns.length} selected
              </span>
          }
          <button style={btn(S.blue, campaignsLoading)} onClick={fetchCampaigns} disabled={campaignsLoading}>Refresh</button>
          {campaigns.length > 0 && <>
            <button style={btn('#475569')} onClick={() => setSelectedCampaigns(new Set(campaigns.map(c => c.id)))}>Select All</button>
            <button style={btn('#475569')} onClick={() => setSelectedCampaigns(new Set())}>Deselect All</button>
          </>}
          {campaignsError && <span style={{ color: S.red, fontSize: 12 }}>{campaignsError}</span>}
        </div>
        {campaigns.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {campaigns.map(c => {
              const on = selectedCampaigns.has(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedCampaigns(p => {
                    const n = new Set(p);
                    on ? n.delete(c.id) : n.add(c.id);
                    return n;
                  })}
                  style={{
                    background: on ? '#1d4ed8' : '#0f172a',
                    border: `1px solid ${on ? S.blue : S.border}`,
                    borderRadius: 6,
                    color: on ? '#fff' : S.muted,
                    padding: '5px 10px',
                    fontSize: 12,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    maxWidth: 280,
                  }}
                  title={c.name}
                >
                  {c.stateCode && (
                    <span style={{ background: on ? '#3b82f6' : S.border, borderRadius: 4, padding: '1px 5px', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                      {c.stateCode}
                    </span>
                  )}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── File drop zone ─────────────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 12, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Creative Files</div>
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
          style={{ border: `2px dashed ${dragOver ? S.blue : S.border}`, borderRadius: 8, padding: '28px 20px', textAlign: 'center', cursor: 'pointer', color: dragOver ? S.blue : S.muted, transition: 'all 0.15s', userSelect: 'none' }}
        >
          Drop creative files here or click to browse
          <div style={{ fontSize: 11, marginTop: 4 }}>Files should follow: <code style={{ background: '#0f172a', padding: '1px 5px', borderRadius: 3 }}>ConceptName-TX-v1.mp4</code></div>
        </div>
        <input ref={fileInputRef} type="file" multiple accept="image/*,video/*" style={{ display: 'none' }} onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
        {files.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
            {files.map((f, idx) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#0f172a', border: `1px solid ${S.border}`, borderRadius: 6, padding: '5px 10px' }}>
                <span style={{ flex: 1, fontSize: 12, wordBreak: 'break-all' }}>{f.name}</span>
                <span style={{ fontSize: 12, color: f.stateCode ? S.green : S.red, whiteSpace: 'nowrap' }}>
                  {f.stateCode ? `${f.stateCode} — ${STATE_NAMES[f.stateCode]}` : 'No state detected'}
                </span>
                <button onClick={() => removeFile(idx)} style={{ background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 16, padding: '0 2px', lineHeight: 1 }}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Adset mode toggle ──────────────────────────────────────────── */}
      {files.length > 0 && (
        <div style={{ ...cardStyle, display: 'flex', gap: 20, alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 12, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>Adset Mode</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="radio" checked={createNewAdset} onChange={() => setCreateNewAdset(true)} />
            Create new adset per creative (uses config above)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="radio" checked={!createNewAdset} onChange={() => setCreateNewAdset(false)} />
            Add to existing adset
          </label>
        </div>
      )}

      {/* ── Match table ────────────────────────────────────────────────── */}
      {files.length > 0 && campaigns.length > 0 && (
        <div style={{ ...cardStyle, overflowX: 'auto' }}>
          <div style={{ fontWeight: 700, fontSize: 12, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Match Table</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: S.muted }}>
                {['File', 'State', 'Campaign', createNewAdset ? 'New Adset Name' : 'Adset', 'Status'].map(h => (
                  <th key={h} style={{ padding: '6px 10px', borderBottom: `1px solid ${S.border}`, fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'left', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matches.map((m, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${S.border}` }}>
                  <td style={{ padding: '7px 10px', maxWidth: 200, wordBreak: 'break-all', fontSize: 12 }}>{m.name}</td>
                  <td style={{ padding: '7px 10px', whiteSpace: 'nowrap', fontSize: 12 }}>
                    {m.stateCode ? `${m.stateCode} — ${STATE_NAMES[m.stateCode]}` : <span style={{ color: S.red }}>—</span>}
                  </td>
                  <td style={{ padding: '7px 10px', minWidth: 180 }}>{renderCampaignCell(m)}</td>
                  <td style={{ padding: '7px 10px', minWidth: 180 }}>{renderAdsetCell(m)}</td>
                  <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>{renderStatus(m)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Launch bar ─────────────────────────────────────────────────── */}
      {files.length > 0 && (
        <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700 }}>{readyCount} ready to launch</span>
          {!confirmLaunch && (
            <button style={btn(S.green, readyCount === 0 || launching)} onClick={() => readyCount > 0 && !launching && setConfirmLaunch(true)} disabled={readyCount === 0 || launching}>
              {launching ? <><Spinner />Launching…</> : 'Launch All'}
            </button>
          )}
          {confirmLaunch && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#0f172a', border: `1px solid ${S.border}`, borderRadius: 8, padding: '8px 14px' }}>
              <span style={{ color: S.yellow, fontWeight: 600, fontSize: 13 }}>
                Launch {readyCount} ad{readyCount !== 1 ? 's' : ''} as PAUSED? This cannot be undone.
              </span>
              <button style={btn(S.green)} onClick={doLaunch}>Confirm</button>
              <button style={btn('#475569')} onClick={() => setConfirmLaunch(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}

      {/* ── Results ────────────────────────────────────────────────────── */}
      {launchSummary && (
        <div style={{ ...cardStyle, borderColor: launchSummary.failed > 0 ? S.orange : S.green }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>
            {launchSummary.succeeded} launched successfully{launchSummary.failed > 0 ? `, ${launchSummary.failed} failed` : ''}
          </div>
          {matches.filter(m => rowStatuses[m.idx]?.phase === 'error').map(m => (
            <div key={m.idx} style={{ fontSize: 12, color: S.red, marginTop: 4 }}>
              {m.name}: {rowStatuses[m.idx].error}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
