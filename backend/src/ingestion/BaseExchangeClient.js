// Abstract WebSocket client with reconnect/backoff, heartbeat, and status
// tracking. Subclasses provide the URL, the subscribe handshake, and a parser
// that turns raw messages into unified snapshots.
//
// Events emitted:
//   'snapshot' -> (unifiedSnapshot)   a normalized orderbook update
//   'status'   -> ({ exchange, state, detail })   connection lifecycle
//
// state ∈ 'connecting' | 'open' | 'closed' | 'error' | 'simulated'
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class BaseExchangeClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.exchange   canonical name
   * @param {string} opts.url        websocket url
   * @param {number} [opts.heartbeatMs]  send a keepalive ping every N ms
   * @param {number} [opts.maxFailuresBeforeFallback] notify after this many
   *        consecutive failures (used to trigger the simulator fallback)
   */
  constructor({ exchange, url, heartbeatMs = 30000, maxFailuresBeforeFallback = 5 }) {
    super();
    this.exchange = exchange;
    this.url = url;
    this.heartbeatMs = heartbeatMs;
    this.maxFailuresBeforeFallback = maxFailuresBeforeFallback;

    this.ws = null;
    this.state = 'closed';
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.consecutiveFailures = 0;
    this.lastMessageAt = 0;
    this.messageCount = 0;

    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  // ── Overridable hooks ──────────────────────────────────────────────────
  /** Called once the socket opens — send subscription messages here. */
  onOpen() {}
  /** Parse a raw message into a unified snapshot, or null to ignore. */
  parseMessage(/* data */) {
    return null;
  }
  /** Build the keepalive frame; return null to use a protocol-level ping. */
  heartbeatFrame() {
    return null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────
  connect() {
    this.stopped = false;
    this._open();
  }

  _setState(state, detail) {
    this.state = state;
    this.emit('status', { exchange: this.exchange, state, detail });
  }

  _open() {
    if (this.stopped) return;
    this._setState('connecting');
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      this._onFailure(err.message);
      return;
    }

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.consecutiveFailures = 0;
      this.lastMessageAt = Date.now();
      this._setState('open');
      try {
        this.onOpen();
      } catch (err) {
        console.error(`[${this.exchange}] onOpen error:`, err.message);
      }
      this._startHeartbeat();
    });

    this.ws.on('message', (data) => {
      this.lastMessageAt = Date.now();
      let parsed;
      try {
        const raw = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
        parsed = this.parseMessage(raw);
      } catch (err) {
        // Non-JSON or unexpected frame — ignore quietly.
        return;
      }
      if (parsed) {
        this.messageCount += 1;
        this.emit('snapshot', parsed);
      }
    });

    this.ws.on('pong', () => {
      this.lastMessageAt = Date.now();
    });

    this.ws.on('error', (err) => {
      this._setState('error', err.message);
    });

    this.ws.on('close', () => {
      this._stopHeartbeat();
      if (!this.stopped) this._onFailure('socket closed');
    });
  }

  _onFailure(detail) {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures === this.maxFailuresBeforeFallback) {
      this.emit('fallback', { exchange: this.exchange, failures: this.consecutiveFailures });
    }
    this._scheduleReconnect(detail);
  }

  _scheduleReconnect(detail) {
    if (this.stopped) return;
    this._setState('closed', detail);
    this.reconnectAttempts += 1;
    // Exponential backoff 1s → 30s.
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempts - 1, 5));
    this.reconnectTimer = setTimeout(() => this._open(), delay);
    this.reconnectTimer.unref?.();
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const frame = this.heartbeatFrame();
      try {
        if (frame !== null && frame !== undefined) {
          this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
        } else {
          this.ws.ping();
        }
      } catch {
        /* ignore transient send errors */
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  getStatus() {
    return {
      exchange: this.exchange,
      state: this.state,
      messageCount: this.messageCount,
      lastMessageAt: this.lastMessageAt,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this._stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this._setState('closed', 'stopped');
  }
}
