// Normalizer: transforms raw exchange payloads into one unified schema.
//
//   {
//     exchange: "Binance" | "Hyperliquid",
//     timestamp: <epoch ms>,
//     bids: [[price:Number, size:Number], ...],   // sorted desc by price
//     asks: [[price:Number, size:Number], ...]     // sorted asc  by price
//   }
//
// Every method returns a valid unified snapshot or `null` for malformed/empty
// input (callers drop nulls). It never throws on bad data.
import { config } from '../config.js';

const LEVELS = config.bookLevels;

/** Parse a [price, size] tuple (strings or numbers) → [Number, Number] or null. */
function toLevel(price, size) {
  const p = Number(price);
  const s = Number(size);
  if (!Number.isFinite(p) || !Number.isFinite(s)) return null;
  if (p <= 0 || s < 0) return null;
  return [p, s];
}

function cleanSide(levels, descending) {
  const out = [];
  for (const lvl of levels) {
    const parsed = toLevel(lvl[0], lvl[1]);
    if (parsed && parsed[1] > 0) out.push(parsed); // drop zero-size levels
  }
  out.sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0]));
  return out.slice(0, LEVELS);
}

function finalize(exchange, timestamp, rawBids, rawAsks) {
  const bids = cleanSide(rawBids, true);
  const asks = cleanSide(rawAsks, false);
  if (bids.length === 0 || asks.length === 0) return null;
  const ts = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
  return { exchange, timestamp: ts, bids, asks };
}

export class Normalizer {
  /**
   * Binance USD-M Futures partial book depth stream
   * (`btcusdt@depth20@100ms`). Futures payloads use `b`/`a` with event time `E`
   * (or transaction time `T`); spot-style payloads use `bids`/`asks`. We accept
   * both for robustness.
   */
  static normalizeBinance(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const bids = raw.b ?? raw.bids;
    const asks = raw.a ?? raw.asks;
    if (!Array.isArray(bids) || !Array.isArray(asks)) return null;
    const ts = raw.E ?? raw.T ?? raw.lastUpdateId ?? Date.now();
    return finalize('Binance', ts, bids, asks);
  }

  /**
   * Hyperliquid l2Book message:
   *   { channel: "l2Book",
   *     data: { coin, time, levels: [ bids[], asks[] ] } }
   * where each level is { px, sz, n }. levels[0] = bids, levels[1] = asks.
   * Accepts either the wrapped message or the inner `data` object.
   */
  static normalizeHyperliquid(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const data = raw.channel === 'l2Book' ? raw.data : raw.data ?? raw;
    if (!data || !Array.isArray(data.levels) || data.levels.length < 2) return null;

    const mapSide = (side) =>
      Array.isArray(side) ? side.map((l) => [l.px, l.sz]) : [];

    const bids = mapSide(data.levels[0]);
    const asks = mapSide(data.levels[1]);
    const ts = data.time ?? Date.now();
    return finalize('Hyperliquid', ts, bids, asks);
  }
}
