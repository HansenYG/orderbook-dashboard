// MongoDB storage backend (hosted mode).
//
// Selected when MONGODB_URI is set. Persists only the LOW-frequency, durable
// data — alerts and editable threshold settings — to MongoDB (Atlas free tier
// is comfortable with this). The high-frequency snapshot firehose is NOT stored
// in the cloud (it would be 1-2 GB/day); recent snapshots for /api/snapshots are
// kept in an in-memory ring buffer instead. The live dashboard is unaffected, as
// it streams from the in-memory SSE feed.
import { MongoClient } from 'mongodb';
import { config } from '../../config.js';
import * as ring from '../recentSnapshots.js';

export class MongoBackend {
  constructor(uri = config.mongoUri, dbName = config.mongoDbName) {
    this.name = 'mongo';
    this.persistsSnapshots = false;
    this.uri = uri;
    this.dbName = dbName;
    this.client = null;
    this.db = null;
    this.settings = null;
    this.alerts = null;
    this.alertSeq = 0;
  }

  async init() {
    this.client = new MongoClient(this.uri, {
      serverSelectionTimeoutMS: 10000,
      // Keep the pool small — this is a single long-lived process.
      maxPoolSize: 5,
    });
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.settings = this.db.collection('settings');
    this.alerts = this.db.collection('alerts');

    // Indexes (idempotent). Alerts are queried newest-first and by time window.
    await this.alerts.createIndex({ id: -1 });
    await this.alerts.createIndex({ ts: -1 });

    // Seed the alert id counter from the highest existing id.
    const last = await this.alerts.find({}).sort({ id: -1 }).limit(1).next();
    this.alertSeq = Number(last?.id ?? 0);

    // Confirm connectivity early with a ping (surfaces auth/URI errors at boot).
    await this.db.command({ ping: 1 });
  }

  async getSetting(key, fallback = null) {
    const doc = await this.settings.findOne({ _id: key });
    return doc ? doc.value : fallback;
  }

  async setSetting(key, value) {
    await this.settings.updateOne({ _id: key }, { $set: { value } }, { upsert: true });
  }

  nextAlertId() {
    return ++this.alertSeq;
  }

  async saveAlert(alert) {
    const doc = {
      id: alert.id,
      ts: alert.ts,
      type: alert.type,
      exchange: alert.exchange,
      severity: alert.severity,
      message: alert.message,
      value: alert.value ?? null,
      threshold: alert.threshold ?? null,
      payload: alert.payload ?? null,
    };
    await this.alerts.insertOne(doc);
    return alert;
  }

  async listAlerts({ limit = 100, since = null } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const query = since != null ? { ts: { $gte: Number(since) } } : {};
    const docs = await this.alerts
      .find(query, { projection: { _id: 0 } })
      .sort({ id: -1 })
      .limit(lim)
      .toArray();
    return docs;
  }

  recordSnapshot(snapshot, metrics, now) {
    const bids = snapshot.bids.slice(0, config.storeLevels);
    const asks = snapshot.asks.slice(0, config.storeLevels);
    ring.record({
      exchange: snapshot.exchange,
      ts: snapshot.timestamp,
      best_bid: metrics?.bestBid ?? bids[0]?.[0] ?? null,
      best_ask: metrics?.bestAsk ?? asks[0]?.[0] ?? null,
      mid: metrics?.mid ?? null,
      spread: metrics?.spread ?? null,
      bids,
      asks,
      created_at: now,
    });
  }

  async listSnapshots(opts) {
    return ring.list(opts);
  }

  stats() {
    return { written: 0, dropped: 0, pruned: 0, queue: 0, ...ring.getStats() };
  }

  async close() {
    if (this.client) await this.client.close();
  }
}
