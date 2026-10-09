import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { useTeamChatUnread } from '../lib/useTeamChatUnread';
import { goToMarketingSite } from '../lib/marketingUrl';
import { mainNavForRole, secondaryNavForRole, teamChatNavPath } from './navConfig';
import { Icon, Button, ComingSoonModal, Logo } from '../ui';
import NotificationBell from '../pages/NotificationBell';

export default function Sidebar({ onTakeTour }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const mainItems = mainNavForRole(user?.role);
  const secondaryItems = secondaryNavForRole(user?.role);
  const chatUnread = useTeamChatUnread();
  const chatPath = teamChatNavPath(user?.role);
  const [stubOpen, setStubOpen] = useState(false);

  function renderItem(item) {
    return (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.to.split('/').length === 2}
        className={({ isActive }) => `ui-nav-link${isActive ? ' active' : ''}`}
        onClick={item.stub ? (e) => { e.preventDefault(); setStubOpen(true); } : undefined}
        data-tour={item.dataTour}
      >
        <Icon name={item.icon} size={17} />
        {item.label}
        {chatUnread && item.to === chatPath && <span style={s.unreadDot} />}
      </NavLink>
    );
  }

  return (
    <aside style={s.wrap}>
      <div style={s.logoRow}>
        <Logo size="md" />
      </div>

      <nav style={s.nav}>
        {mainItems.map(renderItem)}
      </nav>

      {secondaryItems.length > 0 && (
        <nav style={s.secondaryNav}>
          {secondaryItems.map(renderItem)}
        </nav>
      )}

      <div style={s.bottom}>
        <div style={s.bellRow} data-tour="notification-bell">
          <NotificationBell openUpward />
          <span style={s.userLabel}>
            {user?.firstName} · {user?.role.replace('_', ' ')}
          </span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          style={{ width: '100%' }}
          onClick={() => navigate('/personalize')}
        >
          <Icon name="palette" size={14} style={{ marginRight: 6 }} />
          Personalize
        </Button>
        <Button
          variant="secondary"
          size="sm"
          style={{ width: '100%' }}
          onClick={() => navigate('/security')}
        >
          <Icon name="lock" size={14} style={{ marginRight: 6 }} />
          Security
        </Button>
        <Button
          variant="secondary"
          size="sm"
          style={{ width: '100%' }}
          onClick={async () => {
            await logout();
            goToMarketingSite();
          }}
        >
          <Icon name="logout" size={14} style={{ marginRight: 6 }} />
          Log out
        </Button>
        {onTakeTour && (
          <button style={s.tourButton} onClick={onTakeTour}>
            <Icon name="sparkle" size={14} style={{ marginRight: 6 }} />
            Tour
          </button>
        )}
      </div>

      {stubOpen && (
        <ComingSoonModal
          label="Record Store"
          description="A marketplace to purchase Real Time Internet leads at wholesale prices. We're building it — stay tuned."
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
  nav: { flex: 1, overflowY: 'auto', padding: '0 var(--space-3)', display: 'flex', flexDirection: 'column', gap: 2 },
  secondaryNav: { padding: '0 var(--space-3) var(--space-2)', borderTop: '1px solid var(--border-hairline)', paddingTop: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 2 },
  unreadDot: {
    display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
    background: 'var(--accent-gradient)', marginLeft: 'auto',
  },
  bottom: { padding: 'var(--space-4)', borderTop: '1px solid var(--border-hairline)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' },
  bellRow: { display: 'flex', alignItems: 'center', gap: 10 },
  userLabel: { color: 'var(--text-muted)', fontSize: 11 },
  tourButton: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%',
    background: 'var(--accent-gradient-soft)', border: '1px solid var(--border-hairline)',
    borderRadius: 'var(--radius-sm)', color: 'var(--accent)', fontSize: 12, fontWeight: 700,
    cursor: 'pointer', padding: '8px 10px', letterSpacing: 0.3,
  },
};
