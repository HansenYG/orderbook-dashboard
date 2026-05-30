// Rule engine: evaluates each normalized snapshot (with metrics) against the
// configured thresholds and produces alert objects. Thresholds are hot-editable
// at runtime; a per-(type, exchange) cooldown prevents alert flooding given the
// ~10 updates/sec input rate.

/** Map an overage ratio (value / threshold) to a severity label. */
function severityFor(ratio) {
  if (ratio >= 2) return 'critical';
  if (ratio >= 1.5) return 'warning';
  return 'info';
}

export class RuleEngine {
  /**
   * @param {object} thresholds { spreadBps, imbalance, discrepancyPct, cooldownMs }
   */
  constructor(thresholds) {
    this.thresholds = { ...thresholds };
    /** @type {Map<string, number>} key -> last fired epoch ms */
    this.lastFired = new Map();
  }

  getThresholds() {
    return { ...this.thresholds };
  }

  /** Merge in new threshold values (ignores unknown/invalid keys). */
  updateThresholds(partial) {
    const next = { ...this.thresholds };
    for (const key of ['spreadBps', 'imbalance', 'discrepancyPct', 'cooldownMs']) {
      if (partial[key] !== undefined) {
        const n = Number(partial[key]);
        if (Number.isFinite(n) && n >= 0) next[key] = n;
      }
    }
    this.thresholds = next;
    return this.getThresholds();
  }

  _cooledDown(key, now) {
    const last = this.lastFired.get(key) ?? 0;
    if (now - last < this.thresholds.cooldownMs) return false;
    this.lastFired.set(key, now);
    return true;
  }

  /**
   * Evaluate one snapshot. Spread/imbalance are checked against this snapshot's
   * book; discrepancy is checked against the supplied cross-exchange metrics.
   * @returns {object[]} alert objects (unsaved)
   */
  evaluate({ exchange, bookMetrics, crossMetrics, now }) {
    const alerts = [];
    const t = this.thresholds;

    // ── Spread alert ──────────────────────────────────────────────────────
    if (bookMetrics?.spreadBps != null && t.spreadBps > 0 && bookMetrics.spreadBps > t.spreadBps) {
      const key = `spread:${exchange}`;
      if (this._cooledDown(key, now)) {
        const ratio = bookMetrics.spreadBps / t.spreadBps;
        alerts.push({
          ts: now,
          type: 'spread',
          exchange,
          severity: severityFor(ratio),
          message: `${exchange} spread ${bookMetrics.spreadBps.toFixed(2)} bps exceeds ${t.spreadBps} bps`,
          value: round(bookMetrics.spreadBps),
          threshold: t.spreadBps,
          payload: { spread: round(bookMetrics.spread), mid: round(bookMetrics.mid) },
        });
      }
    }

    // ── Imbalance alert (top-5 book pressure) ──────────────────────────────
    if (bookMetrics?.imbalance != null && t.imbalance > 0 && Math.abs(bookMetrics.imbalance) > t.imbalance) {
      const key = `imbalance:${exchange}`;
      if (this._cooledDown(key, now)) {
        const ratio = Math.abs(bookMetrics.imbalance) / t.imbalance;
        const side = bookMetrics.imbalance > 0 ? 'buy' : 'sell';
        alerts.push({
          ts: now,
          type: 'imbalance',
          exchange,
          severity: severityFor(ratio),
          message: `${exchange} ${side}-side imbalance ${bookMetrics.imbalance.toFixed(2)} exceeds ±${t.imbalance}`,
          value: round(bookMetrics.imbalance),
          threshold: t.imbalance,
          payload: { bidVol: round(bookMetrics.bidVol), askVol: round(bookMetrics.askVol), side },
        });
      }
    }

    // ── Cross-exchange price discrepancy ───────────────────────────────────
    if (crossMetrics?.discrepancyPct != null && t.discrepancyPct > 0 && crossMetrics.discrepancyPct > t.discrepancyPct) {
      const key = 'discrepancy:cross';
      if (this._cooledDown(key, now)) {
        const ratio = crossMetrics.discrepancyPct / t.discrepancyPct;
        alerts.push({
          ts: now,
          type: 'discrepancy',
          exchange: 'cross',
          severity: severityFor(ratio),
          message: `Binance/Hyperliquid mid diverged ${crossMetrics.discrepancyPct.toFixed(3)}% (> ${t.discrepancyPct}%)`,
          value: round(crossMetrics.discrepancyPct, 4),
          threshold: t.discrepancyPct,
          payload: {
            midDiff: round(crossMetrics.midDiff),
            arbSpread: round(crossMetrics.arbSpread),
            avgMid: round(crossMetrics.avgMid),
          },
        });
      }
    }

    return alerts;
  }
}

function round(n, dp = 2) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
