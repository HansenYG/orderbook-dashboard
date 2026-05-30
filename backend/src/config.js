// Centralised configuration: reads environment (via dotenv) and exposes typed
// defaults used across the backend. Importing this module loads .env once.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Project root is backend/ (one level up from src/).
const backendRoot = path.resolve(__dirname, '..');

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

const dbPathRaw = process.env.DB_PATH || './data/orderbook.db';

const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const config = {
  port: num('PORT', 8080),
  corsOrigins,
  // '*' (anywhere in the list) reflects any Origin — convenient for a public demo.
  corsAllowAll: corsOrigins.includes('*'),

  // Ingestion
  useSimulator: bool('USE_SIMULATOR', false),
  bookLevels: num('BOOK_LEVELS', 20),

  // Storage backend selection: if MONGODB_URI is set we use MongoDB (durable
  // alerts + settings, snapshots kept in an in-memory ring buffer); otherwise
  // we fall back to the local SQLite file (full "store every update" history).
  mongoUri: process.env.MONGODB_URI || '',
  mongoDbName: process.env.MONGODB_DB || 'orderbook',
  // How many recent snapshots per exchange to keep in memory for /api/snapshots
  // when snapshots are not persisted to disk (MongoDB mode).
  recentBufferSize: num('RECENT_BUFFER_SIZE', 200),

  // Storage (SQLite mode)
  dbPath: path.isAbsolute(dbPathRaw) ? dbPathRaw : path.resolve(backendRoot, dbPathRaw),
  storeLevels: num('STORE_LEVELS', 20),
  batchMaxRows: num('BATCH_MAX_ROWS', 100),
  batchIntervalMs: num('BATCH_INTERVAL_MS', 1000),
  batchQueueCap: num('BATCH_QUEUE_CAP', 20000),
  retentionHours: num('RETENTION_HOURS', 24),
  pruneIntervalMs: num('PRUNE_INTERVAL_MS', 60000),

  // SSE
  sseTickMs: num('SSE_TICK_MS', 150),
  sseHeartbeatMs: num('SSE_HEARTBEAT_MS', 15000),

  // Alert defaults (seed values; live values live in the settings table)
  alertDefaults: {
    spreadBps: num('ALERT_SPREAD_BPS', 5),
    imbalance: num('ALERT_IMBALANCE', 0.6),
    discrepancyPct: num('ALERT_DISCREPANCY_PCT', 0.1),
    cooldownMs: num('ALERT_COOLDOWN_MS', 5000),
  },
};

// Canonical exchange identifiers used throughout the unified schema.
export const EXCHANGES = Object.freeze(['Binance', 'Hyperliquid']);
