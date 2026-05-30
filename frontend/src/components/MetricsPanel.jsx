// MetricsPanel: per-exchange spread/mid/imbalance + cross-exchange arbitrage
// gap and mid-price discrepancy.
import React from 'react';
import { fmtPrice, fmtNum, fmtPct } from '../format.js';

function Metric({ label, value, sub, tone }) {
  return (
    <div className={`metric ${tone ? 'metric-' + tone : ''}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {sub != null && <div className="metric-sub muted small">{sub}</div>}
    </div>
  );
}

function ImbalanceBar({ value }) {
  if (value == null) return <span className="muted">—</span>;
  // value ∈ [-1, 1]; show a centered bar leaning green (bids) or red (asks).
  const pct = Math.min(Math.abs(value), 1) * 50;
  const isBid = value >= 0;
  return (
    <div className="imbalance-bar" title={`imbalance ${value.toFixed(2)}`}>
      <div className="imbalance-track">
        <div
          className={`imbalance-fill ${isBid ? 'bid' : 'ask'}`}
          style={{ width: `${pct}%`, [isBid ? 'left' : 'right']: '50%' }}
        />
      </div>
      <span className="imbalance-val">{value.toFixed(2)}</span>
    </div>
  );
}

export function MetricsPanel({ books, cross }) {
  const b = books.Binance?.metrics;
  const h = books.Hyperliquid?.metrics;

  const arb = cross?.arbSpread;
  const arbTone = arb != null && arb > 0 ? 'good' : null;
  const discTone =
    cross?.discrepancyPct != null && cross.discrepancyPct > 0.1 ? 'warn' : null;

  return (
    <section className="card metrics-panel">
      <h2>Metrics</h2>

      <div className="metrics-grid">
        <div className="metric-col">
          <div className="metric-col-head">Binance</div>
          <Metric label="Mid" value={fmtPrice(b?.mid)} />
          <Metric label="Spread" value={fmtNum(b?.spread, 2)} sub={`${fmtNum(b?.spreadBps, 3)} bps`} />
          <div className="metric">
            <div className="metric-label">Imbalance (top 5)</div>
            <ImbalanceBar value={b?.imbalance} />
          </div>
        </div>

        <div className="metric-col">
          <div className="metric-col-head">Hyperliquid</div>
          <Metric label="Mid" value={fmtPrice(h?.mid)} />
          <Metric label="Spread" value={fmtNum(h?.spread, 2)} sub={`${fmtNum(h?.spreadBps, 3)} bps`} />
          <div className="metric">
            <div className="metric-label">Imbalance (top 5)</div>
            <ImbalanceBar value={h?.imbalance} />
          </div>
        </div>

        <div className="metric-col metric-col-cross">
          <div className="metric-col-head">Cross-Exchange</div>
          <Metric
            label="Mid Δ (B − H)"
            value={cross?.midDiff != null ? fmtNum(cross.midDiff, 2) : '—'}
          />
          <Metric label="Discrepancy" value={fmtPct(cross?.discrepancyPct, 4)} tone={discTone} />
          <Metric
            label="Arbitrage Gap"
            value={fmtNum(arb, 2)}
            sub={arb != null && arb > 0 ? 'edge available' : 'no edge'}
            tone={arbTone}
          />
        </div>
      </div>
    </section>
  );
}
