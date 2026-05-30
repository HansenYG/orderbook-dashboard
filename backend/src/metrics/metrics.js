// Pure metric calculations over unified snapshots. No side effects.

/**
 * Per-book metrics from a single unified snapshot.
 * @param {object} snapshot unified { bids, asks }
 * @param {number} [depth] levels used for the imbalance calc (default 5)
 */
export function computeBookMetrics(snapshot, depth = 5) {
  const { bids, asks } = snapshot;
  const bestBid = bids[0]?.[0] ?? null;
  const bestAsk = asks[0]?.[0] ?? null;
  if (bestBid == null || bestAsk == null) {
    return { bestBid, bestAsk, mid: null, spread: null, spreadBps: null, imbalance: null };
  }

  const mid = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;
  const spreadBps = mid > 0 ? (spread / mid) * 10000 : null;

  let bidVol = 0;
  let askVol = 0;
  for (let i = 0; i < Math.min(depth, bids.length); i++) bidVol += bids[i][1];
  for (let i = 0; i < Math.min(depth, asks.length); i++) askVol += asks[i][1];
  const totalVol = bidVol + askVol;
  // imbalance ∈ [-1, 1]: +1 = all bid pressure, -1 = all ask pressure.
  const imbalance = totalVol > 0 ? (bidVol - askVol) / totalVol : 0;

  return {
    bestBid,
    bestAsk,
    mid,
    spread,
    spreadBps,
    imbalance,
    bidVol,
    askVol,
    depth,
  };
}

/**
 * Cross-exchange metrics from the two latest per-book metric objects.
 * @param {object|null} a metrics for Binance
 * @param {object|null} b metrics for Hyperliquid
 */
export function computeCrossMetrics(a, b) {
  if (!a?.mid || !b?.mid) {
    return { discrepancyPct: null, midDiff: null, arbSpread: null, avgMid: null };
  }
  const avgMid = (a.mid + b.mid) / 2;
  const midDiff = a.mid - b.mid; // Binance − Hyperliquid
  const discrepancyPct = avgMid > 0 ? (Math.abs(midDiff) / avgMid) * 100 : null;

  // Arbitrage spread: best achievable cross-book edge — buy on the cheaper ask,
  // sell into the richer bid. Positive means a (gross) arbitrage exists.
  const arbAB = b.bestBid - a.bestAsk; // buy Binance ask, sell Hyperliquid bid
  const arbBA = a.bestBid - b.bestAsk; // buy Hyperliquid ask, sell Binance bid
  const arbSpread = Math.max(arbAB, arbBA);

  return { discrepancyPct, midDiff, arbSpread, avgMid };
}
