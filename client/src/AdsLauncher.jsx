import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { extractStateFromFilename, extractStateFromCampaign, STATE_NAMES } from './launcherStates.js';

const BASE              = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const GLOBAL_KEY          = 'launcher_global_v2';
const CAMPAIGN_CFGS_KEY   = 'launcher_campaign_configs_v1';
const PRESETS_KEY         = 'launcher_presets_v2';
const DEFAULT_PRESET_KEY  = 'launcher_default_preset';

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

const CREATIVE_ENHANCEMENTS = [
  { id: 'standard_enhancements',     label: 'Standard Enhancements (all)',  group: 'Standard' },
  { id: 'image_brightness_contrast', label: 'Brightness & Contrast',        group: 'Standard' },
  { id: 'image_templates',           label: 'Image Templates',              group: 'Standard' },
  { id: 'relevant_comments',         label: 'Relevant Comments',            group: 'Standard' },
  { id: 'add_text',                  label: 'Add Text Overlay',             group: 'Standard' },
  { id: 'translate',                 label: 'Auto-Translate',               group: 'Standard' },
  { id: 'advantage_plus_creative',   label: 'Advantage+ Creative (all)',    group: 'Advantage+' },
  { id: 'music',                     label: 'Music',                        group: 'Advantage+' },
  { id: 'image_uncrop',              label: 'Image Expansion (Uncrop)',     group: 'Advantage+' },
  { id: 'profile_card',              label: 'Profile Card',                 group: 'Advantage+' },
  { id: '3d_animation',              label: '3D Animation',                 group: 'Advantage+' },
];

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEFAULT_GLOBAL = {
  advantagePlusAudience: true,
  ageMin: 18, ageMax: 65, genders: '0', countries: 'US',
  customAudienceIds: '', targetingSpec: '',
  placementsType: 'ADVANTAGE_PLUS',
  manualPlacements: { ...DEFAULT_MANUAL_PLACEMENTS },
  creativeEnhancements: {},
  urlParameters: '', languages: '',
};

const DEFAULT_CAMPAIGN_CONFIG = {
  stateCodeOverride: '',
  pageId: '', adSetup: 'SINGLE',
  primaryText: '', headline: '', description: '',
  ctaType: 'LEARN_MORE', destinationUrl: '',
  conversionLocation: 'WEBSITE', pixelId: '',
  conversionEvent: 'LEAD', costPerResultGoal: '',
  attributionSetting: '7D_CLICK_1D_VIEW',
  budgetType: 'DAILY', budgetAmount: '',
  startTime: '', endTime: '',
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
  orange: '#f97316', red: '#ef4444', purple: '#a855f7',
};
const cardStyle  = { background: S.card, border: `1px solid ${S.border}`, borderRadius: 10, padding: '14px 18px', marginBottom: 12 };
const inputStyle = { background: '#0f172a', border: `1px solid ${S.border}`, borderRadius: 6, color: S.text, padding: '6px 10px', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' };
const labelStyle = { color: S.muted, fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 3, display: 'block' };
const btn = (color = S.blue, disabled = false) => ({ background: disabled ? '#334155' : color, color: disabled ? S.muted : '#fff', border: 'none', borderRadius: 6, padding: '6px 13px', fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 600, whiteSpace: 'nowrap' });

const grid2 = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };
const grid3 = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 };
const grid4 = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 };

