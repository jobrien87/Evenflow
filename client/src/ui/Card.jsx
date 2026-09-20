export default function Card({ variant = 'default', style, children, ...rest }) {
  const base = {
    background: variant === 'sunken' ? 'var(--bg-sunken)' : 'var(--bg-elevated)',
    border: '1px solid var(--border-hairline)',
    borderRadius: 'var(--radius-md)',
    padding: 'var(--space-5)',
    boxShadow: 'var(--shadow-card)',
  };
  const interactive = variant === 'interactive';
  return (
    <div
      className={interactive ? 'ui-card-interactive' : undefined}
      style={{
        ...base,
        cursor: interactive ? 'pointer' : undefined,
        transition: interactive
          ? `transform var(--dur-base) var(--ease-standard), border-color var(--dur-base) var(--ease-standard)`
          : undefined,
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
