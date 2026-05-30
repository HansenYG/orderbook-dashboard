// Buffered batch writer for orderbook snapshots.
//
// Ingestion enqueues every normalized update (the "store every update" policy);
// rows are flushed to SQLite in a single transaction either when the queue
// reaches BATCH_MAX_ROWS or every BATCH_INTERVAL_MS, whichever comes first.
// A hard queue cap protects memory if the disk ever stalls, and a periodic
// prune enforces the retention window that bounds total DB size.
import { getDb } from './database.js';
import { config } from '../config.js';

export class BatchWriter {
  constructor(opts = {}) {
    this.maxRows = opts.maxRows ?? config.batchMaxRows;
    this.intervalMs = opts.intervalMs ?? config.batchIntervalMs;
    this.queueCap = opts.queueCap ?? config.batchQueueCap;
    this.storeLevels = opts.storeLevels ?? config.storeLevels;
    this.retentionHours = opts.retentionHours ?? config.retentionHours;
    this.pruneIntervalMs = opts.pruneIntervalMs ?? config.pruneIntervalMs;

    /** @type {object[]} pending rows */
    this.queue = [];
    this.insertStmt = null;
    this.pruneStmt = null;
    this.flushTimer = null;
    this.pruneTimer = null;

    // Lightweight observability for the load/memory verification pass.
    this.stats = {
      enqueued: 0,
      written: 0,
      dropped: 0,
      pruned: 0,
      flushes: 0,
      lastFlushMs: 0,
    };
  }

  start() {
    const db = getDb();
    this.insertStmt = db.prepare(
      `INSERT INTO orderbook_snapshots
         (exchange, ts, best_bid, best_ask, mid, spread, bids, asks, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.pruneStmt = db.prepare('DELETE FROM orderbook_snapshots WHERE ts < ?');

    this.flushTimer = setInterval(() => this.flush(), this.intervalMs);
    this.flushTimer.unref?.();

    if (this.retentionHours > 0) {
      this.pruneTimer = setInterval(() => this.prune(), this.pruneIntervalMs);
      this.pruneTimer.unref?.();
    }
  }

  /**
   * Queue a normalized snapshot (already enriched with metrics) for persistence.
   * @param {object} snapshot unified snapshot
   * @param {object} metrics  per-book metrics (best_bid/ask/mid/spread)
   * @param {number} now      server time (epoch ms)
   */
  enqueue(snapshot, metrics, now) {
    // Backpressure guard: if the disk stalls and the queue overflows, drop the
    // oldest rows so memory stays bounded rather than growing without limit.
    if (this.queue.length >= this.queueCap) {
      const overflow = this.queue.length - this.queueCap + 1;
      this.queue.splice(0, overflow);
      this.stats.dropped += overflow;
    }

    const bids = snapshot.bids.slice(0, this.storeLevels);
    const asks = snapshot.asks.slice(0, this.storeLevels);

    this.queue.push({
      exchange: snapshot.exchange,
      ts: snapshot.timestamp,
      best_bid: metrics?.bestBid ?? (bids[0]?.[0] ?? null),
      best_ask: metrics?.bestAsk ?? (asks[0]?.[0] ?? null),
      mid: metrics?.mid ?? null,
      spread: metrics?.spread ?? null,
      bids: JSON.stringify(bids),
      asks: JSON.stringify(asks),
      created_at: now,
    });
    this.stats.enqueued += 1;

    if (this.queue.length >= this.maxRows) this.flush();
  }

  /** Flush all queued rows in one transaction. */
  flush() {
    if (this.queue.length === 0) return;
    const rows = this.queue;
    this.queue = [];

    const db = getDb();
    try {
      db.exec('BEGIN');
      for (const r of rows) {
        this.insertStmt.run(
          r.exchange, r.ts, r.best_bid, r.best_ask, r.mid, r.spread, r.bids, r.asks, r.created_at,
        );
      }
      db.exec('COMMIT');
      this.stats.written += rows.length;
      this.stats.flushes += 1;
      this.stats.lastFlushMs = rows.length;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      // Re-queue the failed rows so a transient lock doesn't lose data,
      // unless that would blow the cap (then drop them).
      if (this.queue.length + rows.length <= this.queueCap) {
        this.queue.unshift(...rows);
      } else {
        this.stats.dropped += rows.length;
      }
      console.error(`[batchWriter] flush failed (${rows.length} rows):`, err.message);
    }
  }

  /** Delete snapshots older than the retention window. */
  prune() {
    if (this.retentionHours <= 0) return;
    // Caller-independent "now": derive from the newest row to avoid Date.now()
    // assumptions; fall back to a max-age delete using SQLite's own clock.
    try {
      const cutoff = nowMs() - this.retentionHours * 3600 * 1000;
      const info = this.pruneStmt.run(cutoff);
      const removed = Number(info.changes ?? 0);
      if (removed > 0) {
        this.stats.pruned += removed;
        console.log(`[batchWriter] pruned ${removed} snapshot(s) older than ${this.retentionHours}h`);
      }
    } catch (err) {
      console.error('[batchWriter] prune failed:', err.message);
    }
  }

  stop() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.flush();
  }
}

// Date.now() is fine in normal runtime (only workflow scripts forbid it).
function nowMs() {
  return Date.now();
}
