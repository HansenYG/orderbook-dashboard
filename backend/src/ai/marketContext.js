// Builds the compact, machine-readable market snapshot that is handed to the
// AI assistant on every chat turn. It is assembled from exactly what the live
// dashboard is showing: the SSE hub's latest per-exchange book + metrics and
// cross-exchange metrics, the recent alert history, and a short price trend
// derived from the recent-snapshots store (SQLite history or the in-memory ring
// buffer in MongoDB mode). Keeping it small keeps token cost low and the model
// focused on the numbers that are actually on screen.
import { EXCHANGES } from '../config.js';
import { computeCrossMetrics } from '../metrics/metrics.js';

/** Round to a fixed number of decimals, passing through null/non-finite. */
function round(n, dp = 2) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  const f = 10 ** dp;
  return Math.round(Number(n) * f) / f;
}

/** Top-N [price, size] levels, rounded for compactness. */
function topLevels(levels, depth = 5) {
  return (levels ?? []).slice(0, depth).map(([p, s]) => [round(p, 2), round(s, 4)]);
}

/**
 * Short price trend for one exchange, computed from recent stored snapshots
 * (newest-first). Returns null when there isn't enough history yet.
 */
async function computeTrend(store, exchange, limit = 120) {
  let rows;
  try {
    rows = await store.listSnapshots({ exchange, limit });
  } catch {
    return null;
  }
  const mids = [];
  for (const r of rows) if (r?.mid != null && Number.isFinite(r.mid)) mids.push(r.mid);
  if (mids.length < 2) return null;

  const newest = mids[0]; // listSnapshots is newest-first
  const oldest = mids[mids.length - 1];
  const change = newest - oldest;
  const changePct = oldest ? (change / oldest) * 100 : null;
  const tsNew = rows[0]?.ts;
  const tsOld = rows[rows.length - 1]?.ts;
  const overSeconds =
    tsNew != null && tsOld != null ? Math.max(0, Math.round((tsNew - tsOld) / 1000)) : null;

  return {
    samples: mids.length,
    overSeconds,
    midChange: round(change, 2),
    midChangePct: round(changePct, 4),
    high: round(Math.max(...mids), 2),
    low: round(Math.min(...mids), 2),
    direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
  };
}

/** Trim alerts to the fields the model needs. */
async function recentAlerts(store, limit = 12) {
  let rows;
  try {
    rows = await store.listAlerts({ limit });
  } catch {
    return [];
  }
  return rows.map((a) => ({
    at: a.ts ? new Date(a.ts).toISOString() : null,
    severity: a.severity,
    type: a.type,
    exchange: a.exchange,
    message: a.message,
    value: round(a.value, 4),
    threshold: round(a.threshold, 4),
  }));
}

/**
 * Assemble the full market-context object.
 * @param {object} deps
 * @param {import('../stream/sseHub.js').SseHub} deps.sseHub
 * @param {object} deps.store storage backend (listAlerts / listSnapshots)
 * @param {object} [deps.thresholds] live alert thresholds (for the model's reference)
 */
export async function buildMarketContext({ sseHub, store, thresholds = null }) {
  const state = sseHub.getState(); // { books, cross, status, serverTime }
  const now = state.serverTime ?? Date.now();

  const exchanges = {};
  for (const ex of EXCHANGES) {
    const book = state.books?.[ex];
    const m = book?.metrics ?? null;
    const snap = book?.snapshot ?? null;
    exchanges[ex] = {
      connection: state.status?.[ex]?.state ?? 'unknown',
      mid: round(m?.mid, 2),
      bestBid: round(m?.bestBid, 2),
      bestAsk: round(m?.bestAsk, 2),
      spread: round(m?.spread, 2),
      spreadBps: round(m?.spreadBps, 3),
      // imbalance ∈ [-1,1]: +1 = all bid (buy) pressure, -1 = all ask (sell) pressure.
      imbalanceTop5: round(m?.imbalance, 3),
      bidVolumeTop5: round(m?.bidVol, 4),
      askVolumeTop5: round(m?.askVol, 4),
      topBids: topLevels(snap?.bids),
      topAsks: topLevels(snap?.asks),
      trend: await computeTrend(store, ex),
    };
  }

  // Prefer the hub's published cross metrics; recompute as a fallback.
  const cross =
    state.cross ??
    computeCrossMetrics(state.books?.Binance?.metrics, state.books?.Hyperliquid?.metrics);

  return {
    symbol: 'BTC perpetual',
    generatedAt: new Date(now).toISOString(),
    exchanges,
    crossExchange: {
      midDiffBinanceMinusHyperliquid: round(cross?.midDiff, 2),
      discrepancyPct: round(cross?.discrepancyPct, 4),
      arbitrageGap: round(cross?.arbSpread, 2),
      avgMid: round(cross?.avgMid, 2),
    },
    alertThresholds: thresholds
      ? {
          spreadBps: thresholds.spreadBps,
          imbalance: thresholds.imbalance,
          discrepancyPct: thresholds.discrepancyPct,
        }
      : null,
    recentAlerts: await recentAlerts(store),
    notes:
      'All order-book figures are top-of-book / top-5 levels only; sizes are in BTC. ' +
      'Trend is derived from recent snapshots and may cover only a short window.',
  };
}
