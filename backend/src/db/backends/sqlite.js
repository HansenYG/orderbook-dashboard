// SQLite storage backend (local dev / single-host mode).
//
// Wraps the low-level node:sqlite layer (database.js) and the batched snapshot
// writer (batchWriter.js) behind the async store interface used by the app.
// This backend persists EVERYTHING — the full "store every update" snapshot
// history — bounded only by the retention window. It needs a writable local
// disk, so it is the default when no MONGODB_URI is configured.
import { initDb, getDb, getSetting, setSetting, closeDb } from '../database.js';
import { BatchWriter } from '../batchWriter.js';

export class SqliteBackend {
  constructor() {
    this.name = 'sqlite';
    this.persistsSnapshots = true;
    this.batch = null;
    this.alertSeq = 0;
  }

  async init() {
    initDb();
    this.batch = new BatchWriter();
    this.batch.start();
    // Seed the alert id counter from the table so ids stay monotonic across
    // restarts (we now assign ids ourselves for parity with the Mongo backend).
    const row = getDb().prepare('SELECT MAX(id) AS maxId FROM alerts').get();
    this.alertSeq = Number(row?.maxId ?? 0);
  }

  async getSetting(key, fallback = null) {
    return getSetting(key, fallback);
  }

  async setSetting(key, value) {
    setSetting(key, value);
  }

  nextAlertId() {
    return ++this.alertSeq;
  }

  async saveAlert(alert) {
    getDb()
      .prepare(
        `INSERT INTO alerts (id, ts, type, exchange, severity, message, value, threshold, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        alert.id,
        alert.ts,
        alert.type,
        alert.exchange,
        alert.severity,
        alert.message,
        alert.value ?? null,
        alert.threshold ?? null,
        alert.payload ? JSON.stringify(alert.payload) : null,
      );
    return alert;
  }

  async listAlerts({ limit = 100, since = null } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const db = getDb();
    let rows;
    if (since != null) {
      rows = db
        .prepare('SELECT * FROM alerts WHERE ts >= ? ORDER BY id DESC LIMIT ?')
        .all(Number(since), lim);
    } else {
      rows = db.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT ?').all(lim);
    }
    return rows.map((r) => ({ ...r, payload: r.payload ? safeParse(r.payload) : null }));
  }

  recordSnapshot(snapshot, metrics, now) {
    this.batch.enqueue(snapshot, metrics, now);
  }

  async listSnapshots({ exchange = null, limit = 20 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 500);
    const db = getDb();
    let rows;
    if (exchange) {
      rows = db
        .prepare('SELECT * FROM orderbook_snapshots WHERE exchange = ? ORDER BY id DESC LIMIT ?')
        .all(exchange, lim);
    } else {
      rows = db.prepare('SELECT * FROM orderbook_snapshots ORDER BY id DESC LIMIT ?').all(lim);
    }
    return rows.map((r) => ({
      id: r.id,
      exchange: r.exchange,
      ts: r.ts,
      best_bid: r.best_bid,
      best_ask: r.best_ask,
      mid: r.mid,
      spread: r.spread,
      bids: safeParse(r.bids),
      asks: safeParse(r.asks),
    }));
  }

  stats() {
    const s = this.batch?.stats ?? {};
    return {
      written: s.written ?? 0,
      dropped: s.dropped ?? 0,
      pruned: s.pruned ?? 0,
      queue: this.batch?.queue.length ?? 0,
      buffered: 0,
    };
  }

  async close() {
    this.batch?.stop();
    closeDb();
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return Array.isArray(s) ? s : null;
  }
}
