# Deploying the Orderbook Dashboard

This guide takes the app from local-only to live on the web:

```
  Browser ──HTTPS──▶  Vercel (static React build)
                         │  fetch + EventSource (SSE)  → VITE_API_BASE
                         ▼
                      Render (Node web service: WS ingest, SSE, REST)
                         │  alerts + settings (durable)
                         ▼
                      MongoDB Atlas (free M0)
```

- **Frontend → Vercel.** Static Vite build; perfect for a CDN.
- **Backend → Render.** A *persistent* Node web service (it holds open exchange
  WebSockets and streams SSE) — this cannot be serverless.
- **Database → MongoDB Atlas.** Stores only the low-frequency, durable data:
  alerts and editable thresholds. The high-frequency snapshot firehose
  (~1–2 GB/day) is **not** sent to the cloud — recent snapshots live in an
  in-memory ring buffer, which is all `/api/snapshots` needs. The live dashboard
  streams from memory and is unaffected.

> The code auto-selects its storage backend: **`MONGODB_URI` set → MongoDB**
> (hosted), **unset → local SQLite file** (development). Nothing else changes.

## Prerequisites (free accounts)

- [GitHub](https://github.com) — Render and Vercel deploy from a Git repo.
- [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register)
- [Render](https://render.com)
- [Vercel](https://vercel.com)

The repo is already initialised locally with a first commit (see the last
section if you need to redo it).

---

## Step 1 — MongoDB Atlas (database)

1. Create a free **M0** cluster (any cloud/region).
2. **Database Access** → *Add New Database User* → username + password
   (Atlas-managed password is fine). Give it **Read and write to any database**.
3. **Network Access** → *Add IP Address* → **Allow access from anywhere**
   (`0.0.0.0/0`). Render's outbound IP isn't static on the free plan, so this is
   the simplest option for a demo.
4. **Connect** → *Drivers* → copy the connection string. It looks like:
   ```
   mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
   Replace `USER`/`PASSWORD` with the credentials from step 2. Keep this for
   Step 3 — it is `MONGODB_URI`. (The database name defaults to `orderbook`.)

---

## Step 2 — Push to GitHub

Create an **empty** repo on GitHub (no README/license), then from
`C:\Users\Hansen\orderbook-dashboard`:

```powershell
git remote add origin https://github.com/<you>/orderbook-dashboard.git
git branch -M main
git push -u origin main
```

---

## Step 3 — Backend on Render

The repo includes `render.yaml`, so Render can configure the service for you.

**Option A — Blueprint (recommended):**
1. Render dashboard → **New** → **Blueprint** → connect the GitHub repo.
2. Render reads `render.yaml` and proposes the `orderbook-backend` web service.
3. When prompted for the `sync: false` secrets, set:
   - **`MONGODB_URI`** = the Atlas string from Step 1.
   - **`CORS_ORIGIN`** = `*` for now (we'll lock it to the Vercel URL in Step 5).
   - **`ANTHROPIC_API_KEY`** = _(optional)_ your Anthropic key to enable the AI
     assistant. Leave blank to ship without the chatbot.
4. **Apply** / **Create**. First build runs `npm ci` then `npm start`.

**Option B — Manual:** New → **Web Service** → pick the repo →
Root Directory `backend`, Build `npm ci`, Start `npm start`, Health Check Path
`/api/health`, then add the same env vars (`MONGODB_URI`, `MONGODB_DB=orderbook`,
`CORS_ORIGIN=*`, `RECENT_BUFFER_SIZE=200`, `NODE_VERSION=22.17.0`).

When live, note the URL, e.g. `https://orderbook-backend.onrender.com`.
Verify: open `https://<backend>/api/health` → `{"ok":true,...}` and
`https://<backend>/api/status` → should show `"storage":"mongo"`.

> **Binance geo-blocking:** Binance Futures is unreachable from US IPs. Render's
> default region is US (Oregon). If Binance won't connect, the backend
> auto-falls back to its simulator **for that exchange only** (Hyperliquid keeps
> streaming live). To get real Binance data, create the service in **Frankfurt**
> or **Singapore**. For a guaranteed-working demo regardless of region, set
> `USE_SIMULATOR=1`.

---

## Step 4 — Frontend on Vercel

1. Vercel dashboard → **Add New** → **Project** → import the GitHub repo.
2. **Root Directory** → set to **`frontend`**. Vercel detects Vite automatically
   (`vercel.json` pins build = `npm run build`, output = `dist`, with SPA
   rewrites).
3. **Environment Variables** → add:
   - **`VITE_API_BASE`** = your Render backend URL from Step 3
     (e.g. `https://orderbook-backend.onrender.com`, **no trailing slash**).
4. **Deploy.** Note the URL, e.g. `https://orderbook-dashboard.vercel.app`.

> `VITE_*` vars are inlined at **build time**, so if you change `VITE_API_BASE`
> later you must **redeploy** the frontend.

---

## Step 5 — Lock CORS to your frontend

Back in **Render → orderbook-backend → Environment**, set:

```
CORS_ORIGIN = https://orderbook-dashboard.vercel.app
```

(comma-separate if you have multiple domains; `*` allows any). Save — Render
redeploys. This restricts the API/SSE to your real frontend instead of `*`.

---

## Verify the live app

1. Open the Vercel URL. The header should show **Stream live** and the exchange
   pills should go **open** (or **simulated**).
2. Books, depth chart, and metrics update in real time.
3. In **Thresholds**, lower e.g. *Spread alert* — alerts should fire as toasts
   and appear in **History**. Reload the page: history persists (it's in MongoDB).
4. In Atlas → **Collections**, the `orderbook` DB has `alerts` and `settings`.

---

## Notes, limits & costs

- **Free Render spins down** after ~15 min of no traffic; the next visit triggers
  a ~30–60s cold start and ingestion resumes. An open dashboard tab counts as
  traffic and keeps it awake. For always-on, upgrade the plan or use the
  keep-alive options below.
- **No snapshot history in the cloud** by design (see top). `/api/snapshots`
  returns the in-memory ring buffer (last `RECENT_BUFFER_SIZE` per exchange),
  which resets on restart. Run the app locally (SQLite mode) if you want the full
  persisted history and `npm run db:stats`.
- **Atlas free tier = 512 MB.** Alerts + settings are tiny, so this lasts
  effectively forever for a demo.
- **SSE through proxies:** the server sends a 15s heartbeat and
  `X-Accel-Buffering: no`, which keeps Render's proxy from buffering the stream.

## Keeping the free backend awake (optional)

Two ways to keep the Render free service from sleeping. Both just hit
`/api/health` periodically (it's cheap — no DB or exchange work):

**A. GitHub Actions (in-repo, zero extra accounts).** This repo includes
`.github/workflows/keepalive.yml`, which pings every ~10 min. To enable it:
- Push the repo to GitHub (the workflow runs from there, not locally).
- Add a repository **variable** `BACKEND_URL` = your Render URL:
  *Settings → Secrets and variables → Actions → Variables → New* →
  `BACKEND_URL = https://orderbook-backend.onrender.com`.
- Optionally trigger a first run from the **Actions** tab (*Run workflow*).
- Caveat: GitHub's scheduled runs are best-effort and can be delayed, so an
  occasional sleep is still possible. GitHub also disables schedules after 60
  days of repo inactivity. Delete the file if you don't want this.

**B. UptimeRobot (more reliable, no code).** Create a free
[UptimeRobot](https://uptimerobot.com) HTTP(s) monitor:
- URL: `https://<backend>/api/health`, interval **5 minutes**.
- This both keeps the service warm and alerts you if it goes down.

> A keep-alive defeats the point of the free tier's sleep (and uses a little
> compute). If you expect real, always-on traffic, just upgrade the Render plan.

## Re-initialising the local git repo (if needed)

```powershell
cd C:\Users\Hansen\orderbook-dashboard
git init
git add .
git commit -m "Orderbook dashboard"
```

`.gitignore` already excludes `node_modules/`, `.env`, build output, and the
local `*.db` files.
