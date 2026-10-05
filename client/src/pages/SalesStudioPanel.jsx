import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { SectionHeader } from '../ui';
import DrillLibraryPanel from './DrillLibraryPanel';
import CallScoringPanel from './CallScoringPanel';
import CallsPanel from './CallsPanel';
import TrainingPanel from './TrainingPanel';
import CoursesAdminPanel from './CoursesAdminPanel';

// Sales Studio is the one home for every coaching/training surface, per
// role:
//  - DRILLS (everyone): the 75-drill library + AI roleplay.
//  - CALL SCORING (Agency Owner/Manager only): upload a producer's call
//    on their behalf + the cross-producer Coaching Box.
//  - CALL DIAGNOSTICS (Producer, Agency Owner/Manager): per-call upload/
//    transcript/analysis — carries the Coaching Video Theater at its top,
//    and a Producer's own self-service coaching breakdown.
//  - TRAINING (everyone except Telemarketer, who has no formal
//    assignment workflow): a Producer's own assigned courses, or course
//    administration for Owner/Manager/Platform Owner.
// Every tab reuses its existing component exactly as-is (same components
// already mounted elsewhere, each with its own real MODULE_NOT_ENTITLED
// handling) — this is purely a navigation/layout consolidation, no
// duplicated logic.
const TAB_DEFS = {
  PRODUCER: [
    { key: 'drills', label: 'DRILLS', Component: DrillLibraryPanel },
    { key: 'diagnostics', label: 'CALL DIAGNOSTICS', Component: CallsPanel },
    { key: 'training', label: 'TRAINING', Component: TrainingPanel },
  ],
  AGENCY_OWNER: [
    { key: 'drills', label: 'DRILLS', Component: DrillLibraryPanel },
    { key: 'scoring', label: 'CALL SCORING', Component: CallScoringPanel },
    { key: 'diagnostics', label: 'CALL DIAGNOSTICS', Component: CallsPanel },
    { key: 'training', label: 'TRAINING', Component: CoursesAdminPanel },
  ],
  PLATFORM_OWNER: [
    { key: 'drills', label: 'DRILLS', Component: DrillLibraryPanel },
    { key: 'training', label: 'TRAINING', Component: CoursesAdminPanel },
  ],
};
TAB_DEFS.AGENCY_MANAGER = TAB_DEFS.AGENCY_OWNER;

// `?tab=` supports linking directly to any tab (notification deep-links
// into Call Diagnostics or a Training assignment both set it explicitly
// — see lib/notificationRouting.js); an unrecognized/missing value falls
// back to the first tab for that role.
export default function SalesStudioPanel() {
  const { user } = useAuth();
  const tabs = TAB_DEFS[user?.role] || TAB_DEFS.PRODUCER;
  const [searchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const initialTab = tabs.some((t) => t.key === requestedTab) ? requestedTab : tabs[0].key;
  const [tab, setTab] = useState(initialTab);
  const active = tabs.find((t) => t.key === tab) || tabs[0];
  const ActiveComponent = active.Component;

  return (
    <div style={s.wrap}>
      <SectionHeader>Sales Studio</SectionHeader>
      <div style={s.tabRow}>
        {tabs.map((t) => (
          <button key={t.key} style={s.tab(tab === t.key)} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      <ActiveComponent />
    </div>
  );
}

const s = {
  wrap: {},
  tabRow: { display: 'flex', gap: 8, margin: '14px 0 20px', flexWrap: 'wrap' },
  tab: (active) => ({
    padding: '8px 16px', borderRadius: 6, border: '1px solid var(--border-strong)', cursor: 'pointer', fontSize: 11, fontWeight: 700, letterSpacing: 1,
    background: active ? 'var(--accent-gradient)' : 'transparent', color: active ? 'var(--accent-on)' : 'var(--text-secondary)',
  }),
};
