import { useEffect, useState } from 'react';
import { useIsMobile } from '../lib/useViewport';
import Icon from './Icon';

// Small module-level pub-sub for toasts — matches this codebase's existing
// no-Redux/no-Zustand convention (see agencyChat/useTeamChatUnread-style
// hooks) rather than adding a state-management dependency for one feature.
let listeners = [];
let nextId = 1;

export function pushToast({ title, body, icon = 'leads', durationMs = 8000, onClick }) {
  const toast = { id: nextId++, title, body, icon, durationMs, onClick };
  listeners.forEach((fn) => fn(toast));
  return toast.id;
}

export default function ToastHost() {
  const isMobile = useIsMobile();
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    function add(toast) {
      setToasts((prev) => [...prev, toast]);
      setTimeout(() => remove(toast.id), toast.durationMs);
    }
    listeners.push(add);
    return () => {
      listeners = listeners.filter((fn) => fn !== add);
    };
  }, []);

  function remove(id) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  if (toasts.length === 0) return null;

  return (
    <div style={isMobile ? s.wrapMobile : s.wrap}>
      {toasts.map((t) => (
        <div
          key={t.id}
          style={s.toast}
          onClick={() => {
            t.onClick?.();
            remove(t.id);
          }}
        >
          <div style={s.iconWrap}>
            <Icon name={t.icon} size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={s.title}>{t.title}</div>
            {t.body && <div style={s.body}>{t.body}</div>}
          </div>
          <button
            style={s.close}
            onClick={(e) => {
              e.stopPropagation();
              remove(t.id);
            }}
            aria-label="Dismiss"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

const s = {
  wrap: {
    position: 'fixed', top: 16, right: 16, zIndex: 'var(--z-toast)',
    display: 'flex', flexDirection: 'column', gap: 10, width: 340, maxWidth: 'calc(100vw - 32px)',
  },
  wrapMobile: {
    position: 'fixed', top: 12, left: 16, right: 16, zIndex: 'var(--z-toast)',
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  toast: {
    display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px',
    background: 'var(--bg-elevated)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)',
    border: '1px solid var(--border-hairline)', borderLeft: '3px solid var(--accent)',
    borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-card)', cursor: 'pointer',
  },
  iconWrap: {
    width: 28, height: 28, borderRadius: 'var(--radius-sm)', flexShrink: 0,
    background: 'var(--accent-gradient)', color: 'var(--accent-on)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  title: { color: 'var(--text-primary)', fontSize: 13, fontWeight: 700 },
  body: { color: 'var(--text-secondary)', fontSize: 12, marginTop: 2 },
  close: {
    background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
    padding: 2, flexShrink: 0, display: 'flex', alignItems: 'center',
  },
};
