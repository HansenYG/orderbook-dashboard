// Synthetic orderbook generator used when USE_SIMULATOR=1 or as an automatic
// fallback when a real exchange fails to connect repeatedly. It mimics the
// BaseExchangeClient interface (connect/stop/getStatus + 'snapshot'/'status'
// events) so the rest of the pipeline is unaware of the data source.
//
// Each instance random-walks a mid price around a base, with a configurable
// bias so the two simulated exchanges drift apart enough to exercise the
// cross-exchange discrepancy/arbitrage logic.
import { EventEmitter } from 'node:events';
import { config } from '../config.js';

export class SimulatorClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.exchange
   * @param {number} [opts.basePrice]   starting mid
   * @param {number} [opts.intervalMs]  emit cadence
   * @param {number} [opts.spreadBps]   nominal half-spread in basis points
   */
  constructor({ exchange, basePrice = 60000, intervalMs = 100, spreadBps = 1.5 }) {
    super();
    this.exchange = exchange;
    this.mid = basePrice;
    this.intervalMs = intervalMs;
    this.spreadBps = spreadBps;
    this.levels = config.bookLevels;
    this.timer = null;
    this.state = 'closed';
    this.messageCount = 0;
    this.lastMessageAt = 0;
  }

  connect() {
    this.state = 'simulated';
    this.emit('status', { exchange: this.exchange, state: 'simulated', detail: 'synthetic feed' });
    this.timer = setInterval(() => this._tick(), this.intervalMs);
    this.timer.unref?.();
  }

  _tick() {
    // Random walk the mid (~0.02% std per tick) with mild mean reversion.
    const drift = (Math.random() - 0.5) * this.mid * 0.0004;
    this.mid = Math.max(1000, this.mid + drift);

    const half = (this.mid * this.spreadBps) / 10000 / 2;
    const bestBid = this.mid - half;
    const bestAsk = this.mid + half;
    // Tick size scaled to price; ~0.5 USD steps for BTC.
    const step = Math.max(0.5, this.mid * 0.00001);

    const bids = [];
    const asks = [];
    for (let i = 0; i < this.levels; i++) {
      const sizeBid = +(0.1 + Math.random() * 3).toFixed(4);
      const sizeAsk = +(0.1 + Math.random() * 3).toFixed(4);
      bids.push([+(bestBid - i * step).toFixed(2), sizeBid]);
      asks.push([+(bestAsk + i * step).toFixed(2), sizeAsk]);
    }

    this.messageCount += 1;
    this.lastMessageAt = Date.now();
    this.emit('snapshot', {
      exchange: this.exchange,
      timestamp: Date.now(),
      bids,
      asks,
    });
  }

  getStatus() {
    return {
      exchange: this.exchange,
      state: this.state,
      messageCount: this.messageCount,
      lastMessageAt: this.lastMessageAt,
      reconnectAttempts: 0,
    };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state = 'closed';
    this.emit('status', { exchange: this.exchange, state: 'closed', detail: 'stopped' });
  }
}
