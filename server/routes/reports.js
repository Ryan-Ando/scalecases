import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';

const router = Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Extracts the first complete JSON array from text using bracket depth tracking.
// Avoids greedy-regex pitfalls where trailing commentary contains extra brackets.
function extractJsonArray(text) {
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape)            { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true; continue; }
    if (ch === '"')        { inStr = !inStr; continue; }
    if (inStr)             continue;
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

// Same for a single JSON object.
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape)            { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true; continue; }
    if (ch === '"')        { inStr = !inStr; continue; }
    if (inStr)             continue;
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

function fmtBudget(item) {
  if (item.dailyBudget) return `$${(parseFloat(item.dailyBudget) / 100).toFixed(0)}/day`;
  if (item.lifetimeBudget) return `$${(parseFloat(item.lifetimeBudget) / 100).toFixed(0)} lifetime`;
  return 'N/A';
}

function fmtVideoTime(videoActions) {
  if (!Array.isArray(videoActions)) return 'N/A';
  const v = videoActions.find(a => a.action_type === 'video_view');
  if (!v) return 'N/A';
  const s = parseFloat(v.value);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${s.toFixed(1)}s`;
}

// POST /api/reports/analyze
// Body: { campaign, adsets, kpis, trainingNotes, timeframeLabel }
// Returns: { rating, summary, insights, recommendations }
router.post('/analyze', async (req, res) => {
  const { campaign, adsets = [], kpis = {}, trainingNotes = [], timeframeLabel = '7 days',
          globalRules = '', campaignRules = '' } = req.body;
  if (!campaign) return res.status(400).json({ error: 'campaign required' });

  const kpiBlock = [
    kpis.targetCpl     ? `Target CPL: $${kpis.targetCpl}` : null,
    kpis.targetCpc     ? `Target CPULC: $${kpis.targetCpc}` : null,
    kpis.targetCpm     ? `Target CPM: $${kpis.targetCpm}` : null,
    kpis.targetCtr     ? `Target Unique CTR: ${kpis.targetCtr}%` : null,
    kpis.maxFrequency  ? `Max acceptable frequency: ${kpis.maxFrequency}` : null,
    kpis.targetSpend   ? `Target daily spend: $${kpis.targetSpend}` : null,
    kpis.minLeads      ? `Min leads per day: ${kpis.minLeads}` : null,
    kpis.minVideoTime  ? `Min video avg play time: ${kpis.minVideoTime}s` : null,
    kpis.notes         ? `Additional context: ${kpis.notes}` : null,
  ].filter(Boolean).join('\n') || 'No KPI targets set — use general best practices.';

  const trainingBlock = trainingNotes.length
    ? `Historical performance notes for this campaign:\n${trainingNotes.map(n => `- [${n.type}] ${n.text}`).join('\n')}`
    : '';

  const adsetBlock = adsets.length
    ? `Adsets (${adsets.length} total, showing all):\n` + adsets.map(a =>
        `  • ${a.name}: ${a.effectiveStatus || a.status}, budget ${fmtBudget(a)}, ` +
        `spent $${parseFloat(a.spend || 0).toFixed(2)}, ${a.results || 0} leads, ` +
        `CPL $${a.cost_per_result ? parseFloat(a.cost_per_result).toFixed(2) : 'N/A'}, ` +
        `CTR ${a.unique_ctr ? parseFloat(a.unique_ctr).toFixed(2) + '%' : 'N/A'}, ` +
        `freq ${a.frequency ? parseFloat(a.frequency).toFixed(2) : 'N/A'}, ` +
        `video avg ${fmtVideoTime(a.video_avg_time_watched_actions)}`
      ).join('\n')
    : 'Adset breakdown not available.';

  const prompt = `You are an expert Facebook advertising analyst for a law firm. Analyze this campaign and return a JSON performance report.

CAMPAIGN: ${campaign.name}
TIMEFRAME: ${timeframeLabel}
STATUS: ${campaign.effectiveStatus || campaign.status}
BUDGET: ${fmtBudget(campaign)}
SPEND: $${parseFloat(campaign.spend || 0).toFixed(2)}
RESULTS/LEADS: ${campaign.results || 0}
COST PER RESULT: ${campaign.cost_per_result ? '$' + parseFloat(campaign.cost_per_result).toFixed(2) : 'N/A'}
IMPRESSIONS: ${campaign.impressions || 0}
UNIQUE LINK CLICKS: ${campaign.unique_clicks || 0}
COST PER UNIQUE CLICK: ${campaign.cost_per_unique_click ? '$' + parseFloat(campaign.cost_per_unique_click).toFixed(2) : 'N/A'}
CPM: ${campaign.cpm ? '$' + parseFloat(campaign.cpm).toFixed(2) : 'N/A'}
FREQUENCY: ${campaign.frequency ? parseFloat(campaign.frequency).toFixed(2) : 'N/A'}
UNIQUE CTR: ${campaign.unique_ctr ? parseFloat(campaign.unique_ctr).toFixed(2) + '%' : 'N/A'}

${adsetBlock}

KPI TARGETS:
${kpiBlock}

${trainingBlock}
${globalRules.trim() ? `\nSTANDING RULES (apply to ALL campaigns — follow strictly):\n${globalRules.trim()}` : ''}
${campaignRules.trim() ? `\nCAMPAIGN-SPECIFIC RULES (for this campaign only):\n${campaignRules.trim()}` : ''}

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "rating": "good" | "leave_on" | "needs_attention" | "underperforming" | "turn_off" | "wait",
  "action": "One direct sentence starting with: Leave on, Turn off, Scale/duplicate, or Monitor. State verdict + key reason. No fluff.",
  "reasons": ["short bullet citing a specific number or trend", "short bullet citing a specific number or trend"]
}

