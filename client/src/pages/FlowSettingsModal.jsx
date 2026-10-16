import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Modal, Button, SectionHeader } from '../ui';

// Lets an Agency Owner/Manager see every weighted component behind Flow
// Score and adjust the weights for the two roles that are actually
// agency-scoped (Agency, Producer). Telemarketer weights are shown too —
// "put all the things that are weighted right now in there" — but stay
// read-only: a Telemarketer's submissions span every agency they work
// with, so there's no single agency to own that config.
const ROLE_TITLES = {
  AGENCY: 'Agency Flow Score',
  PRODUCER: 'Producer Flow Score',
  TELEMARKETER: 'Telemarketer Flow Score',
};

const ROLE_ORDER = ['AGENCY', 'PRODUCER', 'TELEMARKETER'];

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
        const weights = {};
        for (const [key, value] of Object.entries(res.configs[role].weights || {})) {
          weights[key] = String(value);
        }
        nextDrafts[role] = weights;
      }
      setDrafts(nextDrafts);
    } catch (err) {
      setLoadError(err.data?.message || 'Could not load Flow Score weights.');
    }
  }

  function setWeight(role, key, value) {
    setSavedRole((prev) => (prev === role ? null : prev));
    setDrafts((prev) => ({ ...prev, [role]: { ...prev[role], [key]: value } }));
  }

  function sumFor(role) {
    const draft = drafts[role] || {};
    return Object.values(draft).reduce((sum, v) => sum + (Number(v) || 0), 0);
  }

  async function save(role) {
    const draft = drafts[role] || {};
    const weights = {};
    for (const [key, value] of Object.entries(draft)) {
      weights[key] = Math.round(Number(value) * 10) / 10;
    }
    setSavingRole(role);
    setSaveErrors((prev) => ({ ...prev, [role]: '' }));
    try {
      const res = await api.updateFlowScoreWeights(agencyId, role, weights);
      setConfigs((prev) => ({
        ...prev,
        [role]: { ...prev[role], weights: res.config.weights, version: res.config.version },
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
        Flow Score turns real activity into one 0-100 number, built from the weighted parts below.
        Adjust how much each part counts — each role's weights must add up to 100.
      </div>
      {loadError && <div style={s.error}>{loadError}</div>}
      {!configs && !loadError && <div style={s.muted}>Loading…</div>}
      {configs &&
        ROLE_ORDER.filter((role) => configs[role]).map((role) => (
          <RoleSection
            key={role}
            config={configs[role]}
            draft={drafts[role] || {}}
            sum={sumFor(role)}
            saving={savingRole === role}
            saved={savedRole === role}
            error={saveErrors[role]}
            onChange={(key, value) => setWeight(role, key, value)}
            onSave={() => save(role)}
          />
        ))}
    </Modal>
  );
}

function RoleSection({ config, draft, sum, saving, saved, error, onChange, onSave }) {
  const keys = Object.keys(config.labels || {});
  const roundedSum = Math.round(sum * 10) / 10;
  const valid = Math.round(sum) === 100;

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
      <div style={s.rows}>
        {keys.map((key) => (
          <div key={key} style={s.row}>
            <span style={s.label}>{config.labels[key]}</span>
            <input
              style={s.input}
              type="number"
              min={0}
              max={100}
              value={draft[key] ?? ''}
              disabled={!config.editable}
              onChange={(e) => onChange(key, e.target.value)}
            />
          </div>
        ))}
      </div>
      {config.editable && (
        <div style={s.footer}>
          <span style={{ ...s.sum, color: valid ? 'var(--accent)' : 'var(--danger)' }}>
            Total: {roundedSum}{valid ? '' : ' — must equal 100'}
          </span>
          <Button size="sm" disabled={!valid || saving} onClick={onSave}>
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
  rows: { display: 'flex', flexDirection: 'column', gap: 8 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  label: { fontSize: 13, color: 'var(--text-secondary)', flex: 1 },
  input: {
    width: 64, padding: '6px 8px', textAlign: 'right',
    background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)',
    borderRadius: 6, color: 'var(--text-primary)', fontSize: 13,
  },
  footer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  sum: { fontSize: 12, fontWeight: 700 },
  muted: { color: 'var(--text-muted)', fontSize: 13 },
  error: { color: 'var(--danger)', fontSize: 12, marginTop: 8 },
};
