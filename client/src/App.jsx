import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/AuthContext';
import { basePathForRole } from './layout/navConfig';
import RoleGate from './layout/RoleGate';
import AppLayout from './layout/AppLayout';
import Login from './pages/Login';
import AcceptInvitation from './pages/AcceptInvitation';

import ProducerDashboard from './pages/ProducerDashboard';
import CallsPanel from './pages/CallsPanel';
import TrainingPanel from './pages/TrainingPanel';
import OpportunitiesPanel from './pages/OpportunitiesPanel';
import TeamChatPanel from './pages/TeamChatPanel';

import AgencyOwnerDashboard from './pages/AgencyOwnerDashboard';
import YieldTransfersPanel from './pages/YieldTransfersPanel';
import VendorsPanel from './pages/VendorsPanel';
import FinancialsPanel from './pages/FinancialsPanel';
import SupportPanel from './pages/SupportPanel';
import AgencyBillingPanel from './pages/AgencyBillingPanel';
import CoursesAdminPanel from './pages/CoursesAdminPanel';
import GoalsPanel from './pages/GoalsPanel';

import AgenciesPanel from './pages/AgenciesPanel';
import TelemarketersPanel from './pages/TelemarketersPanel';
import BillingPanel from './pages/BillingPanel';

import TelemarketerDashboard from './pages/TelemarketerDashboard';

function RequireAuth() {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ color: '#fff', padding: 40 }}>Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <AppLayout />;
}

function RoleRedirect() {
  const { user } = useAuth();
  return <Navigate to={basePathForRole(user?.role)} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/accept-invitation" element={<AcceptInvitation />} />

      <Route element={<RequireAuth />}>
        <Route index element={<RoleRedirect />} />

        <Route element={<RoleGate allow={['PRODUCER']} />}>
          <Route path="producer" element={<ProducerDashboard />} />
          <Route path="producer/team-chat" element={<TeamChatPanel />} />
          <Route path="producer/coaching" element={<CallsPanel />} />
          <Route path="producer/training" element={<TrainingPanel />} />
          <Route path="producer/opportunities" element={<OpportunitiesPanel />} />
        </Route>

        <Route element={<RoleGate allow={['AGENCY_OWNER', 'AGENCY_MANAGER']} />}>
          <Route path="agency" element={<AgencyOwnerDashboard />} />
          <Route path="agency/transfers" element={<YieldTransfersPanel />} />
          <Route path="agency/vendors" element={<VendorsPanel />} />
          <Route path="agency/financials" element={<FinancialsPanel />} />
          <Route path="agency/support" element={<SupportPanel />} />
          <Route path="agency/coaching" element={<CallsPanel />} />
          <Route path="agency/billing" element={<AgencyBillingPanel />} />
          <Route path="agency/training" element={<CoursesAdminPanel />} />
          <Route path="agency/opportunities" element={<OpportunitiesPanel />} />
          <Route path="agency/goals" element={<GoalsPanel />} />
        </Route>

        <Route element={<RoleGate allow={['PLATFORM_OWNER']} />}>
          <Route path="platform" element={<AgenciesPanel />} />
          <Route path="platform/telemarketers" element={<TelemarketersPanel />} />
          <Route path="platform/financials" element={<FinancialsPanel />} />
          <Route path="platform/support" element={<SupportPanel />} />
          <Route path="platform/billing" element={<BillingPanel />} />
          <Route path="platform/training" element={<CoursesAdminPanel />} />
        </Route>

        <Route element={<RoleGate allow={['TELEMARKETER']} />}>
          <Route path="telemarketer" element={<TelemarketerDashboard />} />
        </Route>
      </Route>
    </Routes>
  );
}
