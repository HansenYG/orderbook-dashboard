# BTC Perp Orderbook Dashboard — Binance × Hyperliquid

Real-time ingestion, normalization, storage, and alerting for **BTC perpetual** orderbook
data from **Binance Futures** and **Hyperliquid**, with a live React dashboard.

- **Ingestion** — async WebSocket clients with reconnect/backoff and heartbeats.
- **Normalization** — both feeds mapped to one unified schema.
- **Storage** — SQLite (WAL) via the built-in `node:sqlite`, batched writes, retention pruning.
- **Alerts** — a rule engine for spread, top-5 imbalance, and cross-exchange price discrepancy.
- **Streaming** — Server-Sent Events push normalized books, metrics, and alerts to the UI.
- **Dashboard** — split depth view, metrics panel, alerts center (live toasts + history + editable thresholds).
- **AI assistant** — an in-dashboard chatbot (Claude) that reads the live data and suggests a market read, a short-term buy/sell lean, or flags anomalies.
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
| `ANTHROPIC_API_KEY` | _(empty)_ | Set to enable the AI assistant. Empty = chat disabled (the UI shows a notice and `/api/chat` returns 503) |
| `ANTHROPIC_MODEL` | `claude-opus-4-8` | Model used for the assistant |
| `CHAT_MAX_TOKENS` / `CHAT_HISTORY_LIMIT` | `3000` / `20` | Max tokens per reply / prior turns sent for context |

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
| POST | `/api/chat` | **AI assistant** — streams a plain-text reply. Body: `{ messages: [{ role, content }] }`. 503 if no API key |

## Alerts

- **Spread** — per-exchange `spreadBps` exceeds threshold.
- **Imbalance** — top-5 `(bidVol − askVol)/(bidVol + askVol)` exceeds `±threshold`.
- **Discrepancy** — Binance vs Hyperliquid mid diverges beyond `threshold %`.

Severity escalates with overage (`info` → `warning` ≥1.5× → `critical` ≥2×). A
per-`(type, exchange)` cooldown prevents flooding. Triggered alerts are saved to the
`alerts` table and pushed instantly over SSE (toast + history).

## AI assistant

A chat panel in the dashboard answers questions about the live market. On every
turn the backend builds a compact snapshot of **exactly what's on screen** — both
venues' top-of-book pricing, top-5 imbalance and depth, cross-exchange discrepancy
and arbitrage gap, a short mid-price trend, and recent alerts — and hands it to
Claude alongside the conversation. It can summarize the market situation, give a
short-term buy/sell lean, or flag anomalies (wide spreads, extreme imbalance,
stale feeds, standing arbitrage). Replies stream token-by-token over `POST /api/chat`.

- **Enable it** by setting `ANTHROPIC_API_KEY` in `backend/.env` (get a key at
  [console.anthropic.com](https://console.anthropic.com/)). Without a key the panel
  shows a "not configured" notice and the endpoint returns 503 — everything else
  works unchanged.
- The model only ever sees the normalized top-5 data the dashboard already shows;
  it's instructed to ground every claim in those numbers and to label buy/sell
  leans as *not financial advice*. The stable system prompt is prompt-cached to
  keep cost down.

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
