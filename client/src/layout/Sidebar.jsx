import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { useTeamChatUnread } from '../lib/useTeamChatUnread';
import { navForRole, teamChatNavPath } from './navConfig';
import { Icon, Button, ComingSoonModal } from '../ui';
import NotificationBell from '../pages/NotificationBell';

export default function Sidebar({ onTakeTour }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const items = navForRole(user?.role);
  const chatUnread = useTeamChatUnread();
  const chatPath = teamChatNavPath(user?.role);
  const [stubOpen, setStubOpen] = useState(false);

  return (
    <aside style={s.wrap}>
      <div style={s.logoRow}>
        <span style={s.logo}>EVENFLOW</span>
      </div>

      <nav style={s.nav}>
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to.split('/').length === 2}
            className={({ isActive }) => `ui-nav-link${isActive ? ' active' : ''}`}
            onClick={item.stub ? (e) => { e.preventDefault(); setStubOpen(true); } : undefined}
          >
            <Icon name={item.icon} size={17} />
            {item.label}
            {chatUnread && item.to === chatPath && <span style={s.unreadDot} />}
          </NavLink>
        ))}
      </nav>

      <div style={s.bottom}>
        <div style={s.bellRow}>
          <NotificationBell openUpward />
          <span style={s.userLabel}>
            {user?.firstName} · {user?.role.replace('_', ' ')}
          </span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          style={{ width: '100%' }}
          onClick={async () => {
            await logout();
            navigate('/login');
          }}
        >
          <Icon name="logout" size={14} style={{ marginRight: 6 }} />
          Log out
        </Button>
        {onTakeTour && (
          <button style={s.tourLink} onClick={onTakeTour}>Take the tour again</button>
        )}
      </div>

      {stubOpen && (
        <ComingSoonModal
          label="Record Store"
          description="A marketplace to sell your leads directly to buyers via Boberdoo webhooks & APIs. We're building it — stay tuned."
          onClose={() => setStubOpen(false)}
        />
      )}
    </aside>
  );
}

const s = {
  wrap: {
    width: 'var(--sidebar-w)',
    flexShrink: 0,
    height: '100vh',
    position: 'sticky',
    top: 0,
    display: 'flex',
    flexDirection: 'column',
    borderRight: '1px solid var(--border-hairline)',
    background: 'var(--bg-elevated)',
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
  },
  logoRow: { padding: 'var(--space-5) var(--space-5) var(--space-4)' },
  logo: {
    fontFamily: 'var(--font-display)',
    fontWeight: 700,
    fontSize: 18,
    letterSpacing: 1,
    backgroundImage: 'var(--accent-gradient)',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
  },
  nav: { flex: 1, overflowY: 'auto', padding: '0 var(--space-3)', display: 'flex', flexDirection: 'column', gap: 2 },
  unreadDot: {
    display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
    background: 'var(--accent-gradient)', marginLeft: 'auto',
  },
  bottom: { padding: 'var(--space-4)', borderTop: '1px solid var(--border-hairline)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' },
  bellRow: { display: 'flex', alignItems: 'center', gap: 10 },
  userLabel: { color: 'var(--text-muted)', fontSize: 11 },
  tourLink: { background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 11, textAlign: 'center', cursor: 'pointer', textDecoration: 'underline', padding: 2 },
};
