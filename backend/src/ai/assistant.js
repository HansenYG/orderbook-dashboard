// AI assistant: a thin wrapper around the Anthropic SDK that turns the live
// dashboard data into market commentary. The system prompt is stable (and
// prompt-cached); the per-turn market snapshot is attached to the latest user
// message so it stays fresh and is tied to the question being answered.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let client = null;

function getClient() {
  if (!config.anthropicApiKey) return null;
  if (!client) client = new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

/** Whether the chat endpoint should be enabled (i.e. an API key is present). */
export function isAssistantConfigured() {
  return Boolean(config.anthropicApiKey);
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

Rules:
- Ground every claim in the provided numbers; quote the specific values you used. Never invent prices, levels, or history that aren't in the snapshot.
- This is top-of-book / top-5 data for two venues only — acknowledge that limitation when relevant. If a feed shows connection != "open"/"simulated" or data is missing, say the read is unreliable.
- If the venues are running on the simulator (connection "simulated"), say so — the data is synthetic, not the live market.
- Keep replies concise and scannable: short paragraphs and simple "- " dash bullets. Plain text only — no markdown tables, no "#" headers, no code fences.
- When you give a buy/sell lean, end with one short line: "Not financial advice — short-term microstructure read only." Do not repeat the disclaimer when the user only asked for a situation summary or anomaly scan.`;

/**
 * Attach the live market context to the most recent user message and normalize
 * the conversation into the SDK's message shape.
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
  // No user turn present (shouldn't happen) — add one carrying the context.
  out.push({ role: 'user', content: ctx });
  return out;
}

/**
 * Stream a chat completion. Calls onText(delta) for each text chunk and resolves
 * with the final Message (for usage/stop-reason inspection).
 * @param {object} args
 * @param {{role: string, content: string}[]} args.messages conversation so far
 * @param {object} args.marketContext snapshot from buildMarketContext()
 * @param {(delta: string) => void} args.onText
 * @param {AbortSignal} [args.signal]
 */
export async function streamChat({ messages, marketContext, onText, signal }) {
  const anthropic = getClient();
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY is not configured on the server.');

  const apiMessages = buildApiMessages(messages, marketContext);

  const stream = anthropic.messages.stream(
    {
      model: config.anthropicModel,
      max_tokens: config.chatMaxTokens,
      thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: apiMessages,
    },
    signal ? { signal } : undefined,
  );

  stream.on('text', (delta) => onText(delta));
  return stream.finalMessage();
}
