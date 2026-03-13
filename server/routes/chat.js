import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';

const router = Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an AI analytics assistant for Scale Cases, a law firm advertising platform. You have access to real-time advertising data and help analyze performance, identify trends, and provide actionable insights.

When given data, be specific — reference actual numbers. Keep responses concise but insightful. Format numbers with $ for spend, use % for rates. If asked to compare or rank, do so clearly.`;

// POST /api/chat  — streaming SSE response
router.post('/', async (req, res) => {
  const { messages, context } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });

  // Build context block from snapshot
  const contextText = context ? `\n\nCurrent advertising data snapshot:\n${JSON.stringify(context, null, 2)}` : '';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const stream = await client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT + contextText,
      messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    console.error('Chat error:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  } finally {
    res.end();
  }
});

export default router;
