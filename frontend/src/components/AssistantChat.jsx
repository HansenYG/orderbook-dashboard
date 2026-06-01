// AssistantChat: a chat panel that asks Claude for market commentary grounded in
// the live Binance × Hyperliquid order-book data. The backend injects the
// current dashboard snapshot into every request, so the model always reasons
// about what's on screen — the UI only sends the conversation text.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const SUGGESTIONS = [
  { label: 'Market situation', prompt: "What's the current market situation?" },
  { label: 'Buy or sell?', prompt: 'Based on the live data, should I lean toward buying or selling right now?' },
  { label: 'Spot anomalies', prompt: 'Are there any anomalies in the order books or feeds right now?' },
  { label: 'Arbitrage?', prompt: 'Is there an arbitrage opportunity between Binance and Hyperliquid right now?' },
];

const GREETING =
  "Ask me about the live market. I read the Binance and Hyperliquid order books, spreads, imbalance, " +
  "cross-exchange discrepancy, and recent alerts shown on this dashboard, and I can suggest a read on the " +
  "market situation, a short-term buy/sell lean, or flag anomalies.";

function Message({ role, content, streaming }) {
  const isUser = role === 'user';
  return (
    <div className={`chat-msg chat-${isUser ? 'user' : 'assistant'}`}>
      <div className="chat-msg-role">{isUser ? 'You' : 'Assistant'}</div>
      <div className="chat-msg-body">
        {content || (streaming ? <span className="chat-typing">Analyzing market data…</span> : '')}
        {streaming && content ? <span className="chat-caret" /> : null}
      </div>
    </div>
  );
}

export function AssistantChat() {
  const [enabled, setEnabled] = useState(null); // null = unknown, true/false once status loads
  const [messages, setMessages] = useState([]); // { role, content }
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const abortRef = useRef(null);
  const scrollRef = useRef(null);

  // Detect whether the backend has an API key configured.
  useEffect(() => {
    let alive = true;
    api
      .getStatus()
      .then((s) => alive && setEnabled(Boolean(s.aiAssistant)))
      // Status probe failed (backend not up yet) — stay optimistic and let the
      // chat be used; a real 503 surfaces inline if the key is actually missing.
      .catch(() => alive && setEnabled(true));
    return () => {
      alive = false;
    };
  }, []);

  // Keep the transcript pinned to the latest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  // Cancel any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function send(text) {
    const content = text.trim();
    if (!content || busy) return;
    setError(null);
    setInput('');

    // Append the user turn plus an empty assistant turn we stream into.
    const history = [...messages, { role: 'user', content }];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setBusy(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      await api.chatStream({
        messages: history,
        signal: ac.signal,
        onText: (delta) => {
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === 'assistant') {
              next[next.length - 1] = { ...last, content: last.content + delta };
            }
            return next;
          });
        },
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        // Stopped by the user — drop the empty assistant bubble if nothing arrived.
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && !last.content) return prev.slice(0, -1);
          return prev;
        });
      } else {
        setError(err.message || 'Request failed');
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && !last.content) return prev.slice(0, -1);
          return prev;
        });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    send(input);
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function reset() {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
  }

  return (
    <section className="card assistant-chat">
      <div className="assistant-head">
        <h2>
          <span className="assistant-spark">✦</span> Market Assistant
        </h2>
        {messages.length > 0 && (
          <button type="button" className="chat-reset" onClick={reset} title="Clear conversation">
            Clear
          </button>
        )}
      </div>

      {enabled === false ? (
        <div className="muted small placeholder">
          The AI assistant isn't configured. Set <code>ANTHROPIC_API_KEY</code> on the backend and
          restart to enable it.
        </div>
      ) : (
        <>
          <div className="chat-transcript" ref={scrollRef}>
            {messages.length === 0 ? (
              <div className="chat-greeting muted small">{GREETING}</div>
            ) : (
              messages.map((m, i) => (
                <Message
                  key={i}
                  role={m.role}
                  content={m.content}
                  streaming={busy && i === messages.length - 1 && m.role === 'assistant'}
                />
              ))
            )}
          </div>

          <div className="chat-suggestions">
            {SUGGESTIONS.map((s) => (
              <button
                key={s.label}
                type="button"
                className="chip"
                disabled={busy || enabled !== true}
                onClick={() => send(s.prompt)}
              >
                {s.label}
              </button>
            ))}
          </div>

          {error && <div className="error-text small chat-error">{error}</div>}

          <form className="chat-input-row" onSubmit={onSubmit}>
            <textarea
              className="chat-input"
              rows={2}
              placeholder={enabled === null ? 'Connecting…' : 'Ask about the market, buy/sell, or anomalies…'}
              value={input}
              disabled={busy || enabled !== true}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
            />
            {busy ? (
              <button type="button" className="chat-send stop" onClick={stop}>
                Stop
              </button>
            ) : (
              <button type="submit" className="chat-send" disabled={!input.trim() || enabled !== true}>
                Send
              </button>
            )}
          </form>
        </>
      )}
    </section>
  );
}
