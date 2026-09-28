import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { mainNavForRole, secondaryNavForRole } from './navConfig';
import { Icon, Button, ComingSoonModal } from '../ui';

export default function MobileDrawer({ open, onClose }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const mainItems = mainNavForRole(user?.role);
  const secondaryItems = secondaryNavForRole(user?.role);
  const [stubOpen, setStubOpen] = useState(false);

  function renderItem(item) {
    return (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.to.split('/').length === 2}
        className={({ isActive }) => `ui-nav-link${isActive ? ' active' : ''}`}
        onClick={item.stub ? (e) => { e.preventDefault(); setStubOpen(true); onClose(); } : onClose}
      >
        <Icon name={item.icon} size={17} />
        {item.label}
      </NavLink>
    );
  }

  return (
    <>
      <div
        style={{ ...s.backdrop, opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none' }}
        onClick={onClose}
      />
      <div style={{ ...s.drawer, transform: open ? 'translateX(0)' : 'translateX(-100%)' }}>
        <div style={s.header}>
          <span style={s.logo}>EVENFLOW</span>
          <button style={s.closeButton} onClick={onClose} aria-label="Close menu">
            <Icon name="close" size={20} />
          </button>
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
          <div style={s.userLabel}>{user?.firstName} · {user?.role.replace('_', ' ')}</div>
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
      </div>

      {stubOpen && (
        <ComingSoonModal
          label="Record Store"
          description="A marketplace to sell your leads directly to buyers via Boberdoo webhooks & APIs. We're building it — stay tuned."
          onClose={() => setStubOpen(false)}
        />
      )}
    </>
  );
}

const s = {
  backdrop: {
    position: 'fixed', inset: 0, background: 'rgba(6,7,9,0.6)', backdropFilter: 'var(--glass-blur-sm)', WebkitBackdropFilter: 'var(--glass-blur-sm)',
    zIndex: 'var(--z-drawer)', transition: `opacity var(--dur-base) var(--ease-standard)`,
  },
  drawer: {
    position: 'fixed', top: 0, left: 0, bottom: 0, width: 260,
    background: 'var(--bg-elevated)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)',
    borderRight: '1px solid var(--border-hairline)',
    zIndex: 'var(--z-drawer)', display: 'flex', flexDirection: 'column',
    transition: `transform var(--dur-base) var(--ease-standard)`,
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'var(--space-4) var(--space-4)' },
  logo: {
    fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, letterSpacing: 1,
    backgroundImage: 'var(--accent-gradient)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
  },
  closeButton: { background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex' },
  nav: { flex: 1, overflowY: 'auto', padding: '0 var(--space-3)', display: 'flex', flexDirection: 'column', gap: 2 },
  secondaryNav: { padding: '0 var(--space-3) var(--space-2)', borderTop: '1px solid var(--border-hairline)', paddingTop: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 2 },
  bottom: { padding: 'var(--space-4)', borderTop: '1px solid var(--border-hairline)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' },
  userLabel: { color: 'var(--text-muted)', fontSize: 11 },
};
