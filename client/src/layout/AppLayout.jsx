import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useIsMobile } from '../lib/useViewport';
import { useAuth } from '../lib/AuthContext';
import { api } from '../lib/api';
import { GradientDefs, TourOverlay, ToastHost } from '../ui';
import { stepsForRole } from '../lib/tourSteps';
import { unlockAudio } from '../lib/drumRoll';
import LeadAlertListener, { LEAD_ALERT_ROLES } from '../lib/useLeadAlerts';
import Sidebar from './Sidebar';
import MobileTopBar from './MobileTopBar';
import MobileDrawer from './MobileDrawer';
import MobileBottomNav from './MobileBottomNav';
import ImpersonationBar from '../pages/ImpersonationBar';
import TimeClockWidget from '../pages/TimeClockWidget';
import AnnouncementModal from '../pages/AnnouncementModal';
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

  // Browsers block AudioContext playback until a real user gesture — warm
  // it up on the first click/keypress anywhere in the app so the new-lead
  // drum roll (lib/drumRoll.js) is already unlocked by the time it's needed.
  useEffect(() => {
    document.addEventListener('pointerdown', unlockAudio, { once: true });
    document.addEventListener('keydown', unlockAudio, { once: true });
    return () => {
      document.removeEventListener('pointerdown', unlockAudio);
      document.removeEventListener('keydown', unlockAudio);
    };
  }, []);

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
      <AnnouncementModal />
      {user && LEAD_ALERT_ROLES.has(user.role) && <LeadAlertListener />}
      <ToastHost />
    </div>
  );
}
