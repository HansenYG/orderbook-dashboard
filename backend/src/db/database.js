// SQLite layer built on Node's built-in `node:sqlite` (DatabaseSync).
// Configures WAL for high-frequency writes and defines the schema.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

let db = null;

/**
 * Open (or create) the database, apply performance pragmas, and ensure the
 * schema exists. Safe to call once at boot.
 * @returns {DatabaseSync}
 */
export function initDb() {
  if (db) return db;

  // Ensure the parent data/ directory exists.
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

  db = new DatabaseSync(config.dbPath);

  // Pragmas tuned for sustained high-frequency inserts.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA cache_size = -8000;     -- ~8 MB page cache
    PRAGMA temp_store = MEMORY;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS orderbook_snapshots (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange  TEXT    NOT NULL,
      ts        INTEGER NOT NULL,      -- exchange event time (epoch ms)
      best_bid  REAL,
      best_ask  REAL,
      mid       REAL,
      spread    REAL,
      bids      TEXT    NOT NULL,      -- JSON: [[price, size], ...]
      asks      TEXT    NOT NULL,      -- JSON: [[price, size], ...]
      created_at INTEGER NOT NULL      -- server insert time (epoch ms)
    );

    CREATE INDEX IF NOT EXISTS idx_snap_exchange_ts
      ON orderbook_snapshots (exchange, ts);
    CREATE INDEX IF NOT EXISTS idx_snap_ts
      ON orderbook_snapshots (ts);

    CREATE TABLE IF NOT EXISTS alerts (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        INTEGER NOT NULL,      -- epoch ms when raised
      type      TEXT    NOT NULL,      -- 'spread' | 'imbalance' | 'discrepancy'
      exchange  TEXT    NOT NULL,      -- exchange name or 'cross'
      severity  TEXT    NOT NULL,      -- 'info' | 'warning' | 'critical'
      message   TEXT    NOT NULL,
      value     REAL,
      threshold REAL,
      payload   TEXT                   -- JSON: extra detail
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts (ts);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL              -- JSON-encoded value
    );
  `);

  return db;
}

/** @returns {DatabaseSync} the open database (throws if not initialised). */
export function getDb() {
  if (!db) throw new Error('Database not initialised — call initDb() first.');
  return db;
}

/** Read a JSON setting, or return `fallback` if the key is missing. */
export function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

/** Upsert a JSON setting. */
export function setSetting(key, value) {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(value));
}

/** Close the database (used on graceful shutdown). */
export function closeDb() {
  if (db) {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      /* ignore checkpoint errors on shutdown */
    }
    db.close();
    db = null;
  }
}
