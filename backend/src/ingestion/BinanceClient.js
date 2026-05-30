// Binance USD-M Futures partial book depth stream for BTCUSDT.
// Stream: btcusdt@depth20@100ms  → top-20 levels, refreshed every 100ms.
import { BaseExchangeClient } from './BaseExchangeClient.js';
import { Normalizer } from '../normalize/Normalizer.js';

const BINANCE_FUTURES_WS = 'wss://fstream.binance.com/ws/btcusdt@depth20@100ms';

export class BinanceClient extends BaseExchangeClient {
  constructor() {
    super({ exchange: 'Binance', url: BINANCE_FUTURES_WS, heartbeatMs: 30000 });
  }

  // Binance pushes the partial book automatically once subscribed via the URL,
  // so there is no subscribe message to send.
  onOpen() {}

  // Binance Futures expects an unsolicited pong frame periodically; the `ws`
  // library also auto-responds to server pings, so a protocol ping suffices.
  heartbeatFrame() {
    return null; // use ws.ping()
  }

  parseMessage(raw) {
    return Normalizer.normalizeBinance(raw);
  }
}
