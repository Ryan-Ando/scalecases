import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';

const router = Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
  const { campaign, adsets = [], kpis = {}, trainingNotes = [], timeframeLabel = '7 days' } = req.body;
  if (!campaign) return res.status(400).json({ error: 'campaign required' });

  const kpiBlock = [
    kpis.targetCpl   ? `Target CPL: $${kpis.targetCpl}` : null,
    kpis.targetCpc   ? `Target CPC: $${kpis.targetCpc}` : null,
    kpis.minLeads    ? `Min leads per day: ${kpis.minLeads}` : null,
    kpis.notes       ? `Additional context: ${kpis.notes}` : null,
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

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "rating": "good" | "warning" | "poor",
  "summary": "2–3 sentence plain-English summary referencing actual numbers",
  "insights": ["specific data-driven insight", "another insight", "another insight"],
  "recommendations": ["one actionable recommendation", "another recommendation"]
}

Rating guide: "good" = on target or better, "warning" = mixed/needs attention, "poor" = significantly off target, not spending, or high CPL.
Never suggest pausing or directly editing ads — only provide observations and advice.`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in AI response');
    const result = JSON.parse(jsonMatch[0]);
    if (!result.rating || !result.summary) throw new Error('Invalid AI response structure');
    res.json(result);
  } catch (err) {
    console.error('Campaign analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
