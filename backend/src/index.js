// Entry point: initialise DB → build pipeline → start ingestion → start HTTP.
//
// Pipeline per snapshot:
//   normalized snapshot
//     ├─ computeBookMetrics            (spread, mid, imbalance)
//     ├─ store.recordSnapshot          (persist to SQLite / buffer in MongoDB mode)
//     ├─ sseHub.updateBook             (throttled push to UI)
//     ├─ computeCrossMetrics           (Binance vs Hyperliquid)
//     └─ ruleEngine.evaluate → store.saveAlert + sseHub.broadcast('alert')
import http from 'node:http';
import { config } from './config.js';
import { initStore, getStore, closeStore } from './db/store.js';
import { BinanceClient } from './ingestion/BinanceClient.js';
import { HyperliquidClient } from './ingestion/HyperliquidClient.js';
import { SimulatorClient } from './ingestion/SimulatorClient.js';
import { Normalizer } from './normalize/Normalizer.js'; // (referenced indirectly by clients)
import { computeBookMetrics, computeCrossMetrics } from './metrics/metrics.js';
import { RuleEngine } from './alerts/RuleEngine.js';
import { SseHub } from './stream/sseHub.js';
import { createApp } from './server.js';

void Normalizer; // keep import for clarity of the data path

// ── 1. Storage ──────────────────────────────────────────────────────────────
// Backend is chosen by config: MongoDB (hosted) if MONGODB_URI is set, else
// the local SQLite file. Top-level await is fine in this ESM entry point.
const store = await initStore();

// Seed or load persisted alert thresholds.
let thresholds = await store.getSetting('alertThresholds', null);
if (!thresholds) {
  thresholds = { ...config.alertDefaults };
  await store.setSetting('alertThresholds', thresholds);
} else {
  thresholds = { ...config.alertDefaults, ...thresholds };
}

const ruleEngine = new RuleEngine(thresholds);

const sseHub = new SseHub();
sseHub.start();

// ── 2. Ingestion orchestration ────────────────────────────────────────────
const latestMetrics = { Binance: null, Hyperliquid: null };
const clients = new Map(); // exchange -> client instance
const verifyLog = { Binance: 0, Hyperliquid: 0 }; // log first few normalized books

function handleSnapshot(snapshot) {
  const now = Date.now();
  const exchange = snapshot.exchange;

  const bookMetrics = computeBookMetrics(snapshot, 5);
  latestMetrics[exchange] = bookMetrics;

  // Verification logging (first 2 normalized snapshots per exchange).
  if (verifyLog[exchange] < 2) {
    verifyLog[exchange] += 1;
    console.log(
      `[normalize] ${exchange} mid=${fmt(bookMetrics.mid)} spread=${fmt(bookMetrics.spread)} ` +
        `imbalance=${fmt(bookMetrics.imbalance)} levels=${snapshot.bids.length}/${snapshot.asks.length}`,
    );
  }

  // Persist/record (every update) + push to UI (throttled). recordSnapshot is
  // synchronous and non-blocking: SQLite batches to disk, Mongo buffers in memory.
  store.recordSnapshot(snapshot, bookMetrics, now);
  sseHub.updateBook(exchange, snapshot, bookMetrics);

  // Cross-exchange metrics + discrepancy evaluation.
  const cross = computeCrossMetrics(latestMetrics.Binance, latestMetrics.Hyperliquid);
  sseHub.updateCross(cross);

  // Alerts. Assign the id synchronously so we can broadcast instantly, then
  // persist in the background (alerts are low-frequency, gated by cooldowns).
  const alerts = ruleEngine.evaluate({ exchange, bookMetrics, crossMetrics: cross, now });
  for (const alert of alerts) {
    const saved = { ...alert, id: store.nextAlertId() };
    sseHub.broadcast('alert', saved);
    console.log(`[ALERT] ${saved.severity.toUpperCase()} ${saved.type}/${saved.exchange}: ${saved.message}`);
    store.saveAlert(saved).catch((err) => console.error('[alert persist] failed:', err.message));
  }
}

function attach(client) {
  client.on('snapshot', handleSnapshot);
  client.on('status', (s) => {
    sseHub.updateStatus(s.exchange, { state: s.state, detail: s.detail, lastUpdate: Date.now() });
    console.log(`[status] ${s.exchange}: ${s.state}${s.detail ? ' — ' + s.detail : ''}`);
  });
  client.on?.('fallback', ({ exchange }) => {
    console.warn(`[fallback] ${exchange} unreachable — switching to simulator`);
    swapToSimulator(exchange);
  });
  clients.set(client.exchange, client);
  client.connect();
}

function swapToSimulator(exchange) {
  const old = clients.get(exchange);
  if (old) old.stop();
  const basePrice = exchange === 'Hyperliquid' ? 59980 : 60000; // slight offset → discrepancy
  const sim = new SimulatorClient({ exchange, basePrice });
  attach(sim);
}

function startIngestion() {
  if (config.useSimulator) {
    console.log('🧪 USE_SIMULATOR=1 — starting synthetic feeds.');
    attach(new SimulatorClient({ exchange: 'Binance', basePrice: 60000 }));
    attach(new SimulatorClient({ exchange: 'Hyperliquid', basePrice: 59980 }));
  } else {
    attach(new BinanceClient());
    attach(new HyperliquidClient('BTC'));
  }
}

function getStatuses() {
  return [...clients.values()].map((c) => c.getStatus());
}

startIngestion();

// ── 3. HTTP server ──────────────────────────────────────────────────────────
const app = createApp({ ruleEngine, sseHub, getStatuses, store });
const server = http.createServer(app);
server.listen(config.port, () => {
  const target = store.name === 'mongo' ? `MongoDB (${config.mongoDbName})` : config.dbPath;
  console.log(`\n🚀 Backend listening on http://localhost:${config.port}`);
  console.log(`   SSE stream:  http://localhost:${config.port}/api/stream`);
  console.log(`   Storage:     ${store.name} → ${target}`);
  console.log(`   Thresholds:  ${JSON.stringify(ruleEngine.getThresholds())}\n`);
});

// ── 4. Observability: periodic memory/queue stats ─────────────────────────────
const monitor = setInterval(() => {
  const mem = process.memoryUsage();
  const s = store.stats();
  console.log(
    `[monitor] rss=${mb(mem.rss)}MB heap=${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB ` +
      `queue=${s.queue} buffered=${s.buffered} written=${s.written} pruned=${s.pruned} ` +
      `dropped=${s.dropped} sseClients=${sseHub.clientCount()}`,
  );
}, 30000);
monitor.unref?.();

// ── 5. Graceful shutdown ──────────────────────────────────────────────────────
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — shutting down…`);
  clearInterval(monitor);
  for (const c of clients.values()) c.stop();
  sseHub.stop();
  server.close(async () => {
    await closeStore();
    console.log('Clean shutdown complete.');
    process.exit(0);
  });
  // Force-exit safety net.
  setTimeout(() => process.exit(0), 3000).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function fmt(n) {
  return n == null ? 'n/a' : Number(n).toFixed(2);
}
function mb(bytes) {
  return Math.round(bytes / 1048576);
}
