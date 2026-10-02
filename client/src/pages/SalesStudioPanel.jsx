import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SectionHeader } from '../ui';
import DrillLibraryPanel from './DrillLibraryPanel';
import CallScoringPanel from './CallScoringPanel';
import CallsPanel from './CallsPanel';

// Merged "Sales Studio" tab — Drills (the browsable drill library + AI
// roleplay), Call Scoring, Call Diagnostics (per-call upload/transcript/
// analysis, same component the old standalone Coaching tab used — it
// already carries the Coaching Video Theater at its top), all under one
// nav item. Every sub-panel is reused exactly as-is (same components
// already mounted elsewhere, each with its own real MODULE_NOT_ENTITLED
// handling) — this is purely a navigation/layout consolidation, no
// duplicated logic.
//
// `?highlight=<callId>` (set by notification deep-links into a specific
// call) opens straight into the Call Diagnostics tab; `?tab=` supports
// linking directly to any tab.
export default function SalesStudioPanel() {
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') || (searchParams.get('highlight') ? 'diagnostics' : 'drills');
  const [tab, setTab] = useState(initialTab);

  return (
    <div style={s.wrap}>
      <SectionHeader>Sales Studio</SectionHeader>
      <div style={s.tabRow}>
        <button style={s.tab(tab === 'drills')} onClick={() => setTab('drills')}>DRILLS</button>
        <button style={s.tab(tab === 'scoring')} onClick={() => setTab('scoring')}>CALL SCORING</button>
        <button style={s.tab(tab === 'diagnostics')} onClick={() => setTab('diagnostics')}>CALL DIAGNOSTICS</button>
      </div>
      {tab === 'drills' && <DrillLibraryPanel />}
      {tab === 'scoring' && <CallScoringPanel />}
      {tab === 'diagnostics' && <CallsPanel />}
    </div>
  );
}

const s = {
  wrap: {},
  tabRow: { display: 'flex', gap: 8, margin: '14px 0 20px' },
  tab: (active) => ({
    padding: '8px 16px', borderRadius: 6, border: '1px solid var(--border-strong)', cursor: 'pointer', fontSize: 11, fontWeight: 700, letterSpacing: 1,
    background: active ? 'var(--accent-gradient)' : 'transparent', color: active ? 'var(--accent-on)' : 'var(--text-secondary)',
  }),
};
