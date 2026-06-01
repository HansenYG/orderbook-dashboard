// AI assistant: turns the live dashboard data into market commentary. The
// system prompt and the per-turn market-context injection are shared across
// providers; the actual model call is delegated to a provider module selected
// by AI_PROVIDER (ollama by default — free & local — or anthropic/Claude).
import { config } from '../config.js';
import * as ollama from './providers/ollama.js';
import * as anthropic from './providers/anthropic.js';

function provider() {
  return config.aiProvider === 'anthropic' ? anthropic : ollama;
}

/** Whether the chat endpoint should be enabled for the selected provider. */
export function isAssistantConfigured() {
  return provider().isConfigured();
}

/** Describe the active provider/model (surfaced in /api/status and the UI). */
export function assistantInfo() {
  return {
    provider: config.aiProvider === 'anthropic' ? 'anthropic' : 'ollama',
    model: provider().modelName(),
  };
}

const SYSTEM_PROMPT = `You are the embedded market assistant inside a real-time BTC perpetual order-book dashboard. The dashboard streams normalized order books for the same instrument (BTC perpetual) from two venues — Binance Futures and Hyperliquid — and computes spread, mid price, top-5 order-book imbalance, and cross-exchange metrics (mid-price discrepancy and a gross arbitrage gap).

On every turn you receive a <live_market_data> block: a JSON snapshot of exactly what the user is currently looking at. Field guide:
- exchanges.<venue>.mid / bestBid / bestAsk / spread / spreadBps — top-of-book pricing.
- exchanges.<venue>.imbalanceTop5 — order-book imbalance over the top 5 levels, in [-1, 1]. Positive = more resting bid (buy) size than ask size (buying pressure / potential support); negative = more ask size (selling pressure / potential resistance).
- exchanges.<venue>.bidVolumeTop5 / askVolumeTop5 / topBids / topAsks — depth detail (sizes in BTC).
- exchanges.<venue>.trend — recent mid-price change (midChange, midChangePct), high/low, and direction over a short window (overSeconds); may be null if little history exists.
- crossExchange.discrepancyPct — |Binance mid − Hyperliquid mid| as a % of the average mid.
- crossExchange.arbitrageGap — best gross cross-venue edge (buy the cheaper ask, sell into the richer bid). Positive means a gross arbitrage exists BEFORE fees, funding, and slippage.
- recentAlerts — alerts the dashboard's rule engine recently fired (spread / imbalance / discrepancy).

Your job, depending on what the user asks:
- Market situation: summarize the current state — direction, spread/liquidity conditions, imbalance, and any cross-exchange divergence — citing the actual numbers from the snapshot.
- Buy / sell lean: give a clear, reasoned short-term lean (e.g. "leans bullish", "leans bearish", "no clear edge / stay flat") grounded in imbalance, trend, spread, and discrepancy. Be decisive but honest about confidence.
- Anomalies: flag anything unusual — wide/abnormal spreads, extreme imbalance, large cross-exchange discrepancy, stale or disconnected feeds, a standing arbitrage gap, or clustered alerts.
- Arbitrage: interpret arbitrageGap and discrepancyPct, and note that the gross edge must clear taker fees, funding, and slippage to be real.

Audience and tone — IMPORTANT:
- Write for a complete beginner who is new to trading. Use plain, everyday language and short sentences. Assume the reader does NOT know trading jargon.
- The first time you use any technical term, explain it in a few plain words in parentheses, e.g. "the spread (the small gap between the best buy price and the best sell price)", "the mid price (roughly the current price, halfway between buy and sell)", "imbalance (whether there are more buy orders or sell orders waiting)". Prefer simple words over jargon wherever possible.
- Still use the real numbers, but always pair a number with what it means in plain terms (e.g. "the price has barely moved" instead of just a percentage). Don't dump a wall of statistics.
- A simple everyday comparison is welcome if it makes an idea click.

Rules:
- Ground every claim in the provided numbers. Never invent prices, levels, or history that aren't in the snapshot.
- This is only the top of each order book (the few best buy/sell prices) for two venues — mention that limitation in plain terms when it matters. If a feed isn't connected or data is missing, say the read isn't reliable right now.
- If the venues are running on the simulator (connection "simulated"), say plainly that this is practice/demo data, not the real market.
- Keep replies short and scannable: a sentence or two plus simple "- " dash bullets. Plain text only — no markdown tables, no "#" headers, no code fences.
- When you give a buy/sell lean, say it in plain words ("leans toward buying", "leans toward selling", or "no clear signal either way") and briefly why, then end with one short line: "This isn't financial advice — just a quick read of fast-moving data." Skip that line when the user only asked for a summary or an anomaly check.`;

/**
 * Attach the live market context to the most recent user message and normalize
 * the conversation into a provider-neutral message shape.
 * @param {{role: string, content: string}[]} messages
 * @param {object} marketContext
 */
function buildApiMessages(messages, marketContext) {
  const trimmed = messages.slice(-config.chatHistoryLimit);
  const out = trimmed.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content ?? ''),
  }));

  const ctx = `<live_market_data>\n${JSON.stringify(marketContext, null, 2)}\n</live_market_data>`;

  // Find the last user turn and prepend the fresh snapshot to it.
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'user') {
      out[i] = { role: 'user', content: `${ctx}\n\nUser question: ${out[i].content}` };
      return out;
    }
  }
  out.push({ role: 'user', content: ctx });
  return out;
}

/**
 * Stream a chat completion via the active provider. Calls onText(delta) for each
 * text chunk.
 * @param {object} args
 * @param {{role: string, content: string}[]} args.messages conversation so far
 * @param {object} args.marketContext snapshot from buildMarketContext()
 * @param {(delta: string) => void} args.onText
 * @param {AbortSignal} [args.signal]
 */
export async function streamChat({ messages, marketContext, onText, signal }) {
  const apiMessages = buildApiMessages(messages, marketContext);
  await provider().stream({ system: SYSTEM_PROMPT, messages: apiMessages, onText, signal });
}
