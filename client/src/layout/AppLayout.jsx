import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useIsMobile } from '../lib/useViewport';
import { GradientDefs } from '../ui';
import Sidebar from './Sidebar';
import MobileTopBar from './MobileTopBar';
import MobileDrawer from './MobileDrawer';
import MobileBottomNav from './MobileBottomNav';
import ImpersonationBar from '../pages/ImpersonationBar';
import EdWidget from '../pages/EdWidget';

export default function AppLayout() {
  // useIsMobile's initial state is read synchronously from matchMedia, so
  // the very first render already picks the right shell — no layout flash.
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <GradientDefs />
      <ImpersonationBar />
      <div style={{ display: 'flex' }}>
        {!isMobile && <Sidebar />}
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
    </div>
  );
}
