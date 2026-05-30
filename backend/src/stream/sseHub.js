// Server-Sent Events hub.
//
// Holds the latest per-exchange book+metrics and cross-exchange metrics, and
// pushes them to all connected clients on a throttled interval (SSE_TICK_MS).
// This decouples the high-frequency ingestion (~10/s per exchange) from the UI
// render rate, keeping the browser smooth. Alerts bypass the throttle and are
// broadcast immediately.
import { config } from '../config.js';

export class SseHub {
  constructor({ tickMs = config.sseTickMs, heartbeatMs = config.sseHeartbeatMs } = {}) {
    this.tickMs = tickMs;
    this.heartbeatMs = heartbeatMs;
    /** @type {Map<number, import('http').ServerResponse>} */
    this.clients = new Map();
    this.nextId = 1;
    this.dirty = false;

    this.latest = {
      books: { Binance: null, Hyperliquid: null }, // { snapshot, metrics }
      cross: null,
      status: { Binance: { state: 'closed' }, Hyperliquid: { state: 'closed' } },
    };

    this.tickTimer = null;
    this.heartbeatTimer = null;
  }

  start() {
    this.tickTimer = setInterval(() => this._tick(), this.tickMs);
    this.tickTimer.unref?.();
    this.heartbeatTimer = setInterval(() => {
      for (const res of this.clients.values()) res.write(': ping\n\n');
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  // ── Client management ────────────────────────────────────────────────────
  addClient(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering (e.g. nginx)
    });
    res.write('retry: 3000\n\n'); // hint client reconnect delay
    res.flushHeaders?.();

    const id = this.nextId++;
    this.clients.set(id, res);

    // Send current state immediately so a fresh client isn't blank.
    this._send(res, 'init', this.getState());

    req.on('close', () => this.clients.delete(id));
    return id;
  }

  clientCount() {
    return this.clients.size;
  }

  // ── State updates (called by the ingestion orchestrator) ──────────────────
  updateBook(exchange, snapshot, metrics) {
    this.latest.books[exchange] = { snapshot, metrics };
    this.dirty = true;
  }

  updateCross(cross) {
    this.latest.cross = cross;
    this.dirty = true;
  }

  updateStatus(exchange, status) {
    this.latest.status[exchange] = status;
    // Status changes are infrequent and important — push right away.
    this.broadcast('status', { exchange, ...status });
  }

  getState() {
    return {
      books: this.latest.books,
      cross: this.latest.cross,
      status: this.latest.status,
      serverTime: Date.now(),
    };
  }

  // ── Broadcasting ──────────────────────────────────────────────────────────
  /** Throttled book/metrics tick — only emits when something changed. */
  _tick() {
    if (!this.dirty || this.clients.size === 0) return;
    this.dirty = false;
    const payload = {
      books: this.latest.books,
      cross: this.latest.cross,
      serverTime: Date.now(),
    };
    this.broadcast('tick', payload);
  }

  /** Immediate broadcast of an arbitrary event to all clients. */
  broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients.values()) {
      try {
        res.write(frame);
      } catch {
        /* a dead socket will be cleaned up by its 'close' handler */
      }
    }
  }

  _send(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  stop() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const res of this.clients.values()) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}
