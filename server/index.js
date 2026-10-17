import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { SYSTEM_PROMPT } from './prompt.js';
import { TOOLS, runTool, normalizeId } from './tools.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

const groq = (body) => fetch(GROQ_URL, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: MODEL, ...body }),
});

// One streamed LLM round. Forwards text deltas immediately, accumulates tool calls.
async function streamRound(messages, onText) {
  const r = await groq({ messages, tools: TOOLS, tool_choice: 'auto', parallel_tool_calls: false,
    temperature: 0.3, max_tokens: 600, reasoning_effort: 'low', stream: true });
  if (!r.ok) throw new Error(`LLM error ${r.status}: ${(await r.text()).slice(0, 200)}`);

  const dec = new TextDecoder();
  let buf = '', content = '';
  const calls = [];
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      const delta = JSON.parse(data).choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { content += delta.content; onText(delta.content); }
      for (const tc of delta.tool_calls || []) {
        const c = (calls[tc.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.function.name += tc.function.name;
        if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
      }
    }
  }
  return { content, toolCalls: calls.filter(Boolean) };
}

// Streaming chat endpoint (SSE). Runs the tool loop server-side.
app.post('/api/chat', async (req, res) => {
  const { messages = [], sessionId = 'anon' } = req.body || {};
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const convo = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages.slice(-24)];

  let spoken = ''; // everything streamed to the customer during this turn
  const onText = (t) => { spoken += t; send({ type: 'delta', text: t }); };

  // Guardrail in code: cancel_order only runs if Aria's previous message asked the
  // customer a cancellation question AND the customer's reply is an affirmative.
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const lastAria = [...messages].reverse().find((m) => m.role === 'assistant')?.content || '';
  const confirmed = /\b(yes|yeah|yep|yup|sure|ok|okay|haan|han|confirm|go ahead|do it|please do|cancel)\b/i.test(lastUser)
    && /cancel/i.test(lastAria) && /\?/.test(lastAria);

  try {
    for (let round = 0; round < 4; round++) {
      let result;
      try { result = await streamRound(convo, onText); }
      catch (e) {
        // The model occasionally emits a malformed tool call (HTTP 400); one retry usually fixes it.
        if (round === 0 && /400|tool_use_failed/.test(e.message)) result = await streamRound(convo, onText);
        else throw e;
      }
      const { content, toolCalls } = result;
      if (!toolCalls.length) break;
      convo.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });

      let blockedId = null;
      for (const tc of toolCalls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* malformed args -> tool reports missing id */ }
        let out;
        if (tc.function.name === 'cancel_order' && !confirmed) {
          blockedId = normalizeId(args.order_id) || 'this order';
          out = { success: false, needs_confirmation: true, reason: 'Customer has not confirmed yet.' };
        } else {
          out = runTool(tc.function.name, args, sessionId);
        }
        send({ type: 'tool', name: tc.function.name, args, result: out });
        convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out) });
        send({ type: 'delta', text: ' ' });
      }

      // Cancellation attempted without confirmation: stop here. The model gets no
      // chance to claim it cancelled anything. Make sure the turn ends with the question.
      if (blockedId) {
        if (!/\?\s*$/.test(spoken.trim())) send({ type: 'delta', text: `Would you like me to cancel order ${blockedId}?` });
        break;
      }
    }
  } catch (e) {
    console.error('CHAT ERROR:', e.message);
    send({ type: 'error', message: e.message });
  }
  send({ type: 'done' });
  res.end();
});

// Post-call structured summary.
app.post('/api/summary', async (req, res) => {
  const { transcript = [], tools = [] } = req.body || {};
  const text = transcript.map((m) => `${m.role === 'user' ? 'Customer' : 'Aria'}: ${m.content}`).join('\n');
  const toolText = tools.map((t) => `${t.name}(${JSON.stringify(t.args)}) -> ${JSON.stringify(t.result)}`).join('\n');
  try {
    const r = await groq({
      temperature: 0, max_tokens: 1500, reasoning_effort: 'low',
      messages: [
        { role: 'system', content: `You summarise customer support calls for Aura Skincare. Reply with ONLY a JSON object, no other text, with these keys:
"customer_intent": one of ORDER_TRACKING, CANCELLATION, RETURN_REFUND, SHIPPING_INFO, POLICY_INFO, PRODUCT_INFO, OUT_OF_SCOPE, OTHER (pick the main one);
"order_id": the main order ID discussed (like ORD-101) or null;
"resolution_status": one of RESOLVED, PARTIALLY_RESOLVED, UNRESOLVED (policy-declined requests that were explained properly count as RESOLVED);
"call_summary": 1-2 factual sentences. Use only what is in the transcript and tool results. A cancellation only counts as done if a cancel_order tool result has success true.` },
        { role: 'user', content: `TRANSCRIPT:\n${text}\n\nTOOL CALLS:\n${toolText || 'none'}` },
      ],
    });
    if (!r.ok) throw new Error(`LLM error ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const data = await r.json();
    const raw = data.choices[0].message.content || '';
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    res.json({ ...parsed, tools_used: [...new Set(tools.map((t) => t.name))] });
  } catch (e) {
    console.error('SUMMARY ERROR:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`Aria server on :${port} using ${MODEL}`));