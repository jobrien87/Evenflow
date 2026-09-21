import { Icon } from '../ui';
import NotificationBell from '../pages/NotificationBell';

export default function MobileTopBar({ onMenuClick }) {
  return (
    <header style={s.wrap}>
      <button style={s.iconButton} onClick={onMenuClick} aria-label="Open menu">
        <Icon name="menu" size={22} />
      </button>
      <span style={s.logo}>EVENFLOW</span>
      <NotificationBell />
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
  logo: {
    fontFamily: 'var(--font-display)',
    fontWeight: 700,
    fontSize: 14,
    letterSpacing: 1,
    backgroundImage: 'var(--accent-gradient)',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
  },
};
