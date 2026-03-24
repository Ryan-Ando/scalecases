import { Router } from 'express';
import fetch from 'node-fetch';

const router = Router();

const GEMINI_MODEL = 'gemini-3.1-flash-image-preview';
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function apiKey() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error('GEMINI_API_KEY not set on server');
  return k;
}

const THINKING_BUDGETS = { low: 512, medium: 2048, high: 8192 };

// POST /api/variations/generate
router.post('/generate', async (req, res) => {
  try {
    const {
      imageBase64, mimeType, state, prompt, notes,
      // generation settings
      outputFormat, temperature, aspectRatio,
      thinkingLevel, topP, topK, seed,
      grounding, codeExecution,
    } = req.body;

    if (!imageBase64) throw new Error('No image provided');
    if (!state)       throw new Error('No state provided');
    if (!prompt)      throw new Error('No prompt provided');

    const fullPrompt = notes?.trim()
      ? `${prompt}\n\n${state}\n\nAdditional notes from user: ${notes.trim()}`
      : `${prompt}\n\n${state}`;

    // Build generation config — image output only
    const generationConfig = {
      response_modalities: ['IMAGE'],
    };

    if (temperature !== undefined && temperature !== '') {
      generationConfig.temperature = parseFloat(temperature);
    }
    if (topP !== undefined && topP !== '') {
      generationConfig.top_p = parseFloat(topP);
    }
    if (topK !== undefined && topK !== '') {
      generationConfig.top_k = parseInt(topK);
    }
    if (seed !== undefined && seed !== '') {
      generationConfig.seed = parseInt(seed);
    }

    // Image generation specific config
    const imgGenConfig = {};
    if (outputFormat) imgGenConfig.output_mime_type = `image/${outputFormat}`;
    if (aspectRatio)  imgGenConfig.aspect_ratio     = aspectRatio;
    if (Object.keys(imgGenConfig).length) {
      generationConfig.image_generation_config = imgGenConfig;
    }

    // Thinking config
    const thinkingBudget = THINKING_BUDGETS[thinkingLevel];
    const thinkingConfig = thinkingBudget ? { thinking_budget: thinkingBudget } : undefined;

    // Tools
    const tools = [];
    if (grounding)     tools.push({ google_search: {} });
    if (codeExecution) tools.push({ code_execution: {} });

    const body = {
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } },
          { text: fullPrompt },
        ],
      }],
      generation_config: generationConfig,
    };

    if (thinkingConfig) body.thinking_config = thinkingConfig;
    if (tools.length)   body.tools = tools;

    const r = await fetch(`${GEMINI_URL}?key=${apiKey()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = await r.json();
    if (json.error) throw new Error(`Gemini error: ${json.error.message}`);

    const parts = json.candidates?.[0]?.content?.parts || [];
    const imgPart  = parts.find(p => p.inline_data);
    const textPart = parts.find(p => p.text);

    if (!imgPart) {
      const msg = textPart?.text
        ? `Gemini returned no image. Message: ${textPart.text}`
        : `Gemini returned no image. Raw: ${JSON.stringify(json).slice(0, 300)}`;
      throw new Error(msg);
    }

    res.json({
      image:    imgPart.inline_data.data,
      mimeType: imgPart.inline_data.mime_type,
      text:     textPart?.text || '',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
