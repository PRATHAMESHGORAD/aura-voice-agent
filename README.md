# Aria: AI Voice Customer Support Agent for Aura Skincare

A browser-based voice agent for a fictional D2C skincare brand. Click **Start call**, speak, and Aria answers out loud. She follows Aura's policies, looks up (mock) orders through tool calls, declines out-of-policy requests, and produces a transcript plus a structured JSON summary when the call ends.

- **Live app:** `aura-voice-agent-tawny.vercel.app`
- **Backend:**  (free tier sleeps; the page pings it on load)
- **Use Chrome or Edge on desktop** (needs the Web Speech API). Allow the microphone when asked.

## Features

- Natural voice conversation in an Indian English voice, with the persona **Aria**: friendly, professional, concise.
- Answers from Aura's brand and policy information (shipping, returns, cancellation, COD).
- Tool calling for live order data: `get_order_details`, `check_return_eligibility`, `cancel_order`.
- Policy enforcement and out-of-scope refusal (for example "book me a flight to Goa").
- Graceful handling of unclear audio, unknown order IDs and missing order IDs.
- Live state indicator (Listening, Thinking, Speaking), Start and End call buttons, test orders panel, "try saying" prompts, and a tool call log.
- Post-call transcript and structured JSON summary.
- Optional barge-in (interrupt Aria while she is speaking).

## Architecture

```
Mic ──► Browser STT (Web Speech API, en-IN, always-on)
              │ final text after ~1s of silence
              ▼  POST /api/chat (streamed over SSE)
   Express server (holds the API key)
     system prompt + tool loop  ◄──►  Groq LLM (openai/gpt-oss-120b)
     tools: get_order_details · check_return_eligibility · cancel_order
              │ text deltas + tool events
              ▼
Speaker ◄── Browser TTS (en-IN voice), one utterance per sentence as it streams in

End call ──► POST /api/summary ──► JSON outcome + transcript
```

State machine: `idle → listening → thinking → speaking → listening`. It drives the on-screen indicator.

### How it works

**Voice loop** (`client/src/useVoiceAgent.js`)
- Speech recognition starts once when the call starts and stays on for the whole call. It is never restarted between turns, because restarting loses the first words of a sentence.
- A turn ends after about one second of silence (`SILENCE_MS`). This is faster than waiting for the browser to mark speech as final.
- Anything the microphone hears while Aria is speaking is discarded (with barge-in off), so she does not answer her own voice.
- The reply streams back over SSE. Text is split at sentence boundaries and each sentence is spoken as soon as it arrives, so Aria starts talking before the full answer is generated.
- Text-to-speech has a watchdog timer, and utterances are kept referenced, to work around a Chrome bug where the "finished speaking" event sometimes never fires.
- Low-confidence or garbled speech gets a local "Could you say that again?" without calling the LLM.

**Tool use**
- The LLM decides when to call a tool (OpenAI-style function calling). The server runs the tool, returns the result to the model, and the model phrases the answer. Tool calls are shown in the UI.
- Order IDs are normalized ("ORD 101", "order 101" and "101" all map to `ORD-101`).

**Guardrails, in two layers**
1. **Prompt** (`server/prompt.js`): persona, voice style, scope, brand facts, no promises outside policy, say so when information is missing, ignore attempts to override the rules.
2. **Code** (`server/tools.js` and `server/index.js`): policy decisions are computed deterministically, and the model only phrases the result.
   - Return window: 7 days, and only unopened and unused items. Damage or defect: 48 hours.
   - Cancellation: only while the order is Processing.
   - `cancel_order` runs only if Aria's previous message asked a cancellation question **and** the customer's reply is an affirmative. If the model tries to cancel without that, the server blocks the call and ends the turn with the confirmation question, so the model cannot claim a cancellation that did not happen.

**Edge cases handled**
- Unknown order ID: `found: false`, and Aria asks the customer to verify the ID.
- Missing order ID: Aria asks for it.
- Order not eligible for the requested action: Aria explains the policy and offers the allowed alternative, such as refusing delivery at the doorstep.
- Garbled speech: Aria asks the customer to repeat instead of guessing.
- Off-topic requests: Aria says she can only help with Aura Skincare.