function Spinner() {
  return <span style={{ display: 'inline-block', width: 13, height: 13, border: `2px solid ${S.border}`, borderTopColor: S.blue, borderRadius: '50%', animation: 'spin 0.7s linear infinite', verticalAlign: 'middle', marginRight: 5 }} />;
}
function Field({ label, children, col, hint }) {
  return (
    <div style={col ? { gridColumn: col } : {}}>
      <label style={labelStyle}>{label}{hint && <span style={{ color: S.muted, fontWeight: 400, textTransform: 'none', marginLeft: 4 }}>{hint}</span>}</label>
      {children}
    </div>
  );
}
function SectionHeader({ title, open, onToggle }) {
  return (
    <button onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', color: S.text, cursor: 'pointer', width: '100%', textAlign: 'left', padding: 0, marginBottom: open ? 12 : 0 }}>
      <span style={{ color: S.muted, fontSize: 10, width: 10 }}>{open ? '▼' : '▶'}</span>
      <span style={{ fontWeight: 700, fontSize: 12, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</span>
    </button>
  );
}
function extractConcept(filename) {
  const base = filename.replace(/\.[^.]+$/, '');
  const parts = base.split('-');
  const result = [];
  for (const p of parts) { if (STATE_NAMES[p.toUpperCase()]) break; result.push(p); }
  return result.join(' ') || base;
}
function adNameFromFile(filename) {
  const base = filename.replace(/\.[^.]+$/, '');
  const filtered = base.split('-').filter(p => !STATE_NAMES[p.toUpperCase()]);
  return filtered.join('-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
}

// ── Campaign Config Panel (top-level to prevent unmount on re-render) ─────────
function CampaignConfigPanel({ campaign, campaigns, pendingConfig, pendingDirty, hasSaved, openSections, onUpdate, onSave, onClose, onToggleSection, onCopyTo }) {
  const [showCopy, setShowCopy] = useState(false);
  const [copyTargets, setCopyTargets] = useState(new Set());
  const [copyDone, setCopyDone] = useState(false);

  if (!campaign || !pendingConfig) return null;

  const p = pendingConfig;
  const others = campaigns.filter(c => c.id !== campaign.id);

  function handleCopy() {
    onCopyTo([...copyTargets]);
    setCopyDone(true);
    setTimeout(() => { setCopyDone(false); setShowCopy(false); setCopyTargets(new Set()); }, 1500);
  }

  function toggleTarget(id) {
    setCopyTargets(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  return (
    <div style={{ ...cardStyle, borderColor: S.blue, marginTop: -2 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{campaign.name}</span>
        {campaign.stateCode && <span style={{ background: S.blue, borderRadius: 4, padding: '1px 7px', fontSize: 11, fontWeight: 700 }}>{campaign.stateCode}</span>}
        {!hasSaved && <span style={{ fontSize: 11, color: S.muted }}>(using defaults)</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {pendingDirty && <span style={{ fontSize: 11, color: S.yellow }}>● Unsaved</span>}
          <button style={btn('#475569')} onClick={() => { setShowCopy(s => !s); setCopyDone(false); }}>
            {showCopy ? 'Cancel Copy' : 'Copy to…'}
          </button>
          <button style={btn(S.green, !pendingDirty)} disabled={!pendingDirty} onClick={onSave}>Save Settings</button>
          <button style={btn('#475569')} onClick={onClose}>✕ Close</button>
        </div>
      </div>

      {/* Copy panel */}
      {showCopy && (
        <div style={{ background: '#0f172a', border: `1px solid ${S.border}`, borderRadius: 8, padding: '12px 14px', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 12, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
            Copy current settings to:
          </div>
          {others.length === 0 ? (
            <span style={{ color: S.muted, fontSize: 13 }}>No other campaigns.</span>
          ) : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {others.map(c => {
                  const on = copyTargets.has(c.id);
                  return (
                    <button key={c.id} onClick={() => toggleTarget(c.id)} style={{ background: on ? '#1d4ed8' : '#1e293b', border: `1px solid ${on ? S.blue : S.border}`, borderRadius: 6, color: on ? '#fff' : S.muted, padding: '4px 10px', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                      {c.stateCode && <span style={{ background: on ? '#3b82f6' : S.border, borderRadius: 3, padding: '0 4px', fontSize: 10, fontWeight: 700 }}>{c.stateCode}</span>}
                      {c.name}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={btn('#475569')} onClick={() => setCopyTargets(new Set(others.map(c => c.id)))}>Select All</button>
                <button style={btn('#475569')} onClick={() => setCopyTargets(new Set())}>Clear</button>
                {copyDone
                  ? <span style={{ color: S.green, fontSize: 13, alignSelf: 'center', fontWeight: 600 }}>✓ Copied to {copyTargets.size} campaign{copyTargets.size !== 1 ? 's' : ''}</span>
                  : <button style={btn(S.green, copyTargets.size === 0)} disabled={copyTargets.size === 0} onClick={handleCopy}>
                      Copy to {copyTargets.size} campaign{copyTargets.size !== 1 ? 's' : ''}
                    </button>
                }
              </div>
            </>
          )}
        </div>
      )}

      {/* Identity & Destination */}
      <div style={{ borderTop: `1px solid ${S.border}`, paddingTop: 12, marginBottom: 10 }}>
        <SectionHeader title="Identity & Destination" open={openSections.has('identity')} onToggle={() => onToggleSection('identity')} />
        {openSections.has('identity') && (
          <div style={grid3}>
            <Field label="State Code Override" hint="(overrides auto-detect for matching)">
              <input style={inputStyle} placeholder={campaign.stateCode ? `Auto: ${campaign.stateCode}` : 'e.g. TX'} value={p.stateCodeOverride || ''} onChange={e => onUpdate('stateCodeOverride', e.target.value.toUpperCase().slice(0, 2))} maxLength={2} />
            </Field>
            <Field label="Facebook Page ID">
              <input style={inputStyle} placeholder="e.g. 123456789" value={p.pageId} onChange={e => onUpdate('pageId', e.target.value)} />
            </Field>
            <Field label="Destination URL">
              <input style={inputStyle} placeholder="https://" value={p.destinationUrl} onChange={e => onUpdate('destinationUrl', e.target.value)} />
            </Field>
            <Field label="CTA Type">
              <select style={inputStyle} value={p.ctaType} onChange={e => onUpdate('ctaType', e.target.value)}>
                {CTA_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
          </div>
        )}
      </div>

      {/* Conversion */}
      <div style={{ borderTop: `1px solid ${S.border}`, paddingTop: 12, marginBottom: 10 }}>
        <SectionHeader title="Conversion" open={openSections.has('conversion')} onToggle={() => onToggleSection('conversion')} />
        {openSections.has('conversion') && (
          <div style={grid3}>
            <Field label="Conversion Location">
              <select style={inputStyle} value={p.conversionLocation} onChange={e => onUpdate('conversionLocation', e.target.value)}>
                <option value="WEBSITE">Website</option>
                <option value="LEAD_GENERATION">Instant Forms (Lead Gen)</option>
                <option value="MESSAGING">Messaging Apps</option>
                <option value="CALLS">Calls</option>
                <option value="APP">App</option>
              </select>
            </Field>
            <Field label="Dataset / Pixel ID">
              <input style={inputStyle} placeholder="Pixel or dataset ID" value={p.pixelId} onChange={e => onUpdate('pixelId', e.target.value)} />
            </Field>
            <Field label="Conversion Event">
              <select style={inputStyle} value={p.conversionEvent} onChange={e => onUpdate('conversionEvent', e.target.value)}>
                {CONVERSION_EVENTS.map(ev => <option key={ev.value} value={ev.value}>{ev.label}</option>)}
              </select>
            </Field>
            <Field label="Cost Per Result Goal ($)">
              <input style={inputStyle} type="number" min="0" step="0.01" placeholder="Leave blank = lowest cost" value={p.costPerResultGoal} onChange={e => onUpdate('costPerResultGoal', e.target.value)} />
            </Field>
            <Field label="Attribution Setting">
              <select style={inputStyle} value={p.attributionSetting} onChange={e => onUpdate('attributionSetting', e.target.value)}>
                <option value="7D_CLICK_1D_VIEW">7-day click, 1-day view</option>
                <option value="7D_CLICK">7-day click only</option>
                <option value="1D_CLICK">1-day click only</option>
                <option value="1D_VIEW">1-day view only</option>
              </select>
            </Field>
          </div>
        )}
      </div>

      {/* Budget & Schedule */}
      <div style={{ borderTop: `1px solid ${S.border}`, paddingTop: 12, marginBottom: 10 }}>
        <SectionHeader title="Budget & Schedule" open={openSections.has('budget')} onToggle={() => onToggleSection('budget')} />
        {openSections.has('budget') && (
          <div style={grid4}>
            <Field label="Budget Type">
              <select style={inputStyle} value={p.budgetType} onChange={e => onUpdate('budgetType', e.target.value)}>
                <option value="DAILY">Daily Budget</option>
                <option value="LIFETIME">Lifetime Budget</option>
              </select>
            </Field>
            <Field label="Amount ($)">
              <input style={inputStyle} type="number" min="1" step="0.01" placeholder="e.g. 50" value={p.budgetAmount} onChange={e => onUpdate('budgetAmount', e.target.value)} />
            </Field>
            <Field label="Start Date / Time">
              <input style={inputStyle} type="datetime-local" value={p.startTime} onChange={e => onUpdate('startTime', e.target.value)} />
            </Field>
            <Field label="End Date / Time">
              <input style={inputStyle} type="datetime-local" value={p.endTime} onChange={e => onUpdate('endTime', e.target.value)} />
            </Field>
          </div>
        )}
      </div>

      {/* Ad Creative */}
      <div style={{ borderTop: `1px solid ${S.border}`, paddingTop: 12 }}>
        <SectionHeader title="Ad Creative" open={openSections.has('adcreative')} onToggle={() => onToggleSection('adcreative')} />
        {openSections.has('adcreative') && (
          <div style={grid2}>
            <Field label="Ad Setup">
              <select style={inputStyle} value={p.adSetup} onChange={e => onUpdate('adSetup', e.target.value)}>
                <option value="SINGLE">Single Image / Video</option>
                <option value="CAROUSEL">Carousel</option>
              </select>
            </Field>
            <div />
            <Field label="Primary Text" col="1 / -1">
              <textarea rows={3} style={{ ...inputStyle, resize: 'vertical' }} placeholder="Ad body copy…" value={p.primaryText} onChange={e => onUpdate('primaryText', e.target.value)} />
            </Field>
            <Field label="Headline">
              <input style={inputStyle} placeholder="Short headline" value={p.headline} onChange={e => onUpdate('headline', e.target.value)} />
            </Field>
            <Field label="Description">
              <input style={inputStyle} placeholder="Optional description" value={p.description} onChange={e => onUpdate('description', e.target.value)} />
            </Field>
          </div>
        )}
      </div>

      {/* Save footer */}
      <div style={{ borderTop: `1px solid ${S.border}`, paddingTop: 12, marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        {pendingDirty && <span style={{ fontSize: 12, color: S.yellow, alignSelf: 'center' }}>● Unsaved changes</span>}
        <button style={btn(S.green, !pendingDirty)} disabled={!pendingDirty} onClick={onSave}>Save Settings</button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function AdsLauncher() {

  const [globalConfig, setGlobalConfig] = useState(() => {
    const defaultPresetName = localStorage.getItem(DEFAULT_PRESET_KEY);
    const storedPresets = loadStored(PRESETS_KEY, {});
    if (defaultPresetName && storedPresets[defaultPresetName]) {
      return { ...DEFAULT_GLOBAL, ...storedPresets[defaultPresetName] };
    }
    return { ...DEFAULT_GLOBAL, ...loadStored(GLOBAL_KEY, {}) };
  });
  const [campaignConfigs, setCampaignConfigs] = useState(() => loadStored(CAMPAIGN_CFGS_KEY, {}));
  const [focusedCampaignId, setFocusedCampaignId] = useState(null);
  const [pendingConfig, setPendingConfig]         = useState(null);
  const [pendingDirty, setPendingDirty]           = useState(false);

  const [presets, setPresets]           = useState(() => loadStored(PRESETS_KEY, {}));
  const [presetName, setPresetName]     = useState('');
  const [activePreset, setActivePreset] = useState(() => localStorage.getItem(DEFAULT_PRESET_KEY) || '');
  const [defaultPreset, setDefaultPreset] = useState(() => localStorage.getItem(DEFAULT_PRESET_KEY) || '');

  const [openGlobal, setOpenGlobal]     = useState(new Set(['audience', 'placements']));
  const [openCampaign, setOpenCampaign] = useState(new Set(['identity', 'conversion', 'budget', 'adcreative']));

  const [createNewAdset, setCreateNewAdset] = useState(true);

  const [campaigns, setCampaigns]               = useState([]);
  const [selectedCampaigns, setSelectedCampaigns] = useState(new Set());
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignsError, setCampaignsError]     = useState('');

  const [files, setFiles]       = useState([]);
  const fileInputRef             = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const [adsets, setAdsets]               = useState({});
  const [loadingAdsets, setLoadingAdsets] = useState(new Set());
  const [chosenCampaigns, setChosenCampaigns] = useState({});
  const [chosenAdsets, setChosenAdsets]       = useState({});

  const [confirmLaunch, setConfirmLaunch] = useState(false);
  const [launching, setLaunching]         = useState(false);
  const [rowStatuses, setRowStatuses]     = useState({});
  const [launchSummary, setLaunchSummary] = useState(null);
  const [launchStartMode, setLaunchStartMode] = useState('instant'); // 'instant' | 'midnight'

  useEffect(() => { localStorage.setItem(GLOBAL_KEY, JSON.stringify(globalConfig)); }, [globalConfig]);
  useEffect(() => { localStorage.setItem(CAMPAIGN_CFGS_KEY, JSON.stringify(campaignConfigs)); }, [campaignConfigs]);

  function updateGlobal(key, value) { setGlobalConfig(p => ({ ...p, [key]: value })); }
  function toggleGlobal(id) { setOpenGlobal(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function toggleCampaignSection(id) { setOpenCampaign(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function toggleEnhancement(id, checked) { updateGlobal('creativeEnhancements', { ...globalConfig.creativeEnhancements, [id]: checked }); }

  // Presets
  function savePreset(name) {
    const updated = { ...presets, [name]: { ...globalConfig } };
    setPresets(updated); localStorage.setItem(PRESETS_KEY, JSON.stringify(updated)); setActivePreset(name);
  }
  function loadPresetByName(name) {
    if (!presets[name]) return;
    setGlobalConfig({ ...DEFAULT_GLOBAL, ...presets[name] }); setActivePreset(name);
  }
  function deletePreset(name) {
    const updated = { ...presets }; delete updated[name];
    setPresets(updated); localStorage.setItem(PRESETS_KEY, JSON.stringify(updated));
    if (activePreset === name) setActivePreset('');
    if (defaultPreset === name) { setDefaultPreset(''); localStorage.removeItem(DEFAULT_PRESET_KEY); }
  }
  function setAsDefault(name) {
    localStorage.setItem(DEFAULT_PRESET_KEY, name);
    setDefaultPreset(name);
  }
  function unsetDefault() {
    localStorage.removeItem(DEFAULT_PRESET_KEY);
    setDefaultPreset('');
  }

  // Per-campaign config
  function focusCampaign(id) {
    setFocusedCampaignId(id);
    setPendingConfig({ ...DEFAULT_CAMPAIGN_CONFIG, ...campaignConfigs[id] });
    setPendingDirty(false);
  }
  function updatePending(key, value) { setPendingConfig(p => ({ ...p, [key]: value })); setPendingDirty(true); }
  function savePendingConfig() {
    if (!focusedCampaignId || !pendingConfig) return;
    setCampaignConfigs(p => ({ ...p, [focusedCampaignId]: { ...pendingConfig } }));
    setPendingDirty(false);
  }
  function copyConfigTo(campaignIds) {
    if (!pendingConfig) return;
    setCampaignConfigs(p => {
      const next = { ...p };
      for (const id of campaignIds) next[id] = { ...pendingConfig };
      return next;
    });
  }

  function buildLaunchConfig(campaignId) {
    const cc = { ...DEFAULT_CAMPAIGN_CONFIG, ...campaignConfigs[campaignId] };
    return {
      ...cc,
      advantagePlusAudience: globalConfig.advantagePlusAudience,
      ageMin: globalConfig.ageMin, ageMax: globalConfig.ageMax,
      genders: globalConfig.genders, countries: globalConfig.countries,
      customAudienceIds: globalConfig.customAudienceIds,
      targetingSpec: globalConfig.targetingSpec,
      placementsType: globalConfig.placementsType,
      manualPlacements: globalConfig.manualPlacements,
      creativeEnhancements: globalConfig.creativeEnhancements,
      urlParameters: globalConfig.urlParameters,
      languages: globalConfig.languages,
    };
  }

  // Campaigns
  const fetchCampaigns = useCallback(async () => {
    setCampaignsLoading(true); setCampaignsError('');
    try {
      const r = await fetch(`${BASE}/api/launcher/campaigns`);
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || 'Failed');
      const mapped = json.map(c => ({ ...c, stateCode: extractStateFromCampaign(c.name) }));
      setCampaigns(mapped);
      setSelectedCampaigns(new Set(mapped.map(c => c.id)));
    } catch (e) { setCampaignsError(e.message); }
    finally { setCampaignsLoading(false); }
  }, []);

  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);

  function addFiles(fileList) {
    setFiles(p => [...p, ...Array.from(fileList).map(f => ({ file: f, name: f.name, stateCode: extractStateFromFilename(f.name) }))]);
  }
  function removeFile(idx) {
    setFiles(p => p.filter((_, i) => i !== idx));
    setChosenCampaigns(p => { const n = { ...p }; delete n[idx]; return n; });
    setChosenAdsets(p => { const n = { ...p }; delete n[idx]; return n; });
    setRowStatuses(p => { const n = { ...p }; delete n[idx]; return n; });
  }

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

  const matches = useMemo(() => files.map((f, idx) => {
    if (!f.stateCode) return { ...f, idx, status: 'no_state', matchedCampaigns: [] };
    // Use stateCodeOverride if set for a campaign, otherwise use auto-detected stateCode
    const matched = campaigns.filter(c => {
      const effectiveCode = campaignConfigs[c.id]?.stateCodeOverride?.trim().toUpperCase() || c.stateCode;
      return effectiveCode === f.stateCode && selectedCampaigns.has(c.id);
    });
    if (matched.length === 0) {
      // No auto-match — allow manual override via chosenCampaigns
      const manualCampaign = campaigns.find(c => c.id === chosenCampaigns[idx]);
      if (manualCampaign) return { ...f, idx, status: 'ready', matchedCampaigns: [], campaign: manualCampaign };
      return { ...f, idx, status: 'no_match', matchedCampaigns: [] };
    }
    if (matched.length > 1) {
      const campaign = matched.find(c => c.id === chosenCampaigns[idx]) || null;
      return { ...f, idx, status: campaign ? 'ready' : 'ambiguous', matchedCampaigns: matched, campaign };
    }
    return { ...f, idx, status: 'ready', matchedCampaigns: matched, campaign: matched[0] };
  }), [files, campaigns, chosenCampaigns, selectedCampaigns, campaignConfigs]);

  useEffect(() => {
    if (!createNewAdset) {
      for (const m of matches) {
        if (m.status === 'ready' && m.campaign && !adsets[m.campaign.id] && !loadingAdsets.has(m.campaign.id))
          fetchAdsets(m.campaign.id);
      }
    }
  }, [matches, adsets, loadingAdsets, fetchAdsets, createNewAdset]);

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
  const today = new Date().toISOString().slice(0, 10);
  function resolveAdsetName(m) { return `${extractConcept(m.name)} - ${m.stateCode || '??'} - ${today}`; }

  async function doLaunch() {
    setLaunching(true); setConfirmLaunch(false); setLaunchSummary(null);
    let succeeded = 0, failed = 0;
    for (const m of matches) {
      if (m.status !== 'ready') continue;
      const idx = m.idx;
      let cfg = buildLaunchConfig(m.campaign.id);
      try {
        // Pre-flight validation
        if (!cfg.pageId?.trim())        throw new Error('Missing Facebook Page ID — open campaign config to set it');
        if (!cfg.destinationUrl?.trim()) throw new Error('Missing Destination URL — open campaign config to set it');
        if (!cfg.budgetAmount || parseFloat(cfg.budgetAmount) <= 0) throw new Error('Budget amount must be greater than 0 — open campaign config to set it');
        // Apply start time override
        if (launchStartMode === 'midnight') {
          const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(0, 0, 0, 0);
          cfg = { ...cfg, startTime: tomorrow.toISOString() };
        } else {
          cfg = { ...cfg, startTime: '' };
        }

        let adsetId;
        if (createNewAdset) {
          setRowStatuses(p => ({ ...p, [idx]: { phase: 'adset' } }));
          const asRes = await fetch(`${BASE}/api/launcher/adset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: resolveAdsetName(m), campaignId: m.campaign.id, ...cfg }) });
          const asJson = await asRes.json();
          if (!asRes.ok) throw new Error(asJson.error);
          adsetId = asJson.adset_id;
        } else {
          adsetId = chosenAdsets[idx] || adsets[m.campaign.id]?.[0]?.id;
          if (!adsetId) throw new Error('No adset selected');
        }
        setRowStatuses(p => ({ ...p, [idx]: { phase: 'uploading' } }));
        const fd = new FormData(); fd.append('file', m.file);
        const upRes = await fetch(`${BASE}/api/launcher/upload`, { method: 'POST', body: fd });
        const upJson = await upRes.json();
        if (!upRes.ok) throw new Error(upJson.error);

        setRowStatuses(p => ({ ...p, [idx]: { phase: 'creative' } }));
        const adName = adNameFromFile(m.name);
        const crRes = await fetch(`${BASE}/api/launcher/creative`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: adName, pageId: cfg.pageId, primaryText: cfg.primaryText, headline: cfg.headline, description: cfg.description, ctaType: cfg.ctaType, destinationUrl: cfg.destinationUrl, urlParameters: cfg.urlParameters, creativeEnhancements: cfg.creativeEnhancements, mediaType: upJson.type, videoId: upJson.video_id, imageHash: upJson.image_hash }),
        });
        const crJson = await crRes.json();
        if (!crRes.ok) throw new Error(crJson.error);

        setRowStatuses(p => ({ ...p, [idx]: { phase: 'ad' } }));
        const adRes = await fetch(`${BASE}/api/launcher/ad`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: adName, adsetId, creativeId: crJson.creative_id }) });
        const adJson = await adRes.json();
        if (!adRes.ok) throw new Error(adJson.error);

        setRowStatuses(p => ({ ...p, [idx]: { phase: 'done', adId: adJson.ad_id } })); succeeded++;
      } catch (e) { setRowStatuses(p => ({ ...p, [idx]: { phase: 'error', error: e.message } })); failed++; }
    }
    setLaunching(false); setLaunchSummary({ succeeded, failed });
  }

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
    if (m.status === 'no_state')  return <span style={{ color: S.red }}>No state in filename</span>;
    if (m.status === 'no_match')  return <span style={{ color: S.orange }}>Pick a campaign</span>;
    if (m.status === 'ambiguous') return <span style={{ color: S.yellow }}>Ambiguous ({m.matchedCampaigns.length} matches)</span>;
    if (m.status === 'ready')     return <span style={{ color: S.green }}>Ready</span>;
    return null;
  }
  function renderCampaignCell(m) {
    if (m.status === 'no_state') return <span style={{ color: S.muted }}>—</span>;
    if (m.status === 'no_match') return (
      <select value={chosenCampaigns[m.idx] || ''} onChange={e => setChosenCampaigns(p => ({ ...p, [m.idx]: e.target.value }))} style={{ ...inputStyle, padding: '4px 8px', fontSize: 12, borderColor: S.orange }}>
        <option value="">⚠ No match ({m.stateCode}) — pick manually</option>
        {campaigns.map(c => <option key={c.id} value={c.id}>{c.stateCode ? `[${c.stateCode}] ` : ''}{c.name}</option>)}
      </select>
    );
    if (m.status === 'ambiguous' || (m.status === 'ready' && m.matchedCampaigns?.length > 1)) {
      return <select value={chosenCampaigns[m.idx] || ''} onChange={e => setChosenCampaigns(p => ({ ...p, [m.idx]: e.target.value }))} style={{ ...inputStyle, padding: '4px 8px', fontSize: 12 }}><option value="">— pick campaign —</option>{m.matchedCampaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>;
    }
    return <span style={{ fontSize: 12 }}>{m.campaign?.name || '—'}</span>;
  }
  function renderAdsetCell(m) {
    if (!m.campaign) return <span style={{ color: S.muted }}>—</span>;
    if (createNewAdset) return <span style={{ color: S.muted, fontSize: 11, fontStyle: 'italic' }}>{resolveAdsetName(m)}</span>;
    const list = adsets[m.campaign.id];
    if (loadingAdsets.has(m.campaign.id)) return <span style={{ color: S.muted, fontSize: 12 }}><Spinner />Loading…</span>;
    if (!list?.length) return <span style={{ color: S.muted }}>No adsets</span>;
    return <select value={chosenAdsets[m.idx] || list[0]?.id || ''} onChange={e => setChosenAdsets(p => ({ ...p, [m.idx]: e.target.value }))} style={{ ...inputStyle, padding: '4px 8px', fontSize: 12 }}>{list.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>;
  }

  const focusedCampaign = campaigns.find(c => c.id === focusedCampaignId) || null;

  return (
    <div style={{ background: S.bg, minHeight: '100vh', padding: '22px 26px', color: S.text, fontFamily: 'system-ui, sans-serif', fontSize: 14 }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <h2 style={{ margin: '0 0 16px', fontWeight: 700, fontSize: 20 }}>Ads Launcher</h2>

      {/* ── Global Presets ──────────────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 12, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
          Global Presets <span style={{ fontWeight: 400, textTransform: 'none', fontSize: 11 }}>(saves global settings)</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={activePreset} onChange={e => { setActivePreset(e.target.value); if (e.target.value) loadPresetByName(e.target.value); }} style={{ ...inputStyle, width: 210 }}>
            <option value="">— No preset loaded —</option>
            {Object.keys(presets).map(n => <option key={n} value={n}>{n}{defaultPreset === n ? ' ★' : ''}</option>)}
          </select>
          {activePreset && (
            <>
              <button
                title={defaultPreset === activePreset ? 'Remove startup default' : 'Set as startup default (auto-loads on open)'}
                style={{ ...btn(defaultPreset === activePreset ? S.yellow : '#475569'), padding: '6px 10px' }}
                onClick={() => defaultPreset === activePreset ? unsetDefault() : setAsDefault(activePreset)}
              >
                {defaultPreset === activePreset ? '★ Default' : '☆ Set default'}
              </button>
              <button style={btn('#64748b')} onClick={() => deletePreset(activePreset)}>Delete</button>
            </>
          )}
          <div style={{ width: 1, height: 26, background: S.border, margin: '0 4px' }} />
          <input style={{ ...inputStyle, width: 170 }} placeholder="New preset name…" value={presetName} onChange={e => setPresetName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && presetName.trim()) { savePreset(presetName.trim()); setPresetName(''); } }} />
          <button style={btn(S.blue, !presetName.trim())} disabled={!presetName.trim()} onClick={() => { savePreset(presetName.trim()); setPresetName(''); }}>Save Preset</button>
        </div>
      </div>

      {/* ── Global Settings ─────────────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 12, color: S.purple, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 14 }}>
          Global Settings <span style={{ fontWeight: 400, textTransform: 'none', fontSize: 11, color: S.muted }}>— apply to all campaigns</span>
        </div>

        {/* Audience */}
        <div style={{ marginBottom: 12 }}>
          <SectionHeader title="Audience" open={openGlobal.has('audience')} onToggle={() => toggleGlobal('audience')} />
          {openGlobal.has('audience') && (
            <>
              <div style={{ ...grid4, marginBottom: 10 }}>
                <Field label="Age Min"><input style={inputStyle} type="number" min={13} max={65} value={globalConfig.ageMin} onChange={e => updateGlobal('ageMin', e.target.value)} /></Field>
                <Field label="Age Max"><input style={inputStyle} type="number" min={13} max={65} value={globalConfig.ageMax} onChange={e => updateGlobal('ageMax', e.target.value)} /></Field>
                <Field label="Gender">
                  <select style={inputStyle} value={globalConfig.genders} onChange={e => updateGlobal('genders', e.target.value)}>
                    <option value="0">All Genders</option><option value="1">Male Only</option><option value="2">Female Only</option>
                  </select>
                </Field>
                <Field label="Countries"><input style={inputStyle} placeholder="US,CA" value={globalConfig.countries} onChange={e => updateGlobal('countries', e.target.value)} /></Field>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                  <input type="checkbox" checked={globalConfig.advantagePlusAudience} onChange={e => updateGlobal('advantagePlusAudience', e.target.checked)} />
                  Enable Advantage+ Audience
                </label>
                <div>
                  <label style={labelStyle}>Custom Audience IDs (comma-separated)</label>
                  <input style={inputStyle} placeholder="123456,789012" value={globalConfig.customAudienceIds} onChange={e => updateGlobal('customAudienceIds', e.target.value)} />
                </div>
                <div>
                  <label style={{ ...labelStyle, marginBottom: 3 }}>Advanced Targeting JSON <span style={{ color: S.muted, fontWeight: 400, textTransform: 'none' }}>(overrides fields above)</span></label>
                  <textarea rows={2} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace', fontSize: 11 }} placeholder={'{"geo_locations":{"countries":["US"]},"age_min":25}'} value={globalConfig.targetingSpec} onChange={e => updateGlobal('targetingSpec', e.target.value)} />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Placements */}
        <div style={{ borderTop: `1px solid ${S.border}`, paddingTop: 12, marginBottom: 12 }}>
          <SectionHeader title="Placements" open={openGlobal.has('placements')} onToggle={() => toggleGlobal('placements')} />
          {openGlobal.has('placements') && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                  <input type="radio" checked={globalConfig.placementsType === 'ADVANTAGE_PLUS'} onChange={() => updateGlobal('placementsType', 'ADVANTAGE_PLUS')} />
                  Advantage+ Placements <span style={{ color: S.muted, fontSize: 12 }}>(Meta optimises automatically)</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                  <input type="radio" checked={globalConfig.placementsType === 'MANUAL'} onChange={() => updateGlobal('placementsType', 'MANUAL')} />
                  Manual Placements
                </label>
              </div>
              {globalConfig.placementsType === 'MANUAL' && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                  {PLACEMENT_OPTIONS.map(p => (
                    <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12 }}>
                      <input type="checkbox" checked={globalConfig.manualPlacements[p.id] || false} onChange={e => updateGlobal('manualPlacements', { ...globalConfig.manualPlacements, [p.id]: e.target.checked })} />
                      {p.label}
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Creative Advancements */}
        <div style={{ borderTop: `1px solid ${S.border}`, paddingTop: 12, marginBottom: 12 }}>
          <SectionHeader title="Creative Advancements" open={openGlobal.has('creative')} onToggle={() => toggleGlobal('creative')} />
          {openGlobal.has('creative') && (
            <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
              {['Standard', 'Advantage+'].map(group => (
                <div key={group}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>{group}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {CREATIVE_ENHANCEMENTS.filter(e => e.group === group).map(e => (
                      <label key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 13 }}>
                        <input type="checkbox" checked={globalConfig.creativeEnhancements[e.id] || false} onChange={ev => toggleEnhancement(e.id, ev.target.checked)} />
                        {e.label}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* URL & Languages */}
        <div style={{ borderTop: `1px solid ${S.border}`, paddingTop: 12 }}>
          <SectionHeader title="URL & Languages" open={openGlobal.has('tracking')} onToggle={() => toggleGlobal('tracking')} />
          {openGlobal.has('tracking') && (
            <div style={grid2}>
              <Field label="URL Parameters" col="1 / -1">
                <input style={inputStyle} placeholder="utm_source=facebook&utm_medium=paid" value={globalConfig.urlParameters} onChange={e => updateGlobal('urlParameters', e.target.value)} />
              </Field>
              <Field label="Languages" hint="(Meta numeric locale IDs, comma-sep)">
                <input style={inputStyle} placeholder="6,23  (6=English, 23=Spanish)" value={globalConfig.languages} onChange={e => updateGlobal('languages', e.target.value)} />
              </Field>
            </div>
          )}
        </div>
      </div>

      {/* ── Campaigns ──────────────────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: campaigns.length ? 10 : 0 }}>
          <span style={{ fontWeight: 700, fontSize: 12, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Live Campaigns</span>
          {campaignsLoading
            ? <span style={{ color: S.muted, fontSize: 13 }}><Spinner />Loading…</span>
            : <span style={{ background: '#0f172a', border: `1px solid ${S.border}`, borderRadius: 20, padding: '2px 10px', fontSize: 12 }}>{selectedCampaigns.size} / {campaigns.length} selected</span>
          }
          <button style={btn(S.blue, campaignsLoading)} onClick={fetchCampaigns} disabled={campaignsLoading}>Refresh</button>
          {campaigns.length > 0 && <>
            <button style={btn('#475569')} onClick={() => setSelectedCampaigns(new Set(campaigns.map(c => c.id)))}>Select All</button>
            <button style={btn('#475569')} onClick={() => setSelectedCampaigns(new Set())}>Deselect All</button>
          </>}
          {campaignsError && <span style={{ color: S.red, fontSize: 12 }}>{campaignsError}</span>}
        </div>
        {campaigns.length > 0 && (
          <>
            <div style={{ fontSize: 11, color: S.muted, marginBottom: 8 }}>✓/○ to select for launch · click name to configure</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {campaigns.map(c => {
                const on = selectedCampaigns.has(c.id);
                const focused = focusedCampaignId === c.id;
                const hasSaved = !!campaignConfigs[c.id];
                return (
                  <div key={c.id} style={{ background: focused ? '#1e3a5f' : on ? '#1d4ed8' : '#0f172a', border: `1px solid ${focused ? S.blue : on ? S.blue : S.border}`, borderRadius: 6, color: on ? '#fff' : S.muted, fontSize: 12, display: 'flex', alignItems: 'center', maxWidth: 300, overflow: 'hidden' }}>
                    <button onClick={() => setSelectedCampaigns(p => { const n = new Set(p); on ? n.delete(c.id) : n.add(c.id); return n; })} title={on ? 'Deselect' : 'Select'} style={{ background: 'none', border: 'none', borderRight: `1px solid ${on ? 'rgba(255,255,255,0.2)' : S.border}`, padding: '6px 9px', cursor: 'pointer', color: on ? '#fff' : S.muted, fontSize: 13, flexShrink: 0 }}>
                      {on ? '✓' : '○'}
                    </button>
                    <button onClick={() => focused ? (setFocusedCampaignId(null), setPendingConfig(null), setPendingDirty(false)) : focusCampaign(c.id)} style={{ background: 'none', border: 'none', color: 'inherit', padding: '6px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, flex: 1, textAlign: 'left', minWidth: 0 }}>
                      {(() => {
                        const code = campaignConfigs[c.id]?.stateCodeOverride?.trim().toUpperCase() || c.stateCode;
                        return code
                          ? <span style={{ background: on ? '#3b82f6' : S.border, borderRadius: 4, padding: '1px 5px', fontSize: 11, fontWeight: 700, flexShrink: 0 }} title={campaignConfigs[c.id]?.stateCodeOverride ? 'Manual override' : 'Auto-detected'}>{code}{campaignConfigs[c.id]?.stateCodeOverride ? ' ✎' : ''}</span>
                          : <span style={{ background: S.red, borderRadius: 4, padding: '1px 5px', fontSize: 11, fontWeight: 700, flexShrink: 0, opacity: 0.7 }} title="No state detected — open config to set override">?</span>;
                      })()}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                      {hasSaved && <span style={{ color: S.green, fontSize: 10, flexShrink: 0 }}>●</span>}
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* ── Campaign Config Panel ────────────────────────────────────────── */}
      <CampaignConfigPanel
        campaign={focusedCampaign}
        campaigns={campaigns}
        pendingConfig={pendingConfig}
        pendingDirty={pendingDirty}
        hasSaved={!!campaignConfigs[focusedCampaignId]}
        openSections={openCampaign}
        onUpdate={updatePending}
        onSave={savePendingConfig}
        onClose={() => { setFocusedCampaignId(null); setPendingConfig(null); setPendingDirty(false); }}
        onToggleSection={toggleCampaignSection}
        onCopyTo={copyConfigTo}
      />

      {/* ── Creative Files ──────────────────────────────────────────────── */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 700, fontSize: 12, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Creative Files</div>
        <div onClick={() => fileInputRef.current?.click()} onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }} style={{ border: `2px dashed ${dragOver ? S.blue : S.border}`, borderRadius: 8, padding: '28px 20px', textAlign: 'center', cursor: 'pointer', color: dragOver ? S.blue : S.muted, transition: 'all 0.15s', userSelect: 'none' }}>
          Drop creative files here or click to browse
          <div style={{ fontSize: 11, marginTop: 4 }}>Files should follow: <code style={{ background: '#0f172a', padding: '1px 5px', borderRadius: 3 }}>ConceptName-TX-v1.mp4</code></div>
        </div>
        <input ref={fileInputRef} type="file" multiple accept="image/*,video/*" style={{ display: 'none' }} onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
        {files.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
            {files.map((f, idx) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#0f172a', border: `1px solid ${S.border}`, borderRadius: 6, padding: '5px 10px' }}>
                <span style={{ flex: 1, fontSize: 12, wordBreak: 'break-all' }}>{f.name}</span>
                <span style={{ fontSize: 11, color: S.muted, whiteSpace: 'nowrap' }}>→ {adNameFromFile(f.name)}</span>
                <span style={{ fontSize: 12, color: f.stateCode ? S.green : S.red, whiteSpace: 'nowrap' }}>{f.stateCode ? `${f.stateCode} — ${STATE_NAMES[f.stateCode]}` : 'No state detected'}</span>
                <button onClick={() => removeFile(idx)} style={{ background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 16, padding: '0 2px', lineHeight: 1 }}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Adset mode ───────────────────────────────────────────────────── */}
      {files.length > 0 && (
        <div style={{ ...cardStyle, display: 'flex', gap: 20, alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 12, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>Adset Mode</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="radio" checked={createNewAdset} onChange={() => setCreateNewAdset(true)} />Create new adset per creative
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="radio" checked={!createNewAdset} onChange={() => setCreateNewAdset(false)} />Add to existing adset
          </label>
        </div>
      )}

      {/* ── Match table ──────────────────────────────────────────────────── */}
      {files.length > 0 && campaigns.length > 0 && (
        <div style={{ ...cardStyle, overflowX: 'auto' }}>
          <div style={{ fontWeight: 700, fontSize: 12, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Match Table</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: S.muted }}>
                {['File', 'Ad Name', 'State', 'Campaign', createNewAdset ? 'New Adset Name' : 'Adset', 'Status'].map(h => (
                  <th key={h} style={{ padding: '6px 10px', borderBottom: `1px solid ${S.border}`, fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', textAlign: 'left', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matches.map((m, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${S.border}` }}>
                  <td style={{ padding: '7px 10px', maxWidth: 180, wordBreak: 'break-all', fontSize: 12 }}>{m.name}</td>
                  <td style={{ padding: '7px 10px', fontSize: 12, color: S.muted, whiteSpace: 'nowrap' }}>{adNameFromFile(m.name)}</td>
                  <td style={{ padding: '7px 10px', whiteSpace: 'nowrap', fontSize: 12 }}>{m.stateCode ? `${m.stateCode} — ${STATE_NAMES[m.stateCode]}` : <span style={{ color: S.red }}>—</span>}</td>
                  <td style={{ padding: '7px 10px', minWidth: 180 }}>{renderCampaignCell(m)}</td>
                  <td style={{ padding: '7px 10px', minWidth: 180 }}>{renderAdsetCell(m)}</td>
                  <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>{renderStatus(m)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Launch bar ───────────────────────────────────────────────────── */}
      {files.length > 0 && (
        <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700 }}>{readyCount} ready to launch</span>
          {/* Start time selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: S.muted }}>
            <span style={{ fontWeight: 600, color: S.text }}>Start:</span>
            {[{ value: 'instant', label: 'Instant' }, { value: 'midnight', label: '12:00 AM tomorrow' }].map(opt => (
              <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', color: launchStartMode === opt.value ? S.text : S.muted, fontWeight: launchStartMode === opt.value ? 600 : 400 }}>
                <input type="radio" name="launchStartMode" value={opt.value} checked={launchStartMode === opt.value} onChange={() => setLaunchStartMode(opt.value)} style={{ accentColor: S.blue }} />
                {opt.label}
              </label>
            ))}
          </div>
          {!confirmLaunch && (
            <button style={btn(S.green, readyCount === 0 || launching)} onClick={() => readyCount > 0 && !launching && setConfirmLaunch(true)} disabled={readyCount === 0 || launching}>
              {launching ? <><Spinner />Launching…</> : 'Launch All'}
            </button>
          )}
          {confirmLaunch && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#0f172a', border: `1px solid ${S.border}`, borderRadius: 8, padding: '8px 14px' }}>
              <span style={{ color: S.yellow, fontWeight: 600, fontSize: 13 }}>Launch {readyCount} ad{readyCount !== 1 ? 's' : ''} as PAUSED? This cannot be undone.</span>
              <button style={btn(S.green)} onClick={doLaunch}>Confirm</button>
              <button style={btn('#475569')} onClick={() => setConfirmLaunch(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}

      {/* ── Results ──────────────────────────────────────────────────────── */}
      {launchSummary && (
        <div style={{ ...cardStyle, borderColor: launchSummary.failed > 0 ? S.orange : S.green }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>
            {launchSummary.succeeded} launched successfully{launchSummary.failed > 0 ? `, ${launchSummary.failed} failed` : ''}
          </div>
          {matches.filter(m => rowStatuses[m.idx]?.phase === 'error').map(m => (
            <div key={m.idx} style={{ fontSize: 12, color: S.red, marginTop: 4 }}>{m.name}: {rowStatuses[m.idx].error}</div>
          ))}
        </div>
      )}
    </div>
  );
}
