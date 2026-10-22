import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Modal, Button } from '../ui';

// Mirrors VendorsPanel.jsx's AgentPicker checkbox-list pattern — this
// codebase has no shared multi-select component, so each page hand-rolls
// its own, file-local.
function SourcesPicker({ sources, selectedSources, onChange }) {
  if (sources.length === 0) {
    return <div style={s.pickerEmpty}>No known sources for this lead type yet.</div>;
  }
  return (
    <div style={s.pickerBox}>
      {sources.map((name) => {
        const checked = selectedSources.includes(name);
        return (
          <label key={name} style={s.pickerRow}>
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onChange(checked ? selectedSources.filter((s) => s !== name) : [...selectedSources, name])}
            />
            {name}
          </label>
        );
      })}
    </div>
  );
}

const STEPS = ['Lead Type', 'Sources', 'Daily Cap', 'Review'];

// Submission-only wizard for the "Build Your Own" storefront tile — ends
// with a RecordStoreCustomRequest sitting PENDING_REVIEW, never a real
// subscription (no price exists yet). Once a Platform Owner quotes it,
// RecordStorePanel's "My Lead Programs" surfaces an Accept Quote action
// that hands off to the normal RecordStoreWizard (via its
// initialSubscription prop) for funding — this wizard never touches
// funding or Boberdoo provisioning itself.
export default function RecordStoreCustomWizard({ onClose, onSubmitted }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [leadTypes, setLeadTypes] = useState([]);
  const [leadTypeLabel, setLeadTypeLabel] = useState('');
  const [sources, setSources] = useState([]);
  const [sourcesLive, setSourcesLive] = useState(true);
  const [selectedSources, setSelectedSources] = useState([]);
  const [dailyLimit, setDailyLimit] = useState(10);
  const [weeklyLimit, setWeeklyLimit] = useState('');
  const [monthlyLimit, setMonthlyLimit] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    api.recordStoreLeadTypes()
      .then((res) => {
        setLeadTypes(res.leadTypes);
        if (res.leadTypes.length > 0) setLeadTypeLabel(res.leadTypes[0].label);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!leadTypeLabel) return;
    setSelectedSources([]);
    api.recordStoreSources(leadTypeLabel)
      .then((res) => { setSources(res.sources); setSourcesLive(res.live); })
      .catch(() => { setSources([]); });
  }, [leadTypeLabel]);

  const stepName = STEPS[stepIndex];

  function goNext() {
    setError('');
    if (stepName === 'Sources' && selectedSources.length === 0) {
      setError('Pick at least one lead source.');
      return;
    }
    if (stepName === 'Daily Cap' && (!dailyLimit || Number(dailyLimit) <= 0)) {
      setError('Enter a daily cap greater than zero.');
      return;
    }
    if (stepName === 'Review') {
      submit();
      return;
    }
    setStepIndex((i) => i + 1);
  }

  function goBack() {
    setError('');
    setStepIndex((i) => Math.max(0, i - 1));
  }

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api.createCustomRequest({
        leadTypeLabel,
        sources: selectedSources,
        dailyLimit: Number(dailyLimit),
        weeklyLimit: weeklyLimit ? Number(weeklyLimit) : undefined,
        monthlyLimit: monthlyLimit ? Number(monthlyLimit) : undefined,
        notes: notes.trim() || undefined,
      });
      setSubmitted(true);
    } catch (err) {
      setError(err.data?.message || 'Could not submit your request. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="BUILD YOUR OWN" onClose={submitted ? () => { onSubmitted(); onClose(); } : onClose} maxWidth={560}>
      {submitted ? (
        <div style={s.successBox}>
          <div style={s.successTitle}>Request submitted</div>
          <div style={s.helpText}>We'll review your criteria and email you a quote — you'll also see it here under My Lead Programs once it's ready to accept.</div>
          <Button variant="primary" onClick={() => { onSubmitted(); onClose(); }} style={{ marginTop: 12 }}>DONE</Button>
        </div>
      ) : (
        <>
          <div style={s.stepper}>
            {STEPS.map((name, i) => (
              <div key={name} style={s.stepperItem}>
                <div style={i < stepIndex ? { ...s.stepDot, ...s.stepDotDone } : i === stepIndex ? { ...s.stepDot, ...s.stepDotActive } : s.stepDot}>
                  {i < stepIndex ? '✓' : i + 1}
                </div>
                <span style={i === stepIndex ? s.stepLabelActive : s.stepLabel}>{name}</span>
              </div>
            ))}
          </div>

          {stepName === 'Lead Type' && (
            <div style={s.form}>
              <div style={s.helpText}>What kind of leads do you want?</div>
              {leadTypes.map((t) => (
                <label key={t.label} style={s.radioRow}>
                  <input type="radio" name="leadType" checked={leadTypeLabel === t.label} onChange={() => setLeadTypeLabel(t.label)} />
                  {t.label}
                </label>
              ))}
            </div>
          )}

          {stepName === 'Sources' && (
            <div style={s.form}>
              <div style={s.helpText}>
                Which sources will you accept {leadTypeLabel} leads from?
                {!sourcesLive && <span style={s.fallbackNote}> (showing our standard source list — live lookup isn't available right now)</span>}
              </div>
              <SourcesPicker sources={sources} selectedSources={selectedSources} onChange={setSelectedSources} />
            </div>
          )}

          {stepName === 'Daily Cap' && (
            <div style={s.form}>
              <label style={s.fieldLabel}>Daily cap<input style={s.input} type="number" min={1} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} /></label>
              <label style={s.fieldLabel}>Weekly cap (optional)<input style={s.input} type="number" min={1} value={weeklyLimit} onChange={(e) => setWeeklyLimit(e.target.value)} /></label>
              <label style={s.fieldLabel}>Monthly cap (optional)<input style={s.input} type="number" min={1} value={monthlyLimit} onChange={(e) => setMonthlyLimit(e.target.value)} /></label>
              <label style={s.fieldLabel}>Anything else we should know? (optional)<textarea style={{ ...s.input, minHeight: 60 }} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
            </div>
          )}

          {stepName === 'Review' && (
            <div style={s.form}>
              <div style={s.reviewCard}>
                <div style={s.reviewRow}><span>Lead Type</span><strong>{leadTypeLabel}</strong></div>
                <div style={s.reviewRow}><span>Sources</span><strong>{selectedSources.join(', ')}</strong></div>
                <div style={s.reviewRow}><span>Daily Cap</span><strong>{dailyLimit}/day</strong></div>
                {weeklyLimit && <div style={s.reviewRow}><span>Weekly Cap</span><strong>{weeklyLimit}/week</strong></div>}
                {monthlyLimit && <div style={s.reviewRow}><span>Monthly Cap</span><strong>{monthlyLimit}/month</strong></div>}
              </div>
              <div style={s.helpText}>We'll review this and send you a price quote — nothing is charged yet. Once quoted, accept it from My Lead Programs to continue.</div>
            </div>
          )}

          {error && <div style={s.error}>{error}</div>}

          <div style={s.footer}>
            {stepIndex > 0 && <Button variant="secondary" onClick={goBack} disabled={busy}>BACK</Button>}
            <div style={{ flex: 1 }} />
            <Button variant="primary" onClick={goNext} disabled={busy || !leadTypeLabel}>
              {busy ? 'Submitting…' : stepName === 'Review' ? 'SUBMIT REQUEST' : 'CONTINUE'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

const s = {
  stepper: { display: 'flex', gap: 4, marginBottom: 20, flexWrap: 'wrap' },
  stepperItem: { display: 'flex', alignItems: 'center', gap: 6 },
  stepDot: { width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', color: 'var(--text-muted)' },
  stepDotActive: { background: 'var(--accent-gradient)', color: 'var(--accent-on)', border: 'none' },
  stepDotDone: { background: 'var(--surface-tint-lime)', border: '1px solid var(--accent)', color: 'var(--accent)' },
  stepLabel: { fontSize: 10, color: 'var(--text-muted)', marginRight: 10 },
  stepLabelActive: { fontSize: 10, color: 'var(--text-primary)', fontWeight: 700, marginRight: 10 },
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  helpText: { color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, marginBottom: 4 },
  fallbackNote: { color: 'var(--text-muted)', fontStyle: 'italic' },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-muted)' },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  radioRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer', padding: '6px 0' },
  pickerBox: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto', padding: 8, background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 6 },
  pickerRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-primary)', cursor: 'pointer' },
  pickerEmpty: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 },
  reviewCard: { background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 },
  reviewRow: { display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-secondary)', gap: 12 },
  successBox: { textAlign: 'center', padding: '20px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 },
  successTitle: { fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' },
  error: { color: 'var(--danger)', fontSize: 12, marginTop: 10 },
  footer: { display: 'flex', alignItems: 'center', marginTop: 20, gap: 10 },
};
