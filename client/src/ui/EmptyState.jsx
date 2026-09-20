export default function EmptyState({ title, description, action }) {
  return (
    <div style={{ textAlign: 'center', padding: 'var(--space-8) var(--space-4)' }}>
      {title && <div style={{ color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{title}</div>}
      <div style={{ color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic' }}>{description}</div>
      {action && <div style={{ marginTop: 'var(--space-4)' }}>{action}</div>}
    </div>
  );
}
