import { NavLink } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { useTeamChatUnread } from '../lib/useTeamChatUnread';
import { primaryNavForRole, teamChatNavPath } from './navConfig';
import { Icon } from '../ui';

export default function MobileBottomNav() {
  const { user } = useAuth();
  const items = primaryNavForRole(user?.role);
  const chatUnread = useTeamChatUnread();
  const chatPath = teamChatNavPath(user?.role);

  return (
    <nav style={s.wrap}>
      {items.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.to.split('/').length === 2} style={s.item} className={({ isActive }) => (isActive ? 'active' : '')}>
          {({ isActive }) => (
            <>
              <span style={s.iconWrap}>
                <Icon name={item.icon} size={20} style={{ color: isActive ? 'var(--accent)' : 'var(--text-muted)' }} />
                {chatUnread && item.to === chatPath && <span style={s.unreadDot} />}
              </span>
              <span style={{ ...s.label, color: isActive ? 'var(--accent)' : 'var(--text-muted)' }}>{item.label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

const s = {
  wrap: {
    position: 'fixed', bottom: 0, left: 0, right: 0, height: 'var(--bottom-nav-h)',
    display: 'flex', background: 'var(--bg-elevated)', borderTop: '1px solid var(--border-hairline)',
    zIndex: 'var(--z-sidebar)',
  },
  item: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 2, textDecoration: 'none',
  },
  iconWrap: { position: 'relative', display: 'flex' },
  unreadDot: {
    position: 'absolute', top: -2, right: -4, width: 7, height: 7, borderRadius: '50%',
    background: 'var(--accent-gradient)',
  },
  label: { fontSize: 10, fontWeight: 600 },
};
