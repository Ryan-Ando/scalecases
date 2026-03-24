import { Router } from 'express';
import fetch from 'node-fetch';

const router = Router();

const GEMINI_MODEL = 'gemini-2.0-flash-preview-image-generation';
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function apiKey() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error('GEMINI_API_KEY not set on server');
  return k;
}

// POST /api/variations/generate
// Body: { imageBase64, mimeType, state, prompt, notes? }
router.post('/generate', async (req, res) => {
  try {
    const { imageBase64, mimeType, state, prompt, notes } = req.body;
    if (!imageBase64) throw new Error('No image provided');
    if (!state)       throw new Error('No state provided');
    if (!prompt)      throw new Error('No prompt provided');

    const fullPrompt = notes?.trim()
      ? `${prompt}\n\n${state}\n\nAdditional notes from user: ${notes.trim()}`
      : `${prompt}\n\n${state}`;

    const r = await fetch(`${GEMINI_URL}?key=${apiKey()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } },
            { text: fullPrompt },
          ],
        }],
        generation_config: {
          response_modalities: ['TEXT', 'IMAGE'],
        },
      }),
    });

    const json = await r.json();
    if (json.error) throw new Error(`Gemini error: ${json.error.message}`);

    const parts = json.candidates?.[0]?.content?.parts || [];
    const imgPart  = parts.find(p => p.inline_data);
    const textPart = parts.find(p => p.text);

    if (!imgPart) {
      const msg = textPart?.text ? `Gemini returned no image. Message: ${textPart.text}` : 'Gemini returned no image in response';
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
