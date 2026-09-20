import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { basePathForRole } from './navConfig';

// Redirects away if the logged-in user's role isn't one of `allow` —
// closes off e.g. a Producer typing /agency/financials directly.
export default function RoleGate({ allow }) {
  const { user } = useAuth();
  if (!user) return null; // RequireAuth already handles the unauthenticated case
  if (!allow.includes(user.role)) {
    return <Navigate to={basePathForRole(user.role)} replace />;
  }
  return <Outlet />;
}
