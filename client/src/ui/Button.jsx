const VARIANTS = {
  primary: { background: 'var(--accent-gradient)', color: 'var(--accent-on)', border: 'none', fontWeight: 700 },
  secondary: { background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-strong)', fontWeight: 600 },
  ghost: { background: 'none', color: 'var(--accent)', border: 'none', fontWeight: 600, padding: 0 },
  danger: { background: 'var(--danger-soft)', color: 'var(--danger)', border: '1px solid rgba(255, 77, 94, 0.4)', fontWeight: 700 },
};

const SIZES = {
  md: { padding: '10px 18px', fontSize: 13, borderRadius: 'var(--radius-sm)' },
  sm: { padding: '6px 12px', fontSize: 12, borderRadius: 'var(--radius-sm)' },
};

export default function Button({ variant = 'primary', size = 'md', style, className, children, ...rest }) {
  const v = VARIANTS[variant] || VARIANTS.primary;
  const s = variant === 'ghost' ? {} : SIZES[size] || SIZES.md;
  return (
    <button
      className={['ui-btn', className].filter(Boolean).join(' ')}
      style={{
        ...v,
        ...s,
        cursor: rest.disabled ? 'not-allowed' : 'pointer',
        opacity: rest.disabled ? 0.5 : 1,
        transition: `transform var(--dur-fast) var(--ease-standard), opacity var(--dur-fast) var(--ease-standard)`,
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
