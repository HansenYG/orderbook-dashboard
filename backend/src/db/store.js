// Storage facade. Picks a backend based on configuration and exposes a single
// async interface to the rest of the app:
//
//   initStore()                       open the backend (call once at boot)
//   getStore()                        the live backend instance
//   closeStore()                      graceful shutdown
//   getSetting(key, fallback)         read a persisted JSON setting
//   setSetting(key, value)            upsert a persisted JSON setting
//   <store>.nextAlertId()             next monotonic alert id (sync)
//   <store>.saveAlert(alert)          persist an alert (async, fire-and-forget)
//   <store>.listAlerts({limit,since}) recent alerts, newest first
//   <store>.recordSnapshot(s,m,now)   record a snapshot (persist or buffer)
//   <store>.listSnapshots({...})      recent snapshots, newest first
//   <store>.stats()                   { written, dropped, pruned, queue, buffered }
//
// Backend selection: MONGODB_URI set → MongoDB (hosted), else SQLite (local).
import { config } from '../config.js';

let backend = null;

export async function initStore() {
  if (backend) return backend;
  if (config.mongoUri) {
    const { MongoBackend } = await import('./backends/mongo.js');
    backend = new MongoBackend();
  } else {
    const { SqliteBackend } = await import('./backends/sqlite.js');
    backend = new SqliteBackend();
  }
  await backend.init();
  return backend;
}

export function getStore() {
  if (!backend) throw new Error('Store not initialised — call initStore() first.');
  return backend;
}

export async function closeStore() {
  if (backend) {
    await backend.close();
    backend = null;
  }
}

// Convenience pass-throughs (used at boot and in route handlers).
export const getSetting = (key, fallback = null) => getStore().getSetting(key, fallback);
export const setSetting = (key, value) => getStore().setSetting(key, value);
