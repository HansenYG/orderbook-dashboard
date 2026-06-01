// Thin REST client.
//
// In development VITE_API_BASE is unset, so paths stay relative ('/api/...') and
// the Vite dev proxy forwards them to the backend (no CORS). In production the
// frontend (Vercel) and backend (Render) are on different origins, so we set
// VITE_API_BASE to the backend's URL at build time and prepend it to every path.
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

/** Build a full URL for an API path, honouring VITE_API_BASE. */
export const apiUrl = (path) => `${API_BASE}${path}`;

async function json(res) {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${text ? ' — ' + text : ''}`);
  }
  return res.json();
}

export const api = {
  getConfig: () => fetch(apiUrl('/api/config')).then(json),

  updateConfig: (thresholds) =>
    fetch(apiUrl('/api/config'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(thresholds),
    }).then(json),

  getAlerts: (limit = 100) => fetch(apiUrl(`/api/alerts?limit=${limit}`)).then(json),

  getStatus: () => fetch(apiUrl('/api/status')).then(json),

  /**
   * Stream a chat reply from the AI assistant. Posts the conversation and reads
   * the plain-text token stream, invoking onText(delta) for each chunk.
   * @param {object} args
   * @param {{role: string, content: string}[]} args.messages
   * @param {(delta: string) => void} args.onText
   * @param {AbortSignal} [args.signal]
   */
  chatStream: async ({ messages, onText, signal }) => {
    const res = await fetch(apiUrl('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal,
    });
    if (!res.ok || !res.body) {
      // Errors before streaming starts come back as JSON.
      let msg = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body?.error) msg = body.error;
      } catch {
        /* non-JSON error body */
      }
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) onText(decoder.decode(value, { stream: true }));
    }
  },
};
