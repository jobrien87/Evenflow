import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Modal, Button, SectionHeader } from '../ui';

// Lets an Agency Owner/Manager see every weighted component behind Flow
// Score and adjust how much each counts for the two roles that are
// actually agency-scoped (Agency, Producer). Each component gets a
// Low/Medium/High/Very High tier instead of a raw percentage — the score
// itself is still rated 0-100 under the hood, so the real derived
// percentage is shown as a small caption next to each tier pick.
// Telemarketer weights are shown too — "put all the things that are
// weighted right now in there" — but stay read-only: a Telemarketer's
// submissions span every agency they work with, so there's no single
// agency to own that config.
const ROLE_TITLES = {
  AGENCY: 'Agency Flow Score',
  PRODUCER: 'Producer Flow Score',
  TELEMARKETER: 'Telemarketer Flow Score',
};

const ROLE_ORDER = ['AGENCY', 'PRODUCER', 'TELEMARKETER'];

const LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH'];
const LEVEL_LABELS = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', VERY_HIGH: 'VERY HIGH' };

// Mirrors flowScore.js's own LEVEL_POINTS/levelsToWeights exactly — used
// here ONLY to show a live preview percentage as a tier is picked. The
// real weights are always computed server-side on save; this client copy
// never governs anything, it just avoids a round-trip for the caption.
const LEVEL_POINTS = { LOW: 1, MEDIUM: 2, HIGH: 3, VERY_HIGH: 4 };
function previewWeights(levels, keys) {
  const points = keys.map((k) => LEVEL_POINTS[levels[k]] || 0);
  const totalPoints = points.reduce((a, b) => a + b, 0);
  if (totalPoints === 0) return {};
  const weights = {};
  let runningTotal = 0;
  keys.forEach((key, i) => {
    if (i === keys.length - 1) {
      weights[key] = Math.round((100 - runningTotal) * 10) / 10;
    } else {
      const w = Math.round(((points[i] / totalPoints) * 100) * 10) / 10;
      weights[key] = w;
      runningTotal += w;
    }
  });
  return weights;
}

// Light grouping so an 8-11 row role doesn't read as one long flat list.
// A key with no group falls back to an unheaded group, which is what
// keeps Telemarketer's 2-row read-only section exactly as simple as before.
const COMPONENT_GROUPS = {
  responsiveness: 'Speed & Conversion',
  conversion: 'Speed & Conversion',
  responseSpeed: 'Speed & Conversion',
  funnelHealth: 'Speed & Conversion',
  contactRate: 'Speed & Conversion',
  quoteRate: 'Speed & Conversion',
  goalPace: 'Speed & Conversion',
  openingDiscovery: 'Call Quality',
  objectionClosing: 'Call Quality',
  pipelineControl: 'Call Quality',
  pipelineDiscipline: 'Pipeline & Compliance',
  crossSellFollowThrough: 'Pipeline & Compliance',
  moshpitClaimSpeed: 'Pipeline & Compliance',
  trainingCompliance: 'Pipeline & Compliance',
  attendanceCompliance: 'Pipeline & Compliance',
};
const GROUP_ORDER = ['Speed & Conversion', 'Call Quality', 'Pipeline & Compliance', ''];

function groupKeys(keys) {
  const byGroup = new Map();
  for (const key of keys) {
    const group = COMPONENT_GROUPS[key] || '';
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(key);
  }
  return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => [g, byGroup.get(g)]);
}

export default function FlowSettingsModal({ agencyId, onClose }) {
  const [configs, setConfigs] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [loadError, setLoadError] = useState('');
  const [saveErrors, setSaveErrors] = useState({});
  const [savingRole, setSavingRole] = useState(null);
  const [savedRole, setSavedRole] = useState(null);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agencyId]);

  async function load() {
    try {
      setLoadError('');
      const res = await api.flowScoreWeights(agencyId);
      setConfigs(res.configs);
      const nextDrafts = {};
      for (const role of Object.keys(res.configs)) {
        nextDrafts[role] = { ...(res.configs[role].levels || {}) };
      }
      setDrafts(nextDrafts);
    } catch (err) {
      setLoadError(err.data?.message || 'Could not load Flow Score weights.');
    }
  }

  function setLevel(role, key, level) {
    setSavedRole((prev) => (prev === role ? null : prev));
    setDrafts((prev) => ({ ...prev, [role]: { ...prev[role], [key]: level } }));
  }

  async function save(role) {
    const levels = drafts[role] || {};
    setSavingRole(role);
    setSaveErrors((prev) => ({ ...prev, [role]: '' }));
    try {
      const res = await api.updateFlowScoreWeights(agencyId, role, levels);
      setConfigs((prev) => ({
        ...prev,
        [role]: { ...prev[role], levels: res.config.levels, weights: res.config.weights, version: res.config.version },
      }));
      setSavedRole(role);
    } catch (err) {
      setSaveErrors((prev) => ({ ...prev, [role]: err.data?.message || `Could not save ${role.toLowerCase()} weights.` }));
    } finally {
      setSavingRole(null);
    }
  }

  return (
    <Modal title="FLOW SETTINGS" onClose={onClose} maxWidth={640}>
      <div style={s.intro}>
        Flow Score turns real activity into one 0-100 number (with an A-F grade alongside it), built from
        the weighted parts below. Pick how much each part counts — Low, Medium, High, or Very High — and
        the real percentage is shown next to each one.
      </div>
      {loadError && <div style={s.error}>{loadError}</div>}
      {!configs && !loadError && <div style={s.muted}>Loading…</div>}
      {configs &&
        ROLE_ORDER.filter((role) => configs[role]).map((role) => (
          <RoleSection
            key={role}
            config={configs[role]}
            draft={drafts[role] || {}}
            saving={savingRole === role}
            saved={savedRole === role}
            error={saveErrors[role]}
            onChange={(key, level) => setLevel(role, key, level)}
            onSave={() => save(role)}
          />
        ))}
    </Modal>
  );
}

