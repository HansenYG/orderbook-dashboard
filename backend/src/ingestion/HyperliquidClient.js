// Hyperliquid L2 orderbook stream for BTC.
// Connect to wss://api.hyperliquid.xyz/ws and subscribe to the l2Book channel.
import { BaseExchangeClient } from './BaseExchangeClient.js';
import { Normalizer } from '../normalize/Normalizer.js';

const HYPERLIQUID_WS = 'wss://api.hyperliquid.xyz/ws';

export class HyperliquidClient extends BaseExchangeClient {
  constructor(coin = 'BTC') {
    super({ exchange: 'Hyperliquid', url: HYPERLIQUID_WS, heartbeatMs: 30000 });
    this.coin = coin;
  }

  onOpen() {
    // Subscribe to the BTC L2 book.
    this.ws.send(
      JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'l2Book', coin: this.coin },
      }),
    );
  }

  // Hyperliquid keepalive is an application-level ping that yields a pong.
  heartbeatFrame() {
    return { method: 'ping' };
  }

  parseMessage(raw) {
    // Ignore subscription acks / pong frames; only l2Book carries book data.
    if (raw?.channel && raw.channel !== 'l2Book') return null;
    return Normalizer.normalizeHyperliquid(raw);
  }
}
