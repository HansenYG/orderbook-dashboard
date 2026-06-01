// Express HTTP server: REST endpoints + the SSE stream endpoint.
// Built as a factory so index.js can inject the live engine/hub/clients/store.
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { buildMarketContext } from './ai/marketContext.js';
import { isAssistantConfigured, assistantInfo, streamChat } from './ai/assistant.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START_TIME = Date.now();

/**
 * @param {object} deps
 * @param {import('./alerts/RuleEngine.js').RuleEngine} deps.ruleEngine
 * @param {import('./stream/sseHub.js').SseHub} deps.sseHub
 * @param {() => object[]} deps.getStatuses  live exchange statuses
 * @param {import('./db/store.js')} deps.store  storage backend (alerts/settings/snapshots)
 */
export function createApp({ ruleEngine, sseHub, getStatuses, store }) {
  const app = express();
  // '*' in CORS_ORIGIN (or an empty list) reflects any Origin; otherwise the
  // request Origin must match one of the configured allowed origins.
  const corsOrigin = config.corsAllowAll || !config.corsOrigins.length ? true : config.corsOrigins;
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json());

  const api = express.Router();

  // ── Health & status ─────────────────────────────────────────────────────
  api.get('/health', (_req, res) => {
    res.json({ ok: true, uptimeSec: Math.round((Date.now() - START_TIME) / 1000), time: Date.now() });
  });

  api.get('/status', (_req, res) => {
    res.json({
      exchanges: getStatuses(),
      sseClients: sseHub.clientCount(),
      simulator: config.useSimulator,
      storage: store.name,
      aiAssistant: isAssistantConfigured(),
      ai: assistantInfo(), // { provider, model }
    });
  });

  // ── Alert threshold configuration ─────────────────────────────────────────
  api.get('/config', (_req, res) => {
    res.json(ruleEngine.getThresholds());
  });

  api.put('/config', async (req, res) => {
    const body = req.body || {};
    const allowed = ['spreadBps', 'imbalance', 'discrepancyPct', 'cooldownMs'];
    // Validate: every provided key must be a finite, non-negative number.
    for (const key of allowed) {
      if (body[key] !== undefined) {
        const n = Number(body[key]);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ error: `Invalid value for ${key}` });
        }
      }
    }
    const updated = ruleEngine.updateThresholds(body);
    await store.setSetting('alertThresholds', updated); // persist across restarts
    res.json(updated);
  });

  // ── Alerts history ────────────────────────────────────────────────────────
  api.get('/alerts', async (req, res, next) => {
    try {
      const { limit, since } = req.query;
      res.json(await store.listAlerts({ limit, since }));
    } catch (err) {
      next(err);
    }
  });

  // ── Recent snapshots (debug / initial chart hydrate) ──────────────────────
  // SQLite mode reads full history from disk; MongoDB mode reads the in-memory
  // ring buffer of recent snapshots.
  api.get('/snapshots', async (req, res, next) => {
    try {
      const exchange = req.query.exchange;
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 500);
      res.json(await store.listSnapshots({ exchange, limit }));
    } catch (err) {
      next(err);
    }
  });

  // ── AI assistant chat (streaming) ─────────────────────────────────────────
  // POST { messages: [{ role: 'user'|'assistant', content: string }, ...] }.
  // The latest dashboard data is injected server-side, so the model always reads
  // the live snapshot. The response body is a plain-text token stream.
  api.post('/chat', async (req, res) => {
    if (!isAssistantConfigured()) {
      return res
        .status(503)
        .json({ error: 'AI assistant is not configured. Set ANTHROPIC_API_KEY on the backend.' });
    }

    // ── Validate the conversation payload ──
    const raw = Array.isArray(req.body?.messages) ? req.body.messages : null;
    if (!raw || raw.length === 0) {
      return res.status(400).json({ error: 'Request body must include a non-empty "messages" array.' });
    }
    const messages = [];
    for (const m of raw) {
      const role = m?.role === 'assistant' ? 'assistant' : 'user';
      const content = typeof m?.content === 'string' ? m.content.trim() : '';
      if (!content) continue;
      // Cap any single message to keep token usage and abuse in check.
      messages.push({ role, content: content.slice(0, 4000) });
    }
    if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'The last message must be a non-empty user message.' });
    }

    // Build the market context before opening the stream so a failure here is a
    // clean JSON error rather than a half-written stream.
    let marketContext;
    try {
      marketContext = await buildMarketContext({
        sseHub,
        store,
        thresholds: ruleEngine.getThresholds(),
      });
    } catch (err) {
      return res.status(500).json({ error: `Failed to read market data: ${err.message}` });
    }

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no', // disable proxy buffering so tokens flush live
    });
    res.flushHeaders?.();

    // Abort the upstream request if the browser disconnects.
    const ac = new AbortController();
    req.on('close', () => ac.abort());

    try {
      await streamChat({
        messages,
        marketContext,
        signal: ac.signal,
        onText: (delta) => res.write(delta),
      });
      res.end();
    } catch (err) {
      if (ac.signal.aborted) {
        return res.end(); // client went away — nothing to report
      }
      console.error('[chat] stream failed:', err.message);
      // Headers are already sent; surface the error inline so the UI can show it.
      res.write(`\n\n⚠️ Assistant error: ${err.message}`);
      res.end();
    }
  });

  // ── SSE stream ────────────────────────────────────────────────────────────
  api.get('/stream', async (req, res) => {
    // addClient sends the current state as the 'init' event; follow it with a
    // snapshot of recent alerts so the history panel hydrates instantly.
    sseHub.addClient(req, res);
    try {
      sseHub._send(res, 'alerts', await store.listAlerts({ limit: 50 }));
    } catch {
      /* history hydrate is best-effort; the live stream continues regardless */
    }
  });

  app.use('/api', api);

  // ── Static frontend (production single-server build), with SPA fallback ────
  // Only used when frontend/dist exists alongside the backend (local prod). In
  // the hosted split (Vercel frontend + Render backend) this directory is absent
  // and the block is skipped.
  const distDir = path.resolve(__dirname, '../../frontend/dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  return app;
}
