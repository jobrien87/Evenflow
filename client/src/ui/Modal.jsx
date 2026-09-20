import Button from './Button';

export default function Modal({ onClose, title, children, maxWidth = 480 }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 'var(--z-modal)',
        padding: 20,
        overflowY: 'auto',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-lg)',
          maxWidth,
          width: '100%',
          maxHeight: '85vh',
          overflowY: 'auto',
          padding: 'var(--space-6)',
          boxShadow: 'var(--shadow-card)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || onClose) && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
            {title && <div style={{ color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>{title}</div>}
            {onClose && (
              <Button variant="secondary" size="sm" onClick={onClose}>
                CLOSE
              </Button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
