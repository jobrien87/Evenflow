import { useState } from 'react';
import { SectionHeader } from '../ui';
import DrillLibraryPanel from './DrillLibraryPanel';
import CallScoringPanel from './CallScoringPanel';

// Merged "Sales Studio" tab — Drills (the browsable drill library + AI
// roleplay) and Call Scoring, under one nav item. Both sub-panels are
// reused exactly as-is (same components already mounted standalone
// elsewhere, each with its own real MODULE_NOT_ENTITLED handling) — this
// is purely a navigation/layout consolidation, no duplicated logic.
export default function SalesStudioPanel() {
  const [tab, setTab] = useState('drills');

  return (
    <div style={s.wrap}>
      <SectionHeader>Sales Studio</SectionHeader>
      <div style={s.tabRow}>
        <button style={s.tab(tab === 'drills')} onClick={() => setTab('drills')}>DRILLS</button>
        <button style={s.tab(tab === 'scoring')} onClick={() => setTab('scoring')}>CALL SCORING</button>
      </div>
      {tab === 'drills' ? <DrillLibraryPanel /> : <CallScoringPanel />}
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
