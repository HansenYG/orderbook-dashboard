// Quick DB inspector: prints row counts, per-exchange coverage, time span,
// and the most recent rows. Used to verify persistence during development.
//   npm run db:stats
import { config } from '../config.js';
import { initDb, getDb, closeDb } from '../db/database.js';

function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toISOString();
}

// This inspector reads the local SQLite database directly. In hosted (MongoDB)
// mode there is no local snapshot history — inspect the data in MongoDB Atlas.
if (config.mongoUri) {
  console.log('MONGODB_URI is set — this app is using the MongoDB backend.');
  console.log('db:stats only inspects the local SQLite file; use the Atlas UI for hosted data.');
  process.exit(0);
}

initDb();
const db = getDb();

const total = db.prepare('SELECT COUNT(*) AS n FROM orderbook_snapshots').get().n;
console.log(`\n=== orderbook_snapshots ===`);
console.log(`total rows: ${total}`);

const perEx = db
  .prepare(
    `SELECT exchange,
            COUNT(*) AS n,
            MIN(ts) AS first_ts,
            MAX(ts) AS last_ts
       FROM orderbook_snapshots
      GROUP BY exchange
      ORDER BY exchange`,
  )
  .all();

for (const r of perEx) {
  const spanSec = r.last_ts && r.first_ts ? ((r.last_ts - r.first_ts) / 1000).toFixed(1) : '0';
  console.log(
    `  ${r.exchange.padEnd(12)} rows=${String(r.n).padStart(8)}  span=${spanSec}s  ` +
      `latest=${fmtTime(r.last_ts)}`,
  );
}

console.log(`\n=== latest snapshots ===`);
const latest = db
  .prepare(
    `SELECT exchange, ts, best_bid, best_ask, mid, spread
       FROM orderbook_snapshots
      ORDER BY id DESC
      LIMIT 6`,
  )
  .all();
for (const r of latest) {
  console.log(
    `  ${r.exchange.padEnd(12)} ${fmtTime(r.ts)}  bid=${r.best_bid}  ask=${r.best_ask}  ` +
      `mid=${r.mid}  spread=${r.spread}`,
  );
}

const alerts = db.prepare('SELECT COUNT(*) AS n FROM alerts').get().n;
console.log(`\n=== alerts ===\ntotal: ${alerts}`);
const recentAlerts = db
  .prepare('SELECT ts, type, exchange, severity, message FROM alerts ORDER BY id DESC LIMIT 5')
  .all();
for (const a of recentAlerts) {
  console.log(`  [${a.severity}] ${a.type}/${a.exchange} @ ${fmtTime(a.ts)} — ${a.message}`);
}

console.log('');
closeDb();