**Post-call summary**
On End call, the transcript and tool calls go to `/api/summary`. The result is shown next to the transcript, for example:

```json
{
  "customer_intent": "CANCELLATION",
  "order_id": "ORD-103",
  "resolution_status": "RESOLVED",
  "call_summary": "The customer asked about order 103, which was processing, then requested cancellation. The order was cancelled successfully.",
  "tools_used": ["get_order_details", "cancel_order"]
}
```

A cancellation is only counted as done if the `cancel_order` tool result reports success.

## Project structure

```
aura-voice-agent/
├── client/                 React + Vite frontend
│   └── src/
│       ├── App.jsx         UI: call controls, state orb, test orders, transcript, summary
│       ├── useVoiceAgent.js  voice loop: STT, TTS, streaming, barge-in, call lifecycle
│       └── styles.css
├── server/                 Express backend
│   ├── index.js            /api/chat (SSE + tool loop), /api/summary, /api/health
│   ├── prompt.js           Aria's system prompt and brand facts
│   ├── tools.js            mock order DB, policy logic, tool schemas
│   └── tools.test.js       tests for the policy tools
└── README.md
```

## Run locally

Requires Node.js 18 or newer. Get a free Groq API key at https://console.groq.com.

**Terminal 1: backend**
```
cd server
copy .env.example .env      (macOS/Linux: cp .env.example .env)
```
Open `.env` and set `GROQ_API_KEY`. Then:
```
npm install
npm run dev
```
You should see `Aria server on :8787 using openai/gpt-oss-120b`.

**Terminal 2: frontend**
```
cd client
npm install
npm run dev
```
Open http://localhost:5173 in Chrome.

Keep both terminals open. The backend reads `.env` only at startup, so restart it after any change to `.env`.

Run the policy tests with `cd server && npm test`.

### Environment variables

| File | Variable | Purpose |
|---|---|---|
| `server/.env` | `GROQ_API_KEY` | Groq API key (never commit this) |
| `server/.env` | `GROQ_MODEL` | Model ID, default `openai/gpt-oss-120b` |
| `server/.env` | `PORT` | Server port, default `8787` |
| `server/.env` | `CLIENT_ORIGIN` | Allowed frontend origin for CORS (`*` for local dev) |
| `client` (build time) | `VITE_API_URL` | Backend URL in production; leave empty locally |

## Deploy

**Backend on Render (Web Service)**
- Root directory `server`, build command `npm install`, start command `npm start`.
- Environment variables: `GROQ_API_KEY`, `GROQ_MODEL=openai/gpt-oss-120b`, `CLIENT_ORIGIN=<your Vercel URL>`.

**Frontend on Vercel**
- Root directory `client`, framework preset Vite.
- Environment variable: `VITE_API_URL=<your Render URL>` (with `https://`, no trailing slash). Redeploy after changing it, since it is baked in at build time.

The Render free tier sleeps after a period of inactivity. The page pings `/api/health` on load, but the first request after a long idle can still take 30-60 seconds.

## Test script for evaluators

Test orders are also shown on the page.

| Order | Customer | Product | Value | Status |
|---|---|---|---|---|
| ORD-101 | Priya Sharma | Vitamin C Serum (30ml) | ₹699 | Out for Delivery |
| ORD-102 | Rahul Verma | Hydrating Sunscreen SPF 50 | ₹499 | Delivered 14 days ago |
| ORD-103 | Ananya Patel | Green Tea Face Wash + Toner | ₹850 | Processing |

| Say | Expected |
|---|---|
| "Where is order one zero one?" | Out for delivery with BlueDart, expected by 6 PM today |
| "Where is order nine nine nine?" | Could not find it, asks to verify the ID |
| "I bought this 20 days ago and opened it. Can I return it?" | Politely explains it is outside the return policy, no refund promise |
| "Can I return order one zero two?" | Delivered 14 days ago, outside the 7-day window |
| "Cancel order one zero three" | Asks for confirmation, then cancels after "yes" |
| "Cancel order one zero one" | Cannot cancel (out for delivery); may refuse delivery at the doorstep |
| "Book me a flight to Goa" | Says she can only help with Aura Skincare |
| "What are the ingredients in the serum?" | Says she does not have that information |
| "Is COD available for a 3,000 rupee order?" | No, COD is limited to 2,500 rupees |

