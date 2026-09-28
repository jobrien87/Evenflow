import { useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import Button from './Button';

// First-login product tour — a lightweight modal sequence (no library),
// portaled to document.body for the same reason Modal.jsx is: any
// backdrop-filter ancestor (Sidebar/MobileDrawer) would otherwise confine
// a position:fixed overlay to its own box instead of the viewport.
export default function TourOverlay({ steps, onDone }) {
  const [i, setI] = useState(0);
  const step = steps[i];
  const isFirst = i === 0;
  const isLast = i === steps.length - 1;

  return createPortal(
    <div style={s.backdrop}>
      <div style={s.panel}>
        <div style={s.iconWrap}>
          <Icon name={step.icon} size={30} style={{ color: 'var(--accent)' }} />
        </div>
        <div style={s.title}>{step.title}</div>
        <div style={s.body}>{step.body}</div>

        <div style={s.dots}>
          {steps.map((_, idx) => (
            <span key={idx} style={s.dot(idx === i)} />
          ))}
        </div>

        <div style={s.actionsRow}>
          <button style={s.skipLink} onClick={onDone}>SKIP TOUR</button>
          <div style={{ display: 'flex', gap: 8 }}>
            {!isFirst && (
              <Button variant="secondary" size="sm" onClick={() => setI((v) => v - 1)}>BACK</Button>
            )}
            <Button variant="primary" size="sm" onClick={() => (isLast ? onDone() : setI((v) => v + 1))}>
              {isLast ? "LET'S GO" : 'NEXT'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

const s = {
  backdrop: {
    position: 'fixed', inset: 0, background: 'rgba(6, 7, 9, 0.72)',
    backdropFilter: 'var(--glass-blur-sm)', WebkitBackdropFilter: 'var(--glass-blur-sm)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 'var(--z-modal)', padding: 20,
  },
  panel: {
    background: 'var(--bg-elevated)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)',
    border: '1px solid var(--border-hairline)', borderTopColor: 'var(--border-glass-highlight)',
    borderRadius: 'var(--radius-lg)', maxWidth: 400, width: '100%', padding: 'var(--space-6)',
    boxShadow: 'var(--shadow-card)', textAlign: 'center',
  },
  iconWrap: {
    width: 56, height: 56, borderRadius: '50%', margin: '0 auto 16px',
    background: 'var(--accent-gradient-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  title: { color: 'var(--text-primary)', fontWeight: 700, fontSize: 18, marginBottom: 8 },
  body: { color: 'var(--text-secondary)', fontSize: 13.5, lineHeight: 1.55, marginBottom: 20 },
  dots: { display: 'flex', justifyContent: 'center', gap: 6, marginBottom: 20 },
  dot: (active) => ({
    width: active ? 18 : 6, height: 6, borderRadius: 3,
    background: active ? 'var(--accent)' : 'var(--border-strong)',
    transition: 'width var(--dur-fast) var(--ease-standard)',
  }),
  actionsRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  skipLink: { background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 11.5, letterSpacing: 0.5, cursor: 'pointer', fontWeight: 700 },
};
