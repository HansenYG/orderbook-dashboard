// Ollama provider — free, local models. Used when AI_PROVIDER=ollama (the
// default). Talks to Ollama's native chat API over plain fetch (no SDK, no key),
// parsing its newline-delimited JSON stream. Requires a running Ollama server
// (`ollama serve`) with the model pulled (`ollama pull <model>`).
import { config } from '../../config.js';

// Ollama needs no API key — it's local. Treat it as always "configured"; if the
// server isn't running or the model isn't pulled, that surfaces as a clear error
// at request time (with instructions) rather than disabling the UI.
export function isConfigured() {
  return true;
}

export function modelName() {
  return config.ollamaModel;
}

/**
 * @param {object} args
 * @param {string} args.system system prompt
 * @param {{role: string, content: string}[]} args.messages
 * @param {(delta: string) => void} args.onText
 * @param {AbortSignal} [args.signal]
 */
export async function stream({ system, messages, onText, signal }) {
  const url = `${config.ollamaHost}/api/chat`;
  const body = {
    model: config.ollamaModel,
    messages: [{ role: 'system', content: system }, ...messages],
    stream: true,
    options: { num_predict: config.chatMaxTokens },
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Bypass ngrok's free-tier browser-warning interstitial when OLLAMA_HOST
        // is an ngrok tunnel. Ollama ignores this header, so it's harmless locally.
        'ngrok-skip-browser-warning': 'true',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error(
      `Couldn't reach Ollama at ${config.ollamaHost}. Make sure it's installed and running ` +
        `(start the Ollama app or run "ollama serve"). [${err.message}]`,
    );
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')) || '';
    // A tunnel that's offline/misconfigured (e.g. ngrok) returns its OWN HTML
    // error — often a 404 — not Ollama's JSON. Don't mislabel that as a missing
    // model: the real problem is the host/tunnel isn't serving Ollama.
    if (/ERR_NGROK|is offline|cloudflare|<!doctype html|<html/i.test(detail)) {
      throw new Error(
        `${config.ollamaHost} responded, but it's not reaching Ollama — the tunnel ` +
          `looks offline. Make sure Ollama ("ollama serve") and the tunnel are both running.`,
      );
    }
    if (res.status === 404) {
      throw new Error(
        `Ollama model "${config.ollamaModel}" isn't available at ${config.ollamaHost}. ` +
          `Pull it first: ollama pull ${config.ollamaModel} (or set OLLAMA_MODEL to one you have).`,
      );
    }
    throw new Error(`Ollama returned ${res.status}: ${(detail || res.statusText).slice(0, 200)}`);
  }
  if (!res.body) throw new Error('Ollama returned an empty response stream.');

  // Parse the NDJSON stream: one JSON object per line, each carrying a partial
  // message; the final object has done=true.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;

      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // skip a partial/garbled line
      }
      if (obj.error) throw new Error(`Ollama: ${obj.error}`);
      const delta = obj.message?.content;
      if (delta) onText(delta);
      if (obj.done) return;
    }
  }
}
