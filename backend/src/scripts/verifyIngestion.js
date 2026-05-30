// Temporary verification: connect to both real exchanges, print the first few
// normalized snapshots from each, then exit. Confirms WS + Normalizer work.
import { BinanceClient } from '../ingestion/BinanceClient.js';
import { HyperliquidClient } from '../ingestion/HyperliquidClient.js';

const seen = { Binance: 0, Hyperliquid: 0 };
const MAX = 2;

function show(snap) {
  if (seen[snap.exchange] >= MAX) return;
  seen[snap.exchange] += 1;
  const top3 = (side) => side.slice(0, 3).map(([p, s]) => `${p}@${s}`).join('  ');
  console.log(
    `\n[${snap.exchange}] ts=${snap.timestamp} levels=${snap.bids.length}/${snap.asks.length}`,
  );
  console.log(`   bids: ${top3(snap.bids)}`);
  console.log(`   asks: ${top3(snap.asks)}`);
  if (seen.Binance >= MAX && seen.Hyperliquid >= MAX) {
    console.log('\n✅ Both exchanges normalized successfully. Exiting.');
    process.exit(0);
  }
}

const clients = [new BinanceClient(), new HyperliquidClient()];
for (const c of clients) {
  c.on('status', (s) => console.log(`[status] ${s.exchange}: ${s.state}${s.detail ? ' — ' + s.detail : ''}`));
  c.on('snapshot', show);
  c.connect();
}

setTimeout(() => {
  console.log(`\n⏱️  Timeout. Seen: Binance=${seen.Binance}, Hyperliquid=${seen.Hyperliquid}`);
  process.exit(seen.Binance > 0 && seen.Hyperliquid > 0 ? 0 : 1);
}, 15000);
