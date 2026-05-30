// AlertsCenter: threshold configuration form + scrollable alert history.
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtClock, fmtNum } from '../format.js';

const FIELDS = [
  { key: 'spreadBps', label: 'Spread alert (bps)', step: '0.1', hint: 'Per-exchange spread in basis points' },
  { key: 'imbalance', label: 'Imbalance (±)', step: '0.05', hint: 'Top-5 bid/ask pressure, 0–1' },
  { key: 'discrepancyPct', label: 'Price discrepancy (%)', step: '0.01', hint: 'Binance vs Hyperliquid mid' },
  { key: 'cooldownMs', label: 'Cooldown (ms)', step: '500', hint: 'Min gap between repeat alerts' },
];

function ConfigForm() {
  const [form, setForm] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | idle | saving | saved | error

  useEffect(() => {
    api
      .getConfig()
      .then((cfg) => {
        setForm(cfg);
        setStatus('idle');
      })
      .catch(() => setStatus('error'));
  }, []);

  const onChange = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }));
    setStatus('idle');
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setStatus('saving');
    try {
      const payload = {};
      for (const { key } of FIELDS) payload[key] = Number(form[key]);
      const updated = await api.updateConfig(payload);
      setForm(updated);
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 1500);
    } catch {
      setStatus('error');
    }
  };

  if (!form) {
    return <div className="muted small">{status === 'error' ? 'Failed to load config' : 'Loading config…'}</div>;
  }

  return (
    <form className="config-form" onSubmit={onSubmit}>
      {FIELDS.map(({ key, label, step, hint }) => (
        <label key={key} className="config-field">
          <span className="config-label">{label}</span>
          <input
            type="number"
            step={step}
            min="0"
            value={form[key] ?? ''}
            onChange={(e) => onChange(key, e.target.value)}
          />
          <span className="muted tiny">{hint}</span>
        </label>
      ))}
      <button type="submit" className={`save-btn ${status}`} disabled={status === 'saving'}>
        {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved ✓' : 'Save thresholds'}
      </button>
      {status === 'error' && <span className="error-text small">Save failed</span>}
    </form>
  );
}

function severityIcon(sev) {
  return sev === 'critical' ? '🔴' : sev === 'warning' ? '🟠' : '🔵';
}

function AlertRow({ a }) {
  return (
    <li className={`alert-row sev-${a.severity}`}>
      <span className="alert-icon">{severityIcon(a.severity)}</span>
      <div className="alert-body">
        <div className="alert-msg">{a.message}</div>
        <div className="alert-meta muted tiny">
          {fmtClock(a.ts)} · {a.type} · {a.exchange}
          {a.value != null && ` · value ${fmtNum(a.value, 3)}`}
        </div>
      </div>
    </li>
  );
}

export function AlertsCenter({ alerts }) {
  return (
    <section className="card alerts-center">
      <h2>Alerts &amp; Reminders</h2>

      <details className="config-disclosure" open>
        <summary>Thresholds</summary>
        <ConfigForm />
      </details>

      <div className="alerts-history-head">
        <h3>History</h3>
        <span className="muted small">{alerts.length} shown</span>
      </div>

      {alerts.length === 0 ? (
        <div className="muted small placeholder">No alerts yet — adjust thresholds to trigger some.</div>
      ) : (
        <ul className="alerts-list">
          {alerts.map((a) => (
            <AlertRow key={a.id ?? `${a.ts}-${a.type}-${a.exchange}`} a={a} />
          ))}
        </ul>
      )}
    </section>
  );
}
