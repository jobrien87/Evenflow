const SIZES = {
  md: { width: 40, height: 22, thumb: 16 },
  sm: { width: 32, height: 18, thumb: 12 },
};

export default function Toggle({ checked, onChange, size = 'md', disabled = false, label, style, ...rest }) {
  const sz = SIZES[size] || SIZES.md;
  const pad = (sz.height - sz.thumb) / 2;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className="ui-toggle"
      style={{
        position: 'relative',
        width: sz.width,
        height: sz.height,
        borderRadius: sz.height / 2,
        border: 'none',
        padding: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        background: checked ? 'var(--accent-gradient)' : 'var(--bg-sunken)',
        boxShadow: checked ? 'none' : 'inset 0 0 0 1px var(--border-strong)',
        transition: `background var(--dur-fast) var(--ease-standard)`,
        flexShrink: 0,
        ...style,
      }}
      {...rest}
    >
      <span
        style={{
          position: 'absolute',
          top: pad,
          left: checked ? sz.width - sz.thumb - pad : pad,
          width: sz.thumb,
          height: sz.thumb,
          borderRadius: '50%',
          background: checked ? 'var(--accent-on)' : 'var(--text-muted)',
          transition: `left var(--dur-fast) var(--ease-standard)`,
        }}
      />
    </button>
  );
}
