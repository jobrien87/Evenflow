import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useAuth } from './lib/AuthContext';
import Login from './pages/Login';
import AcceptInvitation from './pages/AcceptInvitation';
import ProducerHome from './pages/ProducerHome';
import AgencyOwnerHome from './pages/AgencyOwnerHome';
import PlatformOwnerHome from './pages/PlatformOwnerHome';
import TelemarketerHome from './pages/TelemarketerHome';
import EdWidget from './pages/EdWidget';
import NotificationBell from './pages/NotificationBell';
import ImpersonationBar from './pages/ImpersonationBar';

function Shell({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a' }}>
      <ImpersonationBar />
      <div style={styles.nav}>
        <span style={styles.logo}>EVENFLOW</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <NotificationBell />
          <span style={styles.userLabel}>{user?.firstName} · {user?.role.replace('_', ' ')}</span>
          <button
            style={styles.logoutButton}
            onClick={async () => {
              await logout();
              navigate('/login');
            }}
          >
            Log out
          </button>
        </div>
      </div>
      {children}
      <EdWidget />
    </div>
  );
}

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ color: '#fff', padding: 40 }}>Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <Shell>{children}</Shell>;
}

function HomeRouter() {
  const { user } = useAuth();
  if (user.role === 'PLATFORM_OWNER') return <PlatformOwnerHome />;
  if (user.role === 'AGENCY_OWNER' || user.role === 'AGENCY_MANAGER') return <AgencyOwnerHome />;
  if (user.role === 'TELEMARKETER') return <TelemarketerHome />;
  return <ProducerHome />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/accept-invitation" element={<AcceptInvitation />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <HomeRouter />
          </RequireAuth>
        }
      />
    </Routes>
  );
}

const styles = {
  nav: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', borderBottom: '1px solid #1a1a1a' },
  logo: { color: '#00e5ff', fontWeight: 800, letterSpacing: 2 },
  userLabel: { color: '#888', fontSize: 12 },
  logoutButton: { background: 'transparent', border: '1px solid #333', color: '#aaa', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12 },
};