function RoleSection({ config, draft, saving, saved, error, onChange, onSave }) {
  const keys = Object.keys(config.labels || {});
  const groups = groupKeys(keys);
  // Sorted the same way the server's own updateWeightConfigForAgency
  // normalizes keys before deriving weights — so this live preview always
  // predicts exactly what Save will actually persist, down to which
  // component absorbs the rounding remainder.
  const livePreview = previewWeights(draft, [...keys].sort());

  return (
    <div style={s.section}>
      <SectionHeader right={!config.editable ? <span style={s.readOnlyTag}>PLATFORM-WIDE</span> : null}>
        {ROLE_TITLES[config.role] || config.role}
      </SectionHeader>
      {!config.editable && (
        <div style={s.note}>
          Telemarketer scoring weights are shared across every agency a telemarketer works with, so
          they can't be set per agency here — shown for visibility only.
        </div>
      )}
      {groups.map(([groupName, groupKeysList]) => (
        <div key={groupName || 'default'} style={s.group}>
          {groupName && <div style={s.groupHeading}>{groupName}</div>}
          <div style={s.rows}>
            {groupKeysList.map((key) => (
              <div key={key} style={s.row}>
                <span style={s.label}>{config.labels[key]}</span>
                <div style={s.rowRight}>
                  <span style={s.pctCaption}>{livePreview[key] != null ? `${livePreview[key]}%` : ''}</span>
                  <div style={s.tierGroup}>
                    {LEVELS.map((level, i) => {
                      const active = draft[key] === level;
                      return (
                        <button
                          key={level}
                          type="button"
                          disabled={!config.editable}
                          onClick={() => onChange(key, level)}
                          style={{
                            ...s.tierButton,
                            ...(i === LEVELS.length - 1 ? { borderRight: 'none' } : null),
                            ...(active ? s.tierButtonActive : null),
                            cursor: config.editable ? 'pointer' : 'default',
                          }}
                        >
                          {LEVEL_LABELS[level]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {config.editable && (
        <div style={s.footer}>
          <Button size="sm" disabled={saving} onClick={onSave}>
            {saving ? 'SAVING…' : saved ? 'SAVED ✓' : 'SAVE'}
          </Button>
        </div>
      )}
      {error && <div style={s.error}>{error}</div>}
    </div>
  );
}

const s = {
  intro: { fontSize: 12, color: 'var(--text-muted)', marginBottom: 20, lineHeight: 1.5 },
  section: { marginBottom: 24, paddingBottom: 20, borderBottom: '1px solid var(--border-hairline)' },
  note: { fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: 10 },
  readOnlyTag: { fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: 'var(--text-muted)' },
  group: { marginBottom: 10 },
  groupHeading: { color: 'var(--text-primary)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 14, marginBottom: 6 },
  rows: { display: 'flex', flexDirection: 'column', gap: 10 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  label: { fontSize: 13, color: 'var(--text-secondary)', flex: 1, minWidth: 160 },
  rowRight: { display: 'flex', alignItems: 'center', gap: 10 },
  pctCaption: { fontSize: 11, color: 'var(--text-muted)', minWidth: 32, textAlign: 'right' },
  tierGroup: { display: 'flex', border: '1px solid var(--border-strong)', borderRadius: 6, overflow: 'hidden' },
  tierButton: {
    padding: '5px 9px', fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
    background: 'var(--bg-sunken)', color: 'var(--text-muted)', border: 'none',
    borderRight: '1px solid var(--border-strong)',
  },
  tierButtonActive: { background: 'var(--accent-gradient)', color: 'var(--accent-on)' },
  footer: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginTop: 14 },
  muted: { color: 'var(--text-muted)', fontSize: 13 },
  error: { color: 'var(--danger)', fontSize: 12, marginTop: 8 },
};
