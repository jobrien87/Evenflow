import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/AuthContext';
import { basePathForRole } from './layout/navConfig';
import RoleGate from './layout/RoleGate';
import AppLayout from './layout/AppLayout';
import Login from './pages/Login';
import AcceptInvitation from './pages/AcceptInvitation';
import ResetPassword from './pages/ResetPassword';

import ProducerDashboard from './pages/ProducerDashboard';
import DrillLibraryPanel from './pages/DrillLibraryPanel';
import DrillDetailPage from './pages/DrillDetailPage';
import TasksPanel from './pages/TasksPanel';
import OpportunitiesPanel from './pages/OpportunitiesPanel';
import TeamChatPanel from './pages/TeamChatPanel';
import MoshpitPanel from './pages/MoshpitPanel';
import MyLeadsPanel from './pages/MyLeadsPanel';
import ProducerDetailPage from './pages/ProducerDetailPage';
import CallScoringProfilePage from './pages/CallScoringProfilePage';

import AgencyOwnerDashboard from './pages/AgencyOwnerDashboard';
import YieldTransfersPanel from './pages/YieldTransfersPanel';
import SalesStudioPanel from './pages/SalesStudioPanel';
import BillboardPanel from './pages/BillboardPanel';
import AgencyLeadsPanel from './pages/AgencyLeadsPanel';
import VendorsPanel from './pages/VendorsPanel';
import FinancialsPanel from './pages/FinancialsPanel';
import SupportPanel from './pages/SupportPanel';
import AgencyBillingPanel from './pages/AgencyBillingPanel';
import GoalsPanel from './pages/GoalsPanel';
import RosterSettingsPanel from './pages/RosterSettingsPanel';
import RecordStorePanel from './pages/RecordStorePanel';
import RecordStoreAdminPanel from './pages/RecordStoreAdminPanel';

import AgenciesPanel from './pages/AgenciesPanel';
import AgencyDetailPage from './pages/AgencyDetailPage';
import TelemarketersPanel from './pages/TelemarketersPanel';
import BillingPanel from './pages/BillingPanel';

import TelemarketerDashboard from './pages/TelemarketerDashboard';
import PersonalizePage from './pages/PersonalizePage';

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

// Drills, Call Coaching, and Training all live inside Sales Studio now,
// per role — this keeps any stale bookmark/notification link to one of
// their old standalone paths working, carrying the `highlight` query
// param (a call id or training assignment id) straight through so the
// right Sales Studio tab opens on the right item.
function RedirectToSalesStudio({ tab }) {
  const { user } = useAuth();
  const location = useLocation();
  const base = basePathForRole(user?.role);
  const params = new URLSearchParams(location.search);
  params.set('tab', tab);
  return <Navigate to={`${base}/sales-studio?${params.toString()}`} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/accept-invitation" element={<AcceptInvitation />} />
      <Route path="/reset-password" element={<ResetPassword />} />

      <Route element={<RequireAuth />}>
        <Route index element={<RoleRedirect />} />
        <Route path="personalize" element={<PersonalizePage />} />

        <Route element={<RoleGate allow={['PRODUCER']} />}>
          <Route path="producer" element={<ProducerDashboard />} />
          <Route path="producer/sales-studio" element={<SalesStudioPanel />} />
          <Route path="producer/drills" element={<RedirectToSalesStudio tab="drills" />} />
          <Route path="producer/drills/:courseId/:lessonId" element={<DrillDetailPage />} />
          <Route path="producer/tasks" element={<TasksPanel />} />
          <Route path="producer/team-chat" element={<TeamChatPanel />} />
          <Route path="producer/coaching" element={<RedirectToSalesStudio tab="diagnostics" />} />
          <Route path="producer/training" element={<RedirectToSalesStudio tab="training" />} />
          <Route path="producer/opportunities" element={<OpportunitiesPanel />} />
          <Route path="producer/moshpit" element={<MoshpitPanel />} />
          <Route path="producer/my-leads" element={<MyLeadsPanel />} />
          <Route path="producer/goals" element={<GoalsPanel />} />
        </Route>

        <Route element={<RoleGate allow={['AGENCY_OWNER', 'AGENCY_MANAGER']} />}>
          <Route path="agency" element={<AgencyOwnerDashboard />} />
          <Route path="agency/sales-studio" element={<SalesStudioPanel />} />
          <Route path="agency/drills/:courseId/:lessonId" element={<DrillDetailPage />} />
          <Route path="agency/tasks" element={<TasksPanel />} />
          <Route path="agency/transfers" element={<YieldTransfersPanel />} />
          <Route path="agency/team-chat" element={<TeamChatPanel />} />
          <Route path="agency/moshpit" element={<MoshpitPanel />} />
          <Route path="agency/vendors" element={<VendorsPanel />} />
          <Route path="agency/support" element={<SupportPanel />} />
          <Route path="agency/coaching" element={<RedirectToSalesStudio tab="diagnostics" />} />
          <Route path="agency/roster-settings" element={<RosterSettingsPanel />} />
          <Route path="agency/billing" element={<AgencyBillingPanel />} />
          <Route path="agency/training" element={<Navigate to="/agency/roster-settings" replace />} />
          <Route path="agency/opportunities" element={<OpportunitiesPanel />} />
          <Route path="agency/leads" element={<AgencyLeadsPanel />} />
          <Route path="agency/goals" element={<GoalsPanel />} />
          <Route path="agency/billboard" element={<BillboardPanel />} />
          <Route path="agency/record-store" element={<RecordStorePanel />} />
          <Route path="agency/producers/:userId" element={<ProducerDetailPage />} />
          <Route path="agency/sales-studio/call-scoring/:userId" element={<CallScoringProfilePage />} />
        </Route>

        <Route element={<RoleGate allow={['AGENCY_OWNER']} />}>
          <Route path="agency/financials" element={<FinancialsPanel />} />
        </Route>

        <Route element={<RoleGate allow={['PLATFORM_OWNER']} />}>
          <Route path="platform" element={<AgenciesPanel />} />
          <Route path="platform/sales-studio" element={<SalesStudioPanel />} />
          <Route path="platform/drills" element={<RedirectToSalesStudio tab="drills" />} />
          <Route path="platform/drills/:courseId/:lessonId" element={<DrillDetailPage />} />
          <Route path="platform/tasks" element={<TasksPanel />} />
          <Route path="platform/agencies/:agencyId" element={<AgencyDetailPage />} />
          <Route path="platform/telemarketers" element={<TelemarketersPanel />} />
          <Route path="platform/financials" element={<FinancialsPanel />} />
          <Route path="platform/support" element={<SupportPanel />} />
          <Route path="platform/billing" element={<BillingPanel />} />
          <Route path="platform/training" element={<RedirectToSalesStudio tab="training" />} />
          <Route path="platform/record-store" element={<RecordStoreAdminPanel />} />
        </Route>

        <Route element={<RoleGate allow={['TELEMARKETER']} />}>
          <Route path="telemarketer" element={<TelemarketerDashboard />} />
          <Route path="telemarketer/drills" element={<DrillLibraryPanel />} />
          <Route path="telemarketer/drills/:courseId/:lessonId" element={<DrillDetailPage />} />
          <Route path="telemarketer/tasks" element={<TasksPanel />} />
        </Route>
      </Route>
    </Routes>
  );
}
