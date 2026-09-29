import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useIsMobile } from '../lib/useViewport';
import { useAuth } from '../lib/AuthContext';
import { api } from '../lib/api';
import { GradientDefs, TourOverlay } from '../ui';
import { stepsForRole } from '../lib/tourSteps';
import Sidebar from './Sidebar';
import MobileTopBar from './MobileTopBar';
import MobileDrawer from './MobileDrawer';
import MobileBottomNav from './MobileBottomNav';
import ImpersonationBar from '../pages/ImpersonationBar';
import TimeClockWidget from '../pages/TimeClockWidget';
import EdWidget from '../pages/EdWidget';

export default function AppLayout() {
  // useIsMobile's initial state is read synchronously from matchMedia, so
  // the very first render already picks the right shell — no layout flash.
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { user, refreshUser } = useAuth();
  const [tourDismissed, setTourDismissed] = useState(false);
  const [manualTourOpen, setManualTourOpen] = useState(false);
  const roleSteps = user ? stepsForRole(user.role) : null;
  const tourSteps = manualTourOpen ? roleSteps : (user && !user.tourCompletedAt && !tourDismissed ? roleSteps : null);

  async function finishTour() {
    setTourDismissed(true);
    setManualTourOpen(false);
    if (!user?.tourCompletedAt) {
      try {
        await api.completeTour();
        await refreshUser();
      } catch {
        // Non-fatal — worst case the tour offers itself again next login.
      }
    }
  }

  return (
    <div style={{ minHeight: '100vh' }}>
      <GradientDefs />
      <ImpersonationBar />
      <TimeClockWidget />
      <div style={{ display: 'flex' }}>
        {!isMobile && <Sidebar onTakeTour={() => setManualTourOpen(true)} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          {isMobile && <MobileTopBar onMenuClick={() => setDrawerOpen(true)} />}
          <main
            style={{
              padding: isMobile ? 16 : 32,
              paddingBottom: isMobile ? 'calc(var(--bottom-nav-h) + 24px)' : 32,
              maxWidth: 1100,
              margin: '0 auto',
            }}
          >
            <Outlet />
          </main>
        </div>
      </div>
      {isMobile && <MobileBottomNav />}
      {isMobile && <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />}
      <EdWidget />
      {tourSteps && <TourOverlay steps={tourSteps} onDone={finishTour} />}
    </div>
  );
}
