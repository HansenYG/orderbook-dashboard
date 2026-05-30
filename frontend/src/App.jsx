import React from 'react';
import { useEventStream } from './hooks/useEventStream.js';
import { OrderbookView } from './components/OrderbookView.jsx';
import { MetricsPanel } from './components/MetricsPanel.jsx';
import { AlertsCenter } from './components/AlertsCenter.jsx';
import { Toaster } from './components/Toaster.jsx';
import { fmtClock } from './format.js';

function StatusPill({ exchange, status }) {
  const state = status?.state ?? 'closed';
  const live = state === 'open' || state === 'simulated';
  const cls = live ? (state === 'simulated' ? 'sim' : 'on') : 'off';
  return (
    <span className={`status-pill status-${cls}`}>
      <span className={`dot dot-${cls}`} />
      {exchange}
      <span className="muted tiny">{state}</span>
    </span>
  );
}

export default function App() {
  const { state, dismissToast } = useEventStream();
  const { connected, books, cross, status, alerts, toasts, serverTime } = state;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⊞</span>
          <div>
            <h1>BTC Perp Orderbook</h1>
            <span className="muted small">Binance × Hyperliquid · normalized real-time</span>
          </div>
        </div>
        <div className="topbar-status">
          <StatusPill exchange="Binance" status={status.Binance} />
          <StatusPill exchange="Hyperliquid" status={status.Hyperliquid} />
          <span className={`status-pill ${connected ? 'status-on' : 'status-off'}`}>
            <span className={`dot dot-${connected ? 'on' : 'off'}`} />
            {connected ? 'Stream live' : 'Reconnecting…'}
          </span>
          <span className="muted tiny clock">{fmtClock(serverTime)}</span>
        </div>
      </header>

      <main className="layout">
        <div className="layout-main">
          <OrderbookView books={books} status={status} />
          <MetricsPanel books={books} cross={cross} />
        </div>
        <aside className="layout-side">
          <AlertsCenter alerts={alerts} />
        </aside>
      </main>

      <Toaster toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
