import { useEffect, useRef, useState } from 'react';

const API = import.meta.env.VITE_API_URL || '';
const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
const GREETING = 'Hi, this is Aria from Aura Skincare. How can I help you today?';
const UNCLEAR = "Sorry, I didn't catch that. Could you say it again?";
const SILENCE_MS = 1000; // quiet time after your last word before Aria answers
const ECHO_TAIL_MS = 900; // ignore the mic this long after Aria stops (her voice echoing back)
const norm = (x) => x.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

if (typeof speechSynthesis !== 'undefined') speechSynthesis.getVoices(); // warm up voice list

// Text-to-speech cleanup only; the transcript keeps the original text.
const speakable = (t) =>
  t.replace(/[*_#`>]/g, '')
    .replace(/₹\s?([\d,]+)/g, '$1 rupees')
    .replace(/ORD[-\s]?(\d+)/gi, (_, d) => `order ${d.split('').join(' ')}`)
    .trim();

const pickVoice = () => {
  const v = speechSynthesis.getVoices();
  const norm = (x) => x.lang.replace('_', '-');
  return v.find((x) => norm(x) === 'en-IN') || v.find((x) => norm(x).startsWith('en-GB')) || v.find((x) => norm(x).startsWith('en')) || null;
};

export function useVoiceAgent() {
  const [state, setState] = useState('idle'); // idle | listening | thinking | speaking
  const [transcript, setTranscript] = useState([]);
  const [toolLog, setToolLog] = useState([]);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const [summary, setSummary] = useState(null);
  const [summarizing, setSummarizing] = useState(false);
  const [bargeIn, setBargeInState] = useState(false);

  // All mutable call state lives in one ref so async callbacks never see stale values.
  const s = useRef({
    active: false, busy: false, listening: false, bargeIn: false,
    turn: 0, pending: 0, streamDone: true, buffer: '', reply: '',
    history: [], tools: [], rec: null, abort: null, voice: null, sessionId: '',
    sil: null, baseIndex: 0, resultsLen: 0, utts: [], mutedUntil: 0, lastAgent: '',
  }).current;

  useEffect(() => { fetch(`${API}/api/health`).catch(() => {}); }, []); // wake a sleeping free-tier backend

  const addLine = (role, text) => {
    if (role === 'agent') s.lastAgent = text;
    setTranscript((t) => [...t, { role, text, at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }]);
  };

  // ---------- TTS ----------
  const speak = (text) => {
    const clean = speakable(text);
    if (!clean) return;
    const u = new SpeechSynthesisUtterance(clean);
    if (s.voice) u.voice = s.voice;
    u.lang = s.voice?.lang || 'en-IN';
    u.rate = 1.05;
    const turn = s.turn;
    s.pending++;
    s.utts.push(u); // keep a reference: Chrome can garbage-collect the utterance and never fire onend
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      s.utts = s.utts.filter((x) => x !== u);
      if (turn !== s.turn) return;
      s.pending--;
      afterSpeech();
    };
    const watchdog = setTimeout(done, clean.length * 90 + 4000); // safety net if onend never fires
    u.onstart = () => { if (turn === s.turn) setState('speaking'); };
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  };

  // Speak each complete sentence as soon as it streams in (latency win).
  const flush = (final) => {
    const parts = s.buffer.split(/(?<=[.!?।])\s+/);
    s.buffer = final ? '' : parts.pop();
    parts.forEach(speak);
  };

  // The mic is always on, so "listening again" just means we start accepting speech.
  const afterSpeech = () => {
    if (!s.active || s.pending > 0 || !s.streamDone) return;
    s.busy = false;
    s.baseIndex = s.resultsLen; // drop anything heard while Aria was talking (echo)
    s.mutedUntil = Date.now() + ECHO_TAIL_MS; // recognition lags the audio, so ignore the echo's tail too
    clearTimeout(s.sil);
    setState('listening');
  };

  const sayLocal = (text) => {
    s.turn++; s.pending = 0; s.streamDone = true; s.busy = true;
    addLine('agent', text);
    speak(text);
  };

  // ---------- Barge-in ----------
  const interrupt = () => {
    s.abort?.abort();
    speechSynthesis.cancel();
    s.turn++; s.pending = 0; s.streamDone = true; s.buffer = ''; s.busy = false;
    const partial = s.reply.trim();
    if (partial) {
      s.history.push({ role: 'assistant', content: `${partial} [customer interrupted]` });
      addLine('agent', `${partial} …`);
    }
    s.reply = '';
    setState('listening');
  };

  // ---------- LLM turn ----------
  const ask = async (text) => {
    clearTimeout(s.sil);
    s.history.push({ role: 'user', content: text });
    addLine('user', text);
    s.busy = true;
    setState('thinking');

    const turn = ++s.turn;
    s.pending = 0; s.buffer = ''; s.reply = ''; s.streamDone = false;
    const ctrl = new AbortController();
    s.abort = ctrl;

    try {
      const res = await fetch(`${API}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({ messages: s.history, sessionId: s.sessionId }),
      });
      if (!res.ok || !res.body) throw new Error('Server unavailable');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop();
        for (const ev of events) {
          if (!ev.startsWith('data: ')) continue;
          if (turn !== s.turn) return;
          const e = JSON.parse(ev.slice(6));
          if (e.type === 'delta') { s.reply += e.text; s.buffer += e.text; flush(false); }
          else if (e.type === 'tool') { s.tools.push({ name: e.name, args: e.args, result: e.result }); setToolLog((l) => [...l, e]); }
          else if (e.type === 'error') throw new Error(e.message);
        }
      }
      if (turn !== s.turn) return;
      flush(true);
    } catch (err) {
      if (err.name === 'AbortError' || turn !== s.turn) return;
      console.error(err);
      s.reply = "Sorry, I'm having trouble right now. Could you please try again?";
      s.buffer = ''; speak(s.reply);
    }
    if (turn !== s.turn) return;
    s.streamDone = true;
    if (s.reply.trim()) { s.history.push({ role: 'assistant', content: s.reply.trim() }); addLine('agent', s.reply.trim()); }
    afterSpeech();
  };

  // ---------- STT (continuous: mic stays on for the whole call) ----------
  const handleFinal = (text, conf) => {
    if (s.busy && !s.bargeIn) return;
    if (s.busy) interrupt();
    if (text.length < 2 || (conf > 0 && conf < 0.4)) return sayLocal(UNCLEAR); // graceful handling of mumbling
    ask(text);
  };

  const startRecognition = () => {
    if (!s.active || s.listening) return;
    const rec = new SR();
    rec.lang = 'en-IN';
    rec.interimResults = true;
    rec.continuous = true;
    rec.onstart = () => { s.listening = true; s.baseIndex = 0; s.resultsLen = 0; };
    rec.onresult = (ev) => {
      s.resultsLen = ev.results.length;
      if (s.baseIndex > ev.results.length) s.baseIndex = 0;
      // Aria is busy and interruptions are off: throw away whatever the mic hears.
      if (s.busy && !s.bargeIn) { s.baseIndex = ev.results.length; clearTimeout(s.sil); return; }

      if (Date.now() < s.mutedUntil) { s.baseIndex = ev.results.length; clearTimeout(s.sil); return; }

      let text = '', conf = 1;
      for (let i = s.baseIndex; i < ev.results.length; i++) {
        text += `${ev.results[i][0].transcript} `;
        if (ev.results[i].isFinal) conf = ev.results[i][0].confidence || 1;
      }
      text = text.trim();
      clearTimeout(s.sil);
      if (!text) return;
      setInterim(text);
      if (s.busy && text.split(/\s+/).length >= 2) interrupt(); // barge-in (only reachable when enabled)

      // Treat a short silence as the end of the customer's turn.
      s.sil = setTimeout(() => {
        s.baseIndex = s.resultsLen;
        setInterim('');
        const heard = norm(text);
        if (heard.split(' ').length >= 4 && norm(s.lastAgent).includes(heard)) return; // echo of Aria
        handleFinal(text, conf);
      }, SILENCE_MS);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setError('Microphone access is blocked. Allow it in the browser address bar, then start the call again.');
        endCall();
      }
    };
    // Chrome ends a session now and then on its own; quietly start a new one.
    rec.onend = () => { s.listening = false; if (s.active) setTimeout(startRecognition, 100); };
    s.rec = rec;
    try { rec.start(); } catch { /* already started */ }
  };

  // ---------- Call lifecycle ----------
  const startCall = async () => {
    if (!SR) { setError('This browser has no speech recognition. Please use Chrome or Edge on desktop.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch { setError('Microphone permission was denied. Allow it and try again.'); return; }

    Object.assign(s, { active: true, busy: true, listening: false, pending: 0, streamDone: true, buffer: '', reply: '',
      history: [{ role: 'assistant', content: GREETING }], tools: [], voice: pickVoice(), sessionId: crypto.randomUUID(),
      baseIndex: 0, resultsLen: 0, utts: [], mutedUntil: 0, lastAgent: '' });
    s.turn++;
    setTranscript([]); setToolLog([]); setSummary(null); setError(''); setInterim('');
    setState('thinking');
    addLine('agent', GREETING);
    speak(GREETING);
    startRecognition();
  };

  const endCall = async () => {
    if (!s.active) return;
    s.active = false; s.busy = false;
    clearTimeout(s.sil);
    s.abort?.abort(); speechSynthesis.cancel(); s.turn++;
    try { s.rec?.abort(); } catch { /* ignore */ }
    setState('idle'); setInterim('');

    if (!s.history.some((m) => m.role === 'user')) { setSummary({ note: 'No customer speech was captured, so there is nothing to summarise.' }); return; }
    setSummarizing(true);
    try {
      const res = await fetch(`${API}/api/summary`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: s.history, tools: s.tools }),
      });
      setSummary(await res.json());
    } catch (e) { setSummary({ error: 'Could not generate the summary.' }); }
    setSummarizing(false);
  };

  const setBargeIn = (v) => { s.bargeIn = v; setBargeInState(v); };

  return { state, transcript, interim, toolLog, error, summary, summarizing, bargeIn, setBargeIn, startCall, endCall };
}