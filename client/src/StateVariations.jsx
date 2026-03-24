import { useState, useEffect, useRef, useCallback } from 'react';
import { extractStateFromCampaign, STATE_NAMES } from './launcherStates.js';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const DEFAULT_PROMPT = `Your main job is not to create new images but to alter existing ones. Primarily to change the U.S. State in the image to another as specified.

State is specified simply by listing it out in the prompt.

CRITICAL TEXT RULES:
- Preserve ALL existing text in the image exactly as written — same words, same order, same spelling, same punctuation
- Do NOT duplicate any words or phrases
- Do NOT add new words anywhere in the image
- Do NOT remove any existing words
- The ONLY text that should change is the U.S. state name or abbreviation itself
- Read all text carefully before and after editing to confirm no duplication or corruption`;

const DEFAULT_SETTINGS = {
  outputFormat: 'jpeg',
  temperature:  0.4,
  topP:         0.95,
  topK:         40,
  seed:         '',
};

// ── Styles ────────────────────────────────────────────────────────────────────
const S = {
  bg: '#0f172a', card: '#1e293b', border: '#334155',
  text: '#f1f5f9', muted: '#94a3b8',
  blue: '#3b82f6', green: '#22c55e', yellow: '#eab308',
  orange: '#f97316', red: '#ef4444', purple: '#a855f7',
};
const cardStyle  = { background: S.card, border: `1px solid ${S.border}`, borderRadius: 10, padding: '14px 18px', marginBottom: 12 };
const inputStyle = { background: '#0f172a', border: `1px solid ${S.border}`, borderRadius: 6, color: S.text, padding: '6px 10px', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' };
const labelStyle = { color: S.muted, fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 4, display: 'block' };
const btn = (color = S.blue, disabled = false) => ({
  background: disabled ? '#334155' : color, color: disabled ? S.muted : '#fff',
  border: 'none', borderRadius: 6, padding: '6px 13px', fontSize: 13,
  cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 600, whiteSpace: 'nowrap',
});

function Spinner() {
  return <span style={{ display: 'inline-block', width: 13, height: 13, border: `2px solid ${S.border}`, borderTopColor: S.blue, borderRadius: '50%', animation: 'spin 0.7s linear infinite', verticalAlign: 'middle', marginRight: 5 }} />;
}
function Field({ label, children, hint }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={labelStyle}>{label}{hint && <span style={{ color: S.muted, fontWeight: 400, textTransform: 'none', marginLeft: 4, fontSize: 10 }}>{hint}</span>}</label>
      {children}
    </div>
  );
}
function SliderField({ label, value, min, max, step, onChange, hint }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <label style={{ ...labelStyle, marginBottom: 0 }}>{label}{hint && <span style={{ color: S.muted, fontWeight: 400, textTransform: 'none', marginLeft: 4, fontSize: 10 }}>{hint}</span>}</label>
        <span style={{ fontSize: 12, color: S.text, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(parseFloat(e.target.value))} style={{ width: '100%', accentColor: S.blue }} />
    </div>
  );
}

function resolveStateName(input) {
  const upper = input.trim().toUpperCase();
  if (STATE_NAMES[upper]) return STATE_NAMES[upper];
  return input.trim();
}
function stateKey(input) { return input.trim().toUpperCase(); }
function getStateDisplay(key) {
  const fromCode = STATE_NAMES[key];
  if (fromCode) return fromCode;
  return key.charAt(0) + key.slice(1).toLowerCase();
}

