import { useEffect, useRef } from 'react';
import { useVoiceAgent } from './useVoiceAgent';

const ORDERS = [
  { id: 'ORD-101', who: 'Priya Sharma', item: 'Vitamin C Serum (30ml)', value: '₹699', status: 'Out for Delivery', note: 'BlueDart BD-982103, expected by 6 PM today' },
  { id: 'ORD-102', who: 'Rahul Verma', item: 'Hydrating Sunscreen SPF 50', value: '₹499', status: 'Delivered', note: 'Delhivery DL-441029, delivered 14 days ago' },
  { id: 'ORD-103', who: 'Ananya Patel', item: 'Green Tea Face Wash + Toner', value: '₹850', status: 'Processing', note: 'Ordered 3 hours ago, can be cancelled' },
];

const TRY = [
  'Where is my order ORD-101?',
  'I want to return ORD-102',
  'Please cancel ORD-103',
  'Where is order 999?',
  'I bought this 20 days ago and opened it. Can I return it?',
  'Can you book me a flight to Goa?',
];

const LABEL = { idle: 'Ready to call', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking' };

export default function App() {
  const a = useVoiceAgent();
  const inCall = a.state !== 'idle';
  const logRef = useRef(null);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }); }, [a.transcript, a.interim]);

  return (
    <div className="page">
      <header>
        <h1>Aria</h1>
        <p>Voice support for Aura Skincare. Use Chrome or Edge, allow the microphone, then press Start call.</p>
      </header>

      <main>
        <section className="call" aria-label="Call">
          <div className={`orb ${a.state}`} role="status" aria-live="polite">
            <span className="ring" />
            <span className="core" />
          </div>
          <div className="state">{LABEL[a.state]}</div>

          <div className="buttons">
            <button className="start" onClick={a.startCall} disabled={inCall}>Start call</button>
            <button className="end" onClick={a.endCall} disabled={!inCall}>End call</button>
          </div>

          <label className="toggle">
            <input type="checkbox" checked={a.bargeIn} onChange={(e) => a.setBargeIn(e.target.checked)} disabled={inCall} />
            Let me interrupt Aria (wear headphones, speakers cause echo)
          </label>

          {a.error && <p className="error" role="alert">{a.error}</p>}

          <div className="log" ref={logRef} aria-label="Live transcript">
            {a.transcript.length === 0 && !a.interim && <p className="muted">The conversation will appear here.</p>}
            {a.transcript.map((m, i) => (
              <p key={i} className={m.role}><b>{m.role === 'user' ? 'You' : 'Aria'}</b> <small>{m.at}</small><br />{m.text}</p>
            ))}
            {a.interim && <p className="user interim"><b>You</b><br />{a.interim}</p>}
          </div>
        </section>

        <aside>
          <section className="card">
            <h2>Test orders</h2>
            {ORDERS.map((o) => (
              <div className="order" key={o.id}>
                <div><b>{o.id}</b> <span className={`pill ${o.status.replace(/\s/g, '').toLowerCase()}`}>{o.status}</span></div>
                <div>{o.item} · {o.value}</div>
                <div className="muted">{o.who}. {o.note}</div>
              </div>
            ))}
          </section>

          <section className="card">
            <h2>Try saying</h2>
            <ul>{TRY.map((t) => <li key={t}>“{t}”</li>)}</ul>
          </section>

          <section className="card">
            <h2>Tool calls</h2>
            {a.toolLog.length === 0 ? <p className="muted">Tools the agent calls appear here.</p> :
              a.toolLog.map((t, i) => (
                <details key={i}>
                  <summary>{t.name}({Object.values(t.args).join(', ')})</summary>
                  <pre>{JSON.stringify(t.result, null, 2)}</pre>
                </details>
              ))}
          </section>
        </aside>
      </main>

      {(a.summarizing || a.summary) && (
        <section className="card summary" aria-label="Call summary">
          <h2>Call summary</h2>
          {a.summarizing && <p className="muted">Generating summary…</p>}
          {a.summary && (
            <div className="cols">
              <div>
                <h3>Transcript</h3>
                {a.transcript.map((m, i) => <p key={i} className={m.role}><b>{m.role === 'user' ? 'Customer' : 'Aria'}</b> <small>{m.at}</small><br />{m.text}</p>)}
              </div>
              <div>
                <h3>Outcome</h3>
                <pre>{JSON.stringify(a.summary, null, 2)}</pre>
                <button onClick={() => navigator.clipboard.writeText(JSON.stringify(a.summary, null, 2))}>Copy JSON</button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