Rules: "action" is one sentence max. "reasons" is 2–5 bullets, each must reference a specific number or observed trend. No generic statements.
Rating guide: "good"=beating targets | "leave_on"=CPL ok, secondary stats weak | "needs_attention"=declining but thresholds not met | "underperforming"=below targets, turn-off not warranted | "turn_off"=CPL exceeded threshold AND supporting metrics 1.25× above KPI | "wait"=under $50 spend.`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0]?.text || '';
    const jsonStr = extractJsonObject(text);
    if (!jsonStr) throw new Error('No JSON in AI response');
    const result = JSON.parse(jsonStr);
    if (!result.rating || !result.action) throw new Error('Invalid AI response structure');
    res.json(result);
  } catch (err) {
    console.error('Campaign analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reports/analyze-batch
// Body: { rows, level, kpis, timeframeLabel, globalRules, campaignRules }
// Returns: [{ id, rating, summary, insights, recommendations }]
router.post('/analyze-batch', async (req, res) => {
  const { rows = [], level = 'adset', kpis = {}, timeframeLabel = '7 days',
          globalRules = '', campaignRules = '' } = req.body;
  if (!rows.length) return res.status(400).json({ error: 'rows required' });

  const levelLabel = level === 'ad' ? 'Ad' : 'Ad Set';

  const kpiBlock = [
    kpis.targetCpl     ? `Target CPL: $${kpis.targetCpl}` : null,
    kpis.targetCpc     ? `Target CPULC: $${kpis.targetCpc}` : null,
    kpis.targetCpm     ? `Target CPM: $${kpis.targetCpm}` : null,
    kpis.targetCtr     ? `Target Unique CTR: ${kpis.targetCtr}%` : null,
    kpis.maxFrequency  ? `Max acceptable frequency: ${kpis.maxFrequency}` : null,
    kpis.targetSpend   ? `Target daily spend: $${kpis.targetSpend}` : null,
    kpis.minLeads      ? `Min leads per day: ${kpis.minLeads}` : null,
    kpis.minVideoTime  ? `Min video avg play time: ${kpis.minVideoTime}s` : null,
    kpis.notes         ? `Additional context: ${kpis.notes}` : null,
  ].filter(Boolean).join('\n') || 'No KPI targets set — use general best practices.';

  const rowsBlock = rows.map((r, i) =>
    `${i + 1}. ID: ${r.id}\n` +
    `   Name: ${r.name} | Status: ${r.effectiveStatus || r.status} | Budget: ${fmtBudget(r)}\n` +
    (r.trendSummary
      ? `   Performance data (lifetime):\n${r.trendSummary.split('\n').map(l => '     ' + l).join('\n')}`
      : `   Spend: $${parseFloat(r.spend || 0).toFixed(2)} | Leads: ${r.results || 0} | CPL: ${r.cost_per_result ? '$' + parseFloat(r.cost_per_result).toFixed(2) : 'N/A'} | CPM: ${r.cpm ? '$' + parseFloat(r.cpm).toFixed(2) : 'N/A'} | CTR: ${r.unique_ctr ? parseFloat(r.unique_ctr).toFixed(2) + '%' : 'N/A'}`)
  ).join('\n\n');

  const prompt = `You are an expert Facebook advertising analyst for a law firm. Rate each of the following ${rows.length} ${levelLabel.toLowerCase()}s. Use the lifetime performance data (all-time/last-7d/last-3d) as the primary basis for your analysis.

