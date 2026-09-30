import { Icon, Logo } from '../ui';
import NotificationBell from '../pages/NotificationBell';

export default function MobileTopBar({ onMenuClick }) {
  return (
    <header style={s.wrap}>
      <button style={s.iconButton} onClick={onMenuClick} aria-label="Open menu">
        <Icon name="menu" size={22} />
      </button>
      <Logo size="sm" />
      <span data-tour="notification-bell">
        <NotificationBell />
      </span>
    </header>
  );
}

const s = {
  wrap: {
    height: 'var(--topbar-h-mobile)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 var(--space-4)',
    borderBottom: '1px solid var(--border-hairline)',
    background: 'var(--bg-elevated)',
    backdropFilter: 'var(--glass-blur)',
    WebkitBackdropFilter: 'var(--glass-blur)',
    position: 'sticky',
    top: 0,
    zIndex: 'var(--z-sidebar)',
  },
  iconButton: { background: 'none', border: 'none', color: 'var(--text-primary)', padding: 4, cursor: 'pointer', display: 'flex' },
};
