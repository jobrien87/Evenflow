import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { notificationTarget } from '../lib/notificationRouting';
import { severityTone, TONE_COLORS } from '../ui';

const severityDotColor = (severity) => TONE_COLORS[severityTone(severity)].fg;

export default function NotificationBell({ openUpward = false }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showPrefs, setShowPrefs] = useState(false);
  const [prefs, setPrefs] = useState(null);
  const panelRef = useRef(null);

  useEffect(() => {
    loadCount();
    const interval = setInterval(loadCount, 15000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    function handleClickOutside(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  async function loadCount() {
    try {
      const data = await api.unreadNotificationCount();
      setUnreadCount(data.count);
    } catch (err) {
      // ignore transient failures, next poll retries
    }
  }

  async function openPanel() {
    setOpen(!open);
    if (!open) {
      const data = await api.notifications();
      setNotifications(data.notifications);
    }
  }

  async function markRead(id) {
    await api.markNotificationRead(id);
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)));
    loadCount();
  }

  // Real navigation to the entity a notification is actually about, not
  // just a mark-as-read — closes the panel and routes (with a highlight
  // param the destination page reads) to wherever that real entity lives.
  function handleClick(n) {
    if (!n.readAt) markRead(n.id);
    const target = notificationTarget(n, user?.role);
    if (!target.path) return;
    setOpen(false);
    const query = new URLSearchParams();
    if (target.highlightId) query.set('highlight', target.highlightId);
    if (target.openChat) query.set('action', 'chat');
    const qs = query.toString();
    navigate(qs ? `${target.path}?${qs}` : target.path);
  }

  async function markAllRead() {
    await api.markAllNotificationsRead();
    setNotifications((prev) => prev.map((n) => ({ ...n, readAt: new Date().toISOString() })));
    setUnreadCount(0);
  }

  async function openPrefs() {
    const data = await api.notificationPreferences();
    setPrefs(data.preferences);
    setShowPrefs(true);
  }

  async function saveEmailPref(enabled) {
    const data = await api.updateNotificationPreferences({ emailEnabled: enabled });
    setPrefs(data.preferences);
  }

  const hasCritical = notifications.some((n) => n.severity === 'CRITICAL' && !n.readAt);

  return (
    <div style={s.wrap} ref={panelRef}>
      <button style={s.bellButton} onClick={openPanel}>
        🔔
        {unreadCount > 0 && <span style={s.badge(hasCritical)}>{unreadCount > 9 ? '9+' : unreadCount}</span>}
      </button>

      {open && (
        <div style={openUpward ? { ...s.panel, ...s.panelUpward } : s.panel}>
          {showPrefs ? (
            <div style={s.prefsView}>
              <div style={s.panelHeader}>
                <span>Preferences</span>
                <button style={s.linkButton} onClick={() => setShowPrefs(false)}>Back</button>
              </div>
              {prefs && (
                <label style={s.prefRow}>
                  <input type="checkbox" checked={prefs.emailEnabled} onChange={(e) => saveEmailPref(e.target.checked)} />
                  Email notifications
                </label>
              )}
              <div style={s.prefsNote}>Critical alerts (like transfer offers) are always shown, regardless of these settings.</div>
            </div>
          ) : (
            <>
              <div style={s.panelHeader}>
                <span>Notifications</span>
                <div>
                  <button style={s.linkButton} onClick={markAllRead}>Mark all read</button>
                  <button style={s.linkButton} onClick={openPrefs}>Preferences</button>
                </div>
              </div>
              <div style={s.list}>
                {notifications.length === 0 && <div style={s.empty}>No notifications yet.</div>}
                {notifications.map((n) => (
                  <div key={n.id} style={s.item(n.readAt, n.severity)} onClick={() => handleClick(n)}>
                    <div style={s.itemDot(n.severity)} />
                    <div style={{ flex: 1 }}>
                      <div style={s.itemTitle}>{n.title}</div>
                      {n.body && <div style={s.itemBody}>{n.body}</div>}
                      <div style={s.itemTime}>{new Date(n.createdAt).toLocaleString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const s = {
  wrap: { position: 'relative' },
  bellButton: { position: 'relative', background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', padding: 4, color: 'var(--text-secondary)' },
  badge: (critical) => ({
    position: 'absolute', top: -2, right: -2, background: critical ? 'var(--danger)' : 'var(--accent-gradient)', color: critical ? 'var(--text-primary)' : 'var(--accent-on)',
    fontSize: 10, fontWeight: 700, borderRadius: '50%', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
  }),
  panel: {
    position: 'absolute', top: 32, right: 0, width: 320, maxHeight: 420, background: 'var(--bg-elevated)',
    backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)',
    border: '1px solid var(--border-hairline)', borderTopColor: 'var(--border-glass-highlight)',
    borderRadius: 'var(--radius-md)', overflow: 'hidden', zIndex: 'var(--z-drawer)', boxShadow: 'var(--shadow-card)', display: 'flex', flexDirection: 'column',
  },
  // The sidebar's bell sits at the bottom of a narrow left column. Opening
  // downward (the default, correct for the mobile top bar near the top of
  // a full-width bar) would push the panel off the bottom of the viewport,
  // and anchoring it to the bell's own right edge (also correct for the
  // top bar) would push a 320px-wide panel off the LEFT edge of the whole
  // window, since the sidebar itself is narrower than that. Open upward
  // and to the right instead.
  panelUpward: { top: 'auto', bottom: 32, right: 'auto', left: 0 },
  panelHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--border-hairline)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600 },
  linkButton: { background: 'none', border: 'none', color: 'var(--accent)', fontSize: 11, cursor: 'pointer', marginLeft: 10 },
  list: { overflowY: 'auto', maxHeight: 360 },
  empty: { color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic', padding: 20, textAlign: 'center' },
  item: (readAt, severity) => ({
    display: 'flex', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border-hairline)',
    background: !readAt && severity === 'CRITICAL' ? 'var(--danger-soft)' : !readAt ? 'var(--accent-gradient-soft)' : 'transparent',
    cursor: 'pointer',
  }),
  itemDot: (severity) => ({ width: 8, height: 8, borderRadius: '50%', marginTop: 4, flexShrink: 0, background: severityDotColor(severity) }),
  itemTitle: { color: 'var(--text-primary)', fontSize: 13, fontWeight: 600 },
  itemBody: { color: 'var(--text-secondary)', fontSize: 12, marginTop: 2 },
  itemTime: { color: 'var(--text-muted)', fontSize: 10, marginTop: 4 },
  prefsView: {},
  prefRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '14px', color: 'var(--text-secondary)', fontSize: 13 },
  prefsNote: { color: 'var(--text-muted)', fontSize: 11, padding: '0 14px 14px', lineHeight: 1.5 },
};
