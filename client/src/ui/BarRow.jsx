import ProgressBar from './ProgressBar';

export default function BarRow({ label, value, max = 100, valueLabel }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
        <span>{label}</span>
        <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{valueLabel ?? value}</span>
      </div>
      <ProgressBar value={value} max={max} height={6} />
    </div>
  );
}
