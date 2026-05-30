# BTC Perp Orderbook Dashboard — Binance × Hyperliquid

Real-time ingestion, normalization, storage, and alerting for **BTC perpetual** orderbook
data from **Binance Futures** and **Hyperliquid**, with a live React dashboard.

- **Ingestion** — async WebSocket clients with reconnect/backoff and heartbeats.
- **Normalization** — both feeds mapped to one unified schema.
- **Storage** — SQLite (WAL) via the built-in `node:sqlite`, batched writes, retention pruning.
- **Alerts** — a rule engine for spread, top-5 imbalance, and cross-exchange price discrepancy.
- **Streaming** — Server-Sent Events push normalized books, metrics, and alerts to the UI.
- **Dashboard** — split depth view, metrics panel, alerts center (live toasts + history + editable thresholds).
- **Offline mode** — a built-in simulator so the whole app runs with no network.

```
┌────────────┐  ws   ┌──────────────┐   ┌────────────┐  SSE  ┌──────────────┐
│  Binance   │──────▶│              │──▶│ batchWriter│       │              │
│ Futures WS │       │  Normalizer  │   │  → SQLite  │       │   React UV   │
├────────────┤  ws   │  + Metrics   │──▶│  (WAL)     │       │  dashboard   │
│Hyperliquid │──────▶│  + RuleEngine│   └────────────┘       │              │
│   l2Book   │       │              │──────── tick/alert ───▶│ EventSource  │
└────────────┘       └──────────────┘        (sseHub)        └──────────────┘
```

## Prerequisites

- **Node.js ≥ 22.5** (uses the built-in `node:sqlite`; verified on v22.17).
- npm. No native build tools or external database required.

## Quick start

Open two terminals.

**1. Backend** (port 8080):

```bash
cd backend
npm install
cp .env.example .env     # optional — sensible defaults are baked in
npm run dev              # auto-restart on changes  (or: npm start)
```

You should see both exchanges connect and `[normalize]` sample lines, then:
`🚀 Backend listening on http://localhost:8080`.

**2. Frontend** (port 5173):

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**. The Vite dev server proxies `/api` (including the SSE
stream) to the backend, so no CORS setup is needed.

### Production build (single server)

```bash
cd frontend && npm run build      # emits frontend/dist
cd ../backend && npm start         # backend serves dist/ as the SPA at :8080
```

## Deploying to the web

The app is deploy-ready: **frontend → Vercel**, **backend → Render**,
**database → MongoDB Atlas**. The storage layer auto-selects its backend —
**`MONGODB_URI` set → MongoDB** (durable alerts + settings; recent snapshots in
an in-memory ring buffer, since the full firehose is ~1–2 GB/day), **unset →
local SQLite** (full history on disk, the default for development). The frontend
uses `VITE_API_BASE` to reach the backend cross-origin (relative via the Vite
proxy in dev). See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the full step-by-step,
plus `render.yaml`, `frontend/vercel.json`, and the `.env.example` files.

## Configuration (`backend/.env`)

All values have defaults — see `backend/.env.example` for the full list. Highlights:

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Backend HTTP port |
| `USE_SIMULATOR` | `0` | `1` = synthetic feeds (offline). Also auto-engages per-exchange after repeated connect failures |
| `BOOK_LEVELS` / `STORE_LEVELS` | `20` | Levels kept in-memory / persisted per side |
| `BATCH_MAX_ROWS` / `BATCH_INTERVAL_MS` | `100` / `1000` | Flush when N rows queued **or** every N ms |
| `RETENTION_HOURS` | `24` | Snapshots older than this are pruned. **This bounds disk** — at ~10–25 updates/s the DB can grow ~1–2 GB/day, so lower it if needed |
| `SSE_TICK_MS` | `150` | UI push cadence (decoupled from ingestion rate for smoothness) |
| `ALERT_SPREAD_BPS` / `ALERT_IMBALANCE` / `ALERT_DISCREPANCY_PCT` | `5` / `0.6` / `0.1` | Seed alert thresholds (live values are editable in the UI and persisted in the DB) |

## Unified schema

```js
{
  exchange: "Binance" | "Hyperliquid",
  timestamp: <epoch ms>,
  bids: [[price, size], ...],   // sorted desc, top N
  asks: [[price, size], ...]    // sorted asc,  top N
}
```

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Liveness + uptime |
| GET | `/api/status` | Per-exchange connection state, SSE client count |
| GET | `/api/config` | Current alert thresholds |
| PUT | `/api/config` | Update thresholds (validated, persisted, hot-applied) |
| GET | `/api/alerts?limit=&since=` | Alert history (newest first) |
| GET | `/api/snapshots?exchange=&limit=` | Recent stored snapshots (full books) |
| GET | `/api/stream` | **SSE**: `init`, `tick`, `alert`, `alerts`, `status` events |

## Alerts

- **Spread** — per-exchange `spreadBps` exceeds threshold.
- **Imbalance** — top-5 `(bidVol − askVol)/(bidVol + askVol)` exceeds `±threshold`.
- **Discrepancy** — Binance vs Hyperliquid mid diverges beyond `threshold %`.

Severity escalates with overage (`info` → `warning` ≥1.5× → `critical` ≥2×). A
per-`(type, exchange)` cooldown prevents flooding. Triggered alerts are saved to the
`alerts` table and pushed instantly over SSE (toast + history).

## Storage

Tables: `orderbook_snapshots` (indexed on `(exchange, ts)`), `alerts` (indexed on `ts`),
`settings` (persisted thresholds). WAL mode + `synchronous=NORMAL` for high write throughput.
Inspect the DB anytime:

```bash
cd backend && npm run db:stats
```

## Verifying / dev tools

- `backend/src/scripts/verifyIngestion.js` — connects to both real exchanges and prints
  the first normalized snapshots, then exits. Run:
  `node --disable-warning=ExperimentalWarning src/scripts/verifyIngestion.js`
- `npm run db:stats` — row counts, per-exchange coverage, latest rows, recent alerts.
- The backend logs a `[monitor]` line every 30s (RSS/heap, write queue, rows written,
  pruned, dropped, SSE clients) for load/memory observation.

## Offline / demo mode

```bash
cd backend && USE_SIMULATOR=1 npm start    # PowerShell: $env:USE_SIMULATOR=1; npm start
```

Both exchanges report `simulated` and the full pipeline (storage, metrics, alerts,
streaming, UI) works with no network. Useful for demos or if Binance is geo-blocked.

## Notes

- `node:sqlite` is an experimental Node API; scripts run with
  `--disable-warning=ExperimentalWarning` to silence the notice.
- Ingestion (every update) and the UI push rate (`SSE_TICK_MS`) are intentionally
  decoupled: the DB captures full fidelity while the browser receives a smooth, coalesced
  ~6–7 fps stream.
