import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { navForRole } from './navConfig';
import { Icon, Button } from '../ui';
import NotificationBell from '../pages/NotificationBell';

export default function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const items = navForRole(user?.role);

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
          >
            <Icon name={item.icon} size={17} />
            {item.label}
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
      </div>
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
  bottom: { padding: 'var(--space-4)', borderTop: '1px solid var(--border-hairline)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' },
  bellRow: { display: 'flex', alignItems: 'center', gap: 10 },
  userLabel: { color: 'var(--text-muted)', fontSize: 11 },
};