// ── Result card (top-level to prevent unmount issues) ─────────────────────────
function ResultCard({ item, adName, onRegenerate, onNotesChange }) {
  const [showNotes, setShowNotes] = useState(false);

  function download() {
    const ext = item.mimeType?.split('/')[1] || 'jpg';
    let filename;
    if (adName && adName.trim()) {
      // Replace _ with the state abbreviation (stateKey is the 2-letter code if available)
      filename = adName.trim().replace(/_/g, item.stateKey) + `.${ext}`;
    } else {
      filename = `${item.stateDisplay.replace(/\s+/g, '-')}.${ext}`;
    }
    const a = document.createElement('a');
    a.href = `data:${item.mimeType};base64,${item.image}`;
    a.download = filename;
    a.click();
  }

  const statusColor = { done: S.green, error: S.red, generating: S.blue, pending: S.muted }[item.status] || S.muted;

  return (
    <div style={{ background: S.card, border: `1px solid ${item.status === 'error' ? S.red : S.border}`, borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${S.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{item.stateDisplay}</span>
        <span style={{ fontSize: 11, color: statusColor, marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
          {item.status === 'generating' && <Spinner />}
          {{ pending: '○ Pending', generating: 'Generating…', done: '✓ Done', error: '✗ Error' }[item.status]}
        </span>
      </div>

      <div style={{ background: '#0f172a', minHeight: 160, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {item.status === 'done' && item.image
          ? <img src={`data:${item.mimeType};base64,${item.image}`} alt={item.stateDisplay} style={{ width: '100%', display: 'block', objectFit: 'contain' }} />
          : item.status === 'error'
            ? <div style={{ color: S.red, fontSize: 12, padding: 14, textAlign: 'center' }}>{item.error}</div>
            : <div style={{ color: S.muted, fontSize: 12 }}>{{ pending: 'Waiting in queue', generating: 'Generating…' }[item.status] || ''}</div>
        }
      </div>

      {item.text && (
        <div style={{ padding: '5px 12px', background: '#0f172a', fontSize: 11, color: S.muted, borderTop: `1px solid ${S.border}` }}>{item.text}</div>
      )}

      {(item.status === 'done' || item.status === 'error') && (
        <div style={{ padding: '10px 12px', borderTop: `1px solid ${S.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 7 }}>
            {item.status === 'done' && <button style={btn(S.green)} onClick={download}>⬇ Download</button>}
            <button style={btn('#475569')} onClick={() => setShowNotes(s => !s)}>
              {showNotes ? 'Cancel' : 'Regenerate…'}
            </button>
          </div>
          {showNotes && (
            <>
              <textarea rows={2} style={{ ...inputStyle, resize: 'vertical', fontSize: 12 }} placeholder="Notes for Gemini (e.g. keep font color red, match exact layout)…" value={item.regenNotes} onChange={e => onNotesChange(e.target.value)} />
              <button style={btn(S.orange, !item.regenNotes.trim())} disabled={!item.regenNotes.trim()} onClick={() => { onRegenerate(); setShowNotes(false); }}>
                Regenerate with notes
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Settings panel (top-level) ────────────────────────────────────────────────
function SettingsPanel({ settings, onChange }) {
  const u = (key, val) => onChange({ ...settings, [key]: val });
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div style={{ background: S.card, border: `1px solid ${S.border}`, borderRadius: 10, padding: '14px 18px', position: 'sticky', top: 22 }}>
      <div style={{ fontWeight: 700, fontSize: 12, color: S.purple, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 16 }}>Model Settings</div>

      <Field label="Output Format">
        <select style={inputStyle} value={settings.outputFormat} onChange={e => u('outputFormat', e.target.value)}>
          <option value="jpeg">JPEG</option>
          <option value="png">PNG</option>
          <option value="webp">WEBP</option>
        </select>
      </Field>

      <SliderField label="Temperature" value={settings.temperature} min={0} max={2} step={0.05} onChange={v => u('temperature', v)} hint="lower = more accurate text" />

      <div style={{ borderTop: `1px solid ${S.border}`, paddingTop: 12, marginTop: 4 }}>
        <button
          onClick={() => setShowAdvanced(s => !s)}
          style={{ background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', padding: 0, display: 'flex', alignItems: 'center', gap: 6, marginBottom: showAdvanced ? 12 : 0 }}
        >
          <span style={{ fontSize: 10 }}>{showAdvanced ? '▼' : '▶'}</span> Advanced
        </button>
        {showAdvanced && (
          <>
            <SliderField label="Top-P" value={settings.topP} min={0} max={1} step={0.01} onChange={v => u('topP', v)} hint="nucleus sampling" />
            <SliderField label="Top-K" value={settings.topK} min={1} max={100} step={1} onChange={v => u('topK', v)} hint="token candidates" />
            <Field label="Seed" hint="(blank = random)">
              <input style={inputStyle} type="number" placeholder="e.g. 42" value={settings.seed} onChange={e => u('seed', e.target.value)} />
            </Field>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function StateVariations() {
  const [adName, setAdName]         = useState('');
  const [baseImage, setBaseImage]   = useState(null);
  const [dragOver, setDragOver]     = useState(false);
  const [prompt, setPrompt]         = useState(DEFAULT_PROMPT);
  const [settings, setSettings]     = useState(DEFAULT_SETTINGS);

  const [campaigns, setCampaigns]           = useState([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [selectedStates, setSelectedStates] = useState(new Set());
  const [customInput, setCustomInput]       = useState('');

  const [items, setItems]     = useState([]);
  const [running, setRunning] = useState(false);
  const runningRef            = useRef(false);
  const fileInputRef          = useRef(null);

  const campaignStates = (() => {
    const seen = new Map();
    for (const c of campaigns) {
      const sc = c.stateCode;
      if (sc && !seen.has(sc)) seen.set(sc, { code: sc, name: STATE_NAMES[sc] || sc });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  })();

  const fetchCampaigns = useCallback(async () => {
    setCampaignsLoading(true);
    try {
      const r = await fetch(`${BASE}/api/launcher/campaigns`);
      const json = await r.json();
      if (r.ok) setCampaigns(json.map(c => ({ ...c, stateCode: extractStateFromCampaign(c.name) })));
    } catch { /* ignore */ }
    finally { setCampaignsLoading(false); }
  }, []);

  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);

  function loadImage(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = e => {
      const dataUrl = e.target.result;
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight;
        const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
        const d = gcd(w, h);
        const ratio = `${w/d}:${h/d}`;
        setBaseImage({ dataUrl, base64: dataUrl.split(',')[1], mimeType: file.type, name: file.name, width: w, height: h, ratio });
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  function toggleState(key) {
    setSelectedStates(p => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function addCustomState() {
    const val = customInput.trim();
    if (!val) return;
    setSelectedStates(p => new Set([...p, stateKey(val)]));
    setCustomInput('');
  }
  function removeState(key) {
    setSelectedStates(p => { const n = new Set(p); n.delete(key); return n; });
  }

  function startGeneration() {
    if (!baseImage || selectedStates.size === 0 || running) return;
    const newItems = [...selectedStates].map((sk, i) => ({
      id: `${sk}-${Date.now()}-${i}`,
      stateKey: sk, stateDisplay: getStateDisplay(sk),
      status: 'pending', image: null, mimeType: null, text: null, error: null, regenNotes: '',
    }));
    setItems(newItems);
    runQueue(newItems, baseImage, prompt, settings);
  }

  async function runQueue(queueItems, img, promptText, cfg) {
    setRunning(true); runningRef.current = true;
    for (let i = 0; i < queueItems.length; i++) {
      if (!runningRef.current) break;
      setItems(p => p.map((it, idx) => idx === i ? { ...it, status: 'generating' } : it));
      const result = await callGemini(img, queueItems[i].stateDisplay, promptText, '', cfg);
      setItems(p => p.map((it, idx) => idx === i
        ? result.error
          ? { ...it, status: 'error', error: result.error }
          : { ...it, status: 'done', image: result.image, mimeType: result.mimeType, text: result.text }
        : it
      ));
    }
    setRunning(false); runningRef.current = false;
  }

  async function regenItem(idx) {
    const item = items[idx];
    if (!baseImage || !item) return;
    setItems(p => p.map((it, i) => i === idx ? { ...it, status: 'generating', image: null, error: null } : it));
    const result = await callGemini(baseImage, item.stateDisplay, prompt, item.regenNotes, settings);
    setItems(p => p.map((it, i) => i === idx
      ? result.error
        ? { ...it, status: 'error', error: result.error }
        : { ...it, status: 'done', image: result.image, mimeType: result.mimeType, text: result.text }
      : it
    ));
  }

  async function callGemini(img, stateDisplay, promptText, notes, cfg) {
    try {
      const r = await fetch(`${BASE}/api/variations/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: img.base64, mimeType: img.mimeType,
          state: stateDisplay, prompt: promptText, notes: notes || '',
          ...cfg,
        }),
      });
      const json = await r.json();
      if (!r.ok) return { error: json.error || 'Request failed' };
      return json;
    } catch (e) { return { error: e.message }; }
  }

  function updateRegenNotes(idx, val) {
    setItems(p => p.map((it, i) => i === idx ? { ...it, regenNotes: val } : it));
  }

  const doneCount  = items.filter(i => i.status === 'done').length;
  const errorCount = items.filter(i => i.status === 'error').length;

  return (
    <div style={{ background: S.bg, minHeight: '100vh', padding: '22px 26px', color: S.text, fontFamily: 'system-ui, sans-serif', fontSize: 14 }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <h2 style={{ margin: '0 0 16px', fontWeight: 700, fontSize: 20 }}>State Image Variations</h2>

      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr 260px', gap: 16, alignItems: 'start' }}>

        {/* ── Left: controls ──────────────────────────────────────────── */}
        <div>
          {/* Ad name */}
          <div style={cardStyle}>
            <div style={{ fontWeight: 700, fontSize: 12, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Ad Name</div>
            <input
              style={inputStyle}
              placeholder="e.g. Summer-_-v1 (_ = state abbr)"
              value={adName}
              onChange={e => setAdName(e.target.value)}
            />
            <div style={{ fontSize: 11, color: S.muted, marginTop: 6 }}>
              Use <code style={{ background: '#0f172a', borderRadius: 3, padding: '1px 4px' }}>_</code> where the state abbreviation should appear in the filename.
            </div>
          </div>

          {/* Base image */}
          <div style={cardStyle}>
            <div style={{ fontWeight: 700, fontSize: 12, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Base Image</div>
            {baseImage ? (
              <>
                <img src={baseImage.dataUrl} alt="base" style={{ width: '100%', borderRadius: 6, marginBottom: 8, display: 'block' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: S.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{baseImage.name}</span>
                  <button style={btn('#475569')} onClick={() => setBaseImage(null)}>Remove</button>
                </div>
              </>
            ) : (
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => { e.preventDefault(); setDragOver(false); loadImage(e.dataTransfer.files[0]); }}
                style={{ border: `2px dashed ${dragOver ? S.blue : S.border}`, borderRadius: 8, padding: '32px 20px', textAlign: 'center', cursor: 'pointer', color: dragOver ? S.blue : S.muted, transition: 'all 0.15s', userSelect: 'none', fontSize: 13 }}
              >
                Drop image here or click to browse
              </div>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { loadImage(e.target.files[0]); e.target.value = ''; }} />
          </div>

          {/* Prompt */}
          <div style={cardStyle}>
            <div style={{ fontWeight: 700, fontSize: 12, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Prompt Template</div>
            <textarea rows={6} style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }} value={prompt} onChange={e => setPrompt(e.target.value)} />
            <button style={{ ...btn('#475569'), marginTop: 8, fontSize: 11, padding: '4px 9px' }} onClick={() => setPrompt(DEFAULT_PROMPT)}>Reset</button>
          </div>

          {/* State selection */}
          <div style={cardStyle}>
            <div style={{ fontWeight: 700, fontSize: 12, color: S.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Select States</div>

            {campaignsLoading
              ? <div style={{ color: S.muted, fontSize: 12, marginBottom: 10 }}><Spinner />Loading campaigns…</div>
              : campaignStates.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: S.muted, marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>From Campaigns</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflowY: 'auto' }}>
                    {campaignStates.map(cs => {
                      const on = selectedStates.has(cs.code);
                      return (
                        <label key={cs.code} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12 }}>
                          <input type="checkbox" checked={on} onChange={() => toggleState(cs.code)} />
                          <span style={{ background: on ? S.blue : S.border, borderRadius: 3, padding: '0 5px', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{cs.code}</span>
                          <span style={{ color: on ? S.text : S.muted }}>{cs.name}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
                    <button style={{ ...btn('#475569'), fontSize: 11, padding: '3px 8px' }} onClick={() => setSelectedStates(new Set(campaignStates.map(c => c.code)))}>All</button>
                    <button style={{ ...btn('#475569'), fontSize: 11, padding: '3px 8px' }} onClick={() => setSelectedStates(new Set())}>None</button>
                  </div>
                </div>
              )
            }

            <div style={{ borderTop: campaignStates.length ? `1px solid ${S.border}` : 'none', paddingTop: campaignStates.length ? 10 : 0, marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: S.muted, marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Custom State</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input style={{ ...inputStyle, flex: 1 }} placeholder="e.g. Nevada or NV" value={customInput} onChange={e => setCustomInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addCustomState(); }} />
                <button style={btn(S.blue, !customInput.trim())} disabled={!customInput.trim()} onClick={addCustomState}>Add</button>
              </div>
            </div>

            {selectedStates.size > 0 && (
              <div>
                <div style={{ fontSize: 11, color: S.muted, marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Selected ({selectedStates.size})</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {[...selectedStates].map(sk => (
                    <span key={sk} style={{ background: '#1d4ed8', border: `1px solid ${S.blue}`, borderRadius: 5, padding: '2px 8px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
                      {getStateDisplay(sk)}
                      <button onClick={() => removeState(sk)} style={{ background: 'none', border: 'none', color: S.muted, cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <button
            style={{ ...btn(S.green, !baseImage || selectedStates.size === 0 || running), width: '100%', padding: '10px', fontSize: 14 }}
            disabled={!baseImage || selectedStates.size === 0 || running}
            onClick={startGeneration}
          >
            {running
              ? <><Spinner />Generating… ({items.filter(i => i.status === 'done' || i.status === 'error').length}/{items.length})</>
              : `Generate ${selectedStates.size} variation${selectedStates.size !== 1 ? 's' : ''}`
            }
          </button>

          {items.length > 0 && !running && (
            <div style={{ marginTop: 8, fontSize: 12, color: S.muted, textAlign: 'center' }}>
              {doneCount} done{errorCount > 0 ? `, ${errorCount} failed` : ''}
            </div>
          )}
        </div>

        {/* ── Center: results ──────────────────────────────────────────── */}
        <div>
          {items.length === 0 ? (
            <div style={{ ...cardStyle, color: S.muted, fontSize: 13, textAlign: 'center', padding: '60px 20px' }}>
              Upload an image, select states, and click Generate.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
              {items.map((item, idx) => (
                <ResultCard
                  key={item.id}
                  item={item}
                  adName={adName}
                  onRegenerate={() => regenItem(idx)}
                  onNotesChange={val => updateRegenNotes(idx, val)}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Right: settings ──────────────────────────────────────────── */}
        <SettingsPanel settings={settings} onChange={setSettings} imageRatio={baseImage?.ratio} />

      </div>
    </div>
  );
}
