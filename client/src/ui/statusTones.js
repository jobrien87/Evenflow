// One semantic tone vocabulary shared by every status/severity/priority
// badge in the app, instead of each page hand-rolling its own color map.

export const TONE_COLORS = {
  neutral: { fg: 'var(--text-secondary)', border: 'var(--border-strong)', bg: 'transparent' },
  accent: { fg: 'var(--accent)', border: 'var(--border-accent)', bg: 'var(--accent-gradient-soft)' },
  warning: { fg: 'var(--warning)', border: 'rgba(255, 184, 77, 0.4)', bg: 'var(--warning-soft)' },
  danger: { fg: 'var(--danger)', border: 'rgba(255, 77, 94, 0.4)', bg: 'var(--danger-soft)' },
  info: { fg: 'var(--text-secondary)', border: 'var(--border-hairline)', bg: 'transparent' },
};

export function priorityTone(band) {
  if (band === 'HIGH') return 'danger';
  if (band === 'MEDIUM') return 'warning';
  return 'neutral';
}

export function severityTone(severity) {
  if (severity === 'CRITICAL') return 'danger';
  if (severity === 'WARNING') return 'warning';
  if (severity === 'ACTION') return 'accent';
  return 'neutral';
}
