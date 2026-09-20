export default function SectionHeader({ children, right }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)', flexWrap: 'wrap', gap: 8 }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: 1.5,
          textTransform: 'uppercase',
          backgroundImage: 'var(--accent-gradient)',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
        }}
      >
        {children}
      </div>
      {right}
    </div>
  );
}
