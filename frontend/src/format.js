// Display formatting helpers.

export const fmtPrice = (n) =>
  n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const fmtSize = (n) =>
  n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 });

export const fmtNum = (n, dp = 2) =>
  n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toFixed(dp);

export const fmtPct = (n, dp = 3) => (n == null ? '—' : `${Number(n).toFixed(dp)}%`);

export const fmtTime = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString('en-US', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
};

export const fmtClock = (ms) => (ms ? new Date(ms).toLocaleTimeString('en-US', { hour12: false }) : '—');
