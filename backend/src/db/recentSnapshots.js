// In-memory ring buffer of recent orderbook snapshots, kept per exchange.
//
// In hosted (MongoDB) mode we deliberately do NOT persist the snapshot firehose
// (~10-25 rows/sec → 1-2 GB/day would blow a free DB tier). The live dashboard
// runs entirely off the in-memory SSE feed, so the only thing the snapshot table
// served was the `/api/snapshots` debug/history endpoint. This buffer backs that
// endpoint with the most recent N snapshots per exchange — bounded, zero-cost,
// and lost on restart (which is fine for transient market data).
import { config } from '../config.js';

/** @type {Map<string, object[]>} exchange -> ring of snapshot rows (oldest first) */
const rings = new Map();
let seq = 0; // monotonic id so rows have a stable, sortable identifier
const stats = { buffered: 0, recorded: 0 };

/**
 * Record a snapshot row (shape mirrors the SQLite `orderbook_snapshots` row,
 * with bids/asks kept as arrays rather than JSON strings).
 */
export function record(row) {
  let ring = rings.get(row.exchange);
  if (!ring) {
    ring = [];
    rings.set(row.exchange, ring);
  }
  ring.push({ id: ++seq, ...row });
  const cap = config.recentBufferSize;
  if (ring.length > cap) ring.splice(0, ring.length - cap);
  stats.recorded += 1;
}

/**
 * Recent snapshots, newest first. Optionally filtered to one exchange.
 * @param {object} opts { exchange, limit }
 */
export function list({ exchange = null, limit = 20 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 500);
  let rows;
  if (exchange) {
    rows = (rings.get(exchange) || []).slice();
  } else {
    rows = [];
    for (const ring of rings.values()) rows.push(...ring);
  }
  // Newest first by id (id is monotonic across all exchanges).
  rows.sort((a, b) => b.id - a.id);
  return rows.slice(0, lim);
}

export function getStats() {
  let buffered = 0;
  for (const ring of rings.values()) buffered += ring.length;
  return { buffered, recorded: stats.recorded };
}
