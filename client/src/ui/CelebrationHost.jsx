import { useEffect, useState } from 'react';
import { onCelebration } from '../lib/celebrations';
import FallingEffectOverlay from './FallingEffectOverlay';
import Modal from './Modal';

const EFFECT_DURATION_MS = 4500;

// Mounted once in AppLayout. Listens for fireCelebration() calls from
// anywhere in the app (a sale logged, a goal completed, a first login,
// a birthday) and shows a timed falling-effect burst — real events
// driving a real moment, not a persistent per-user cosmetic setting
// (that's what the old Personalize falling-effect picker was, now
// retired in favor of this).
export default function CelebrationHost() {
  const [active, setActive] = useState(null);
  const [popup, setPopup] = useState(null);

  useEffect(() => {
    return onCelebration(({ effect, message, popup: popupPayload }) => {
      if (effect && effect !== 'NONE') {
        setActive({ effect, message, key: Date.now() });
      }
      if (popupPayload) setPopup(popupPayload);
    });
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    const timer = setTimeout(() => setActive(null), EFFECT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [active]);

  return (
    <>
      {active && (
        <>
          <FallingEffectOverlay effect={active.effect} />
          {active.message && <div style={s.badge}>{active.message}</div>}
        </>
      )}
      {popup && (
        <Modal onClose={() => setPopup(null)} title={popup.title}>
          <div style={s.popupBody}>{popup.body}</div>
        </Modal>
      )}
    </>
  );
}

const s = {
  badge: {
    position: 'fixed', top: 20, left: '50%', transform: 'translateX(-50%)',
    zIndex: 9001, background: 'var(--bg-elevated)', border: '1px solid var(--border-accent)',
    borderRadius: 'var(--radius-md)', padding: '10px 20px', fontSize: 14, fontWeight: 700,
    color: 'var(--text-primary)', boxShadow: 'var(--shadow-glow-accent)', pointerEvents: 'none',
  },
  popupBody: { fontSize: 15, lineHeight: 1.6, color: 'var(--text-secondary)' },
};