KPI TARGETS:
${kpiBlock}
${globalRules.trim() ? `\nSTANDING RULES (follow strictly for all):\n${globalRules.trim()}` : ''}
${campaignRules.trim() ? `\nCAMPAIGN-SPECIFIC RULES:\n${campaignRules.trim()}` : ''}

${levelLabel.toUpperCase()}S TO ANALYZE:
${rowsBlock}

Return ONLY a valid JSON array with exactly ${rows.length} entries — one per ${levelLabel.toLowerCase()} — using their exact IDs (no markdown, no explanation):
[{"id":"<exact id>","rating":"good"|"leave_on"|"needs_attention"|"underperforming"|"turn_off"|"wait","action":"one sentence starting with Leave on/Turn off/Scale/Monitor + key reason","reasons":["bullet with specific number or trend","bullet with specific number or trend"]}]

Rating guide: "good"=beating targets | "leave_on"=CPL ok, secondary stats weak | "needs_attention"=declining, thresholds not met | "underperforming"=below targets, turn-off not warranted | "turn_off"=CPL exceeded threshold AND supporting metrics 1.25× above KPI | "wait"=under $50.
"action": one sentence max. "reasons": 2–5 bullets each citing a specific number or trend. No generic statements. Weight last 3d and 7d more heavily than all-time.`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0]?.text || '';
    const jsonStr = extractJsonArray(text);
    if (!jsonStr) throw new Error('No JSON array in AI response');
    const results = JSON.parse(jsonStr);
    if (!Array.isArray(results)) throw new Error('Invalid AI response structure');
    res.json(results);
  } catch (err) {
    console.error('Batch analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reports/analyze-row
// Body: { row, level, kpis, timeframeLabel, globalRules, campaignRules }
// Returns: { rating, summary, insights, recommendations }
router.post('/analyze-row', async (req, res) => {
  const { row, level = 'adset', kpis = {}, timeframeLabel = '7 days',
          globalRules = '', campaignRules = '' } = req.body;
  if (!row) return res.status(400).json({ error: 'row required' });

  const levelLabel = level === 'ad' ? 'AD' : 'AD SET';

  const kpiBlock = [
    kpis.targetCpl     ? `Target CPL: $${kpis.targetCpl}` : null,
    kpis.targetCpc     ? `Target CPULC: $${kpis.targetCpc}` : null,
    kpis.targetCpm     ? `Target CPM: $${kpis.targetCpm}` : null,
    kpis.targetCtr     ? `Target Unique CTR: ${kpis.targetCtr}%` : null,
    kpis.maxFrequency  ? `Max acceptable frequency: ${kpis.maxFrequency}` : null,
    kpis.targetSpend   ? `Target daily spend: $${kpis.targetSpend}` : null,
    kpis.minLeads      ? `Min leads per day: ${kpis.minLeads}` : null,
    kpis.minVideoTime  ? `Min video avg play time: ${kpis.minVideoTime}s` : null,
    kpis.notes         ? `Additional context: ${kpis.notes}` : null,
  ].filter(Boolean).join('\n') || 'No KPI targets set — use general best practices.';

  const prompt = `You are an expert Facebook advertising analyst for a law firm. Analyze this ${levelLabel.toLowerCase()} and return a JSON performance report.

