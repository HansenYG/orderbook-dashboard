// DepthChart: renders a single exchange's top-N book as two stacked ladders —
// asks (red) above, bids (green) below — each row showing price, size, and a
// cumulative-depth bar. Dependency-free (plain divs) so it updates smoothly.
import React from 'react';
import { fmtPrice, fmtSize, fmtNum } from '../format.js';

const LEVELS = 10;

function cumulative(side) {
  let run = 0;
  return side.slice(0, LEVELS).map(([price, size]) => {
    run += size;
    return { price, size, cum: run };
  });
}

function Ladder({ rows, side, maxCum }) {
  // Asks render top-to-bottom from highest to lowest so the spread sits in the
  // middle; bids render best-first downward.
  const ordered = side === 'ask' ? [...rows].reverse() : rows;
  return (
    <div className={`ladder ladder-${side}`}>
      {ordered.map((r, i) => {
        const pct = maxCum > 0 ? (r.cum / maxCum) * 100 : 0;
        return (
          <div className="lvl" key={i}>
            <span
              className={`depthbar depthbar-${side}`}
              style={{ width: `${pct}%` }}
              aria-hidden="true"
            />
            <span className="lvl-price">{fmtPrice(r.price)}</span>
            <span className="lvl-size">{fmtSize(r.size)}</span>
          </div>
        );
      })}
    </div>
  );
}

function DepthChartBase({ exchange, book, status }) {
  const snapshot = book?.snapshot;
  const metrics = book?.metrics;
  const state = status?.state ?? 'closed';

  const bids = snapshot ? cumulative(snapshot.bids) : [];
  const asks = snapshot ? cumulative(snapshot.asks) : [];
  const maxCum = Math.max(bids.at(-1)?.cum ?? 0, asks.at(-1)?.cum ?? 0);

  const live = state === 'open' || state === 'simulated';

  return (
    <div className="depthchart card">
      <div className="depthchart-head">
        <h3>{exchange}</h3>
        <span className={`dot dot-${live ? (state === 'simulated' ? 'sim' : 'on') : 'off'}`} title={state} />
        <span className="muted small">{state}</span>
        {metrics?.mid != null && <span className="mid-badge">{fmtPrice(metrics.mid)}</span>}
      </div>

      {snapshot ? (
        <>
          <div className="ladder-header">
            <span>Price</span>
            <span>Size</span>
          </div>
          <Ladder rows={asks} side="ask" maxCum={maxCum} />
          <div className="spread-row">
            <span className="muted small">spread</span>
            <span>{fmtNum(metrics?.spread, 2)}</span>
            <span className="muted small">{fmtNum(metrics?.spreadBps, 3)} bps</span>
          </div>
          <Ladder rows={bids} side="bid" maxCum={maxCum} />
        </>
      ) : (
        <div className="placeholder muted">waiting for data…</div>
      )}
    </div>
  );
}

// Memoize: only re-render when this exchange's book or status object changes.
export const DepthChart = React.memo(DepthChartBase);
