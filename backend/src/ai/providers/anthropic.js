// Anthropic (Claude) provider. Used when AI_PROVIDER=anthropic. The stable
// system prompt is prompt-cached; adaptive thinking is enabled.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';

let client = null;

function getClient() {
  if (!config.anthropicApiKey) return null;
  if (!client) client = new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

/** Anthropic is "configured" only when an API key is present. */
export function isConfigured() {
  return Boolean(config.anthropicApiKey);
}

export function modelName() {
  return config.anthropicModel;
}

/**
 * @param {object} args
 * @param {string} args.system system prompt
 * @param {{role: string, content: string}[]} args.messages
 * @param {(delta: string) => void} args.onText
 * @param {AbortSignal} [args.signal]
 */
export async function stream({ system, messages, onText, signal }) {
  const anthropic = getClient();
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY is not configured on the server.');

  const s = anthropic.messages.stream(
    {
      model: config.anthropicModel,
      max_tokens: config.chatMaxTokens,
      thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
    },
    signal ? { signal } : undefined,
  );

  s.on('text', (delta) => onText(delta));
  await s.finalMessage();
}