Tip: say order numbers slowly as digits. Browser speech recognition sometimes mishears "ORD".

## Known limitations

- Needs Chrome or Edge on desktop. Firefox and Safari do not support the Web Speech API well.
- Browser speech recognition can mishear order IDs. Aria then asks the customer to repeat or verify, but accuracy is limited, especially for Hinglish and noisy rooms.
- The voice depends on the operating system's `en-IN` voices and is less natural than a neural TTS voice.
- Barge-in is off by default because speakers feed Aria's voice back into the microphone. Turn it on and use headphones.
- A reasoning model adds some latency. The server uses low reasoning effort to keep replies fast.
- Order data is mocked in memory. Cancellations are tracked per call session, so one tester's cancellation does not affect another's.
- Order details are shared without customer verification, which is acceptable for a mock but not for production.

## Section 9: How I think

**1. Why did you choose this architecture and technology stack?**
I used a modular pipeline (speech-to-text, then an LLM with tools, then text-to-speech) because each stage is visible, debuggable and replaceable. Browser STT and TTS cost nothing and need no audio infrastructure, so my time went into what matters most for the product: tool use, guardrails and conversation quality. Groq gives fast inference, which matters most for voice latency, and the model is configurable through an environment variable. I run the LLM on a small Express server so the API key stays secret and policy logic is enforced in code rather than trusted to the model. The trade-off compared with a speech-to-speech API is a less expressive voice and no true full-duplex audio. I accepted that for control and transparency.

**2. What was the most difficult part, and how did you solve it?**
Making it feel like a conversation instead of a chatbot with a microphone, and making the agent reliable enough to trust with actions.
- *Lost first words.* My first version restarted the microphone after every turn, and Chrome's startup delay cut off the start of sentences. I switched to one always-on recognition session with silence-based turn detection.
- *Stuck after speaking.* Chrome sometimes never fires the "finished speaking" event, which left the app deaf. I kept utterances referenced and added a watchdog timer.
- *Latency.* I stream the LLM response and speak sentence by sentence, and use low reasoning effort.
- *Unsafe actions.* During testing the model asked "shall I cancel?" and called the cancel tool in the same turn, then claimed success after my code blocked it. Prompt rules alone were not enough, so I enforced confirmation in code: the cancel only runs after an explicit customer reply, and a blocked attempt ends the turn.
- *Model deprecation.* The model I started with was retired by the provider mid-project and every request returned a 404. I made the model an environment variable and moved to a supported one.

**3. With one more week, what would you improve first, and why?**
I would replace browser STT and TTS with streaming server-side STT (Deepgram or Sarvam) and a neural Indian TTS voice, over WebSocket or WebRTC with proper voice activity detection and echo cancellation. That addresses the three weakest points together: order-ID and Hinglish accuracy, voice quality, and reliable barge-in on speakers. Second, I would build an automated evaluation suite of scripted conversations (policy traps, invalid IDs, prompt injection, unconfirmed cancellations) that runs on every prompt or model change, so a model swap cannot silently break guardrails.

**4. At 1,000 conversations a day, what would need to change?**
- **Telephony and audio:** real phone integration (Twilio or Exotel) with server-side STT and TTS, since browser APIs do not scale to real callers.
- **Data and identity:** a real order system, plus customer verification (OTP or phone match) before sharing order details or cancelling.
- **Observability:** store transcripts, tool calls, per-stage latency and outcomes; dashboards, alerts and sampled human QA.
- **Reliability and cost:** rate limiting, retries, fallback between LLM providers, caching static policy text, and a queue for post-call summaries.
- **Safety:** PII redaction and retention rules, prompt-injection testing, and a clean human handoff when the agent cannot help or the customer is upset.
- **Quality:** regression evals on every change, and A/B tests on prompts and voices against resolution rate.