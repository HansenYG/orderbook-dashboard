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
};