${levelLabel}: ${row.name}
STATUS: ${row.effectiveStatus || row.status}
BUDGET: ${fmtBudget(row)}
${row.campaignName ? `CAMPAIGN: ${row.campaignName}` : ''}
${row.trendSummary
  ? `\nPERFORMANCE DATA (lifetime all-time/last-7d/last-3d — BASE YOUR ENTIRE ANALYSIS ON THIS):\n${row.trendSummary}`
  : `\nSELECTED PERIOD DATA (${timeframeLabel} — use as fallback only):\nSPEND: $${parseFloat(row.spend || 0).toFixed(2)} | LEADS: ${row.results || 0} | CPL: ${row.cost_per_result ? '$' + parseFloat(row.cost_per_result).toFixed(2) : 'N/A'} | CPM: ${row.cpm ? '$' + parseFloat(row.cpm).toFixed(2) : 'N/A'} | CTR: ${row.unique_ctr ? parseFloat(row.unique_ctr).toFixed(2) + '%' : 'N/A'} | FREQ: ${row.frequency ? parseFloat(row.frequency).toFixed(2) : 'N/A'}`
}

KPI TARGETS:
${kpiBlock}
${globalRules.trim() ? `\nSTANDING RULES (apply to ALL campaigns — follow strictly):\n${globalRules.trim()}` : ''}
${campaignRules.trim() ? `\nCAMPAIGN-SPECIFIC RULES (for this campaign only):\n${campaignRules.trim()}` : ''}

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "rating": "good" | "leave_on" | "needs_attention" | "underperforming" | "turn_off" | "wait",
  "action": "One direct sentence. Must start with one of: Leave on, Turn off, Scale/duplicate, or Monitor. No fluff. E.g. 'Turn off — CPL has exceeded the 2× threshold with declining CTR and rising CPM.'",
  "reasons": ["short bullet — specific number or trend", "short bullet — specific number or trend"]
}

Rules for each field:
- "action": single sentence, lead with the verdict, follow with the key reason. No hedging.
- "reasons": 2–5 bullets max. Each bullet must cite a specific number or observed trend. No generic statements. No full paragraphs.

Rating guide (pick exactly one):
- "good"            — Hitting or beating KPI targets. Keep running.
- "leave_on"        — CPL acceptable, secondary stats weak or declining. Leave on, monitor.
- "needs_attention" — Showing signs of decline but thresholds not met yet.
- "underperforming" — Below targets but turn-off criteria not met.
- "turn_off"        — CPL has exceeded threshold for lead tier AND supporting metrics are 1.25× above KPI.
- "wait"            — Spend under $50. Too early. No recommendations.
If trend data is present, weight last 3d and 7d more heavily than all-time.`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0]?.text || '';
    const jsonStr = extractJsonObject(text);
    if (!jsonStr) throw new Error(`No JSON in AI response: ${text.slice(0, 200)}`);
    const result = JSON.parse(jsonStr);
    if (!result.rating || !result.action) throw new Error('Invalid AI response structure');
    res.json(result);
  } catch (err) {
    console.error('Row analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
