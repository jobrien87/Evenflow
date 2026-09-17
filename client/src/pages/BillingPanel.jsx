import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function BillingPanel() {
  const [billingStatus, setBillingStatus] = useState(null);
  const [plans, setPlans] = useState([]);
  const [agencies, setAgencies] = useState([]);
  const [showPlanForm, setShowPlanForm] = useState(false);
  const [planForm, setPlanForm] = useState({ name: '', priceCents: '', interval: 'MONTHLY', crmEnabled: true, transfersEnabled: false, coachingEnabled: false });
  const [selectedAgencyId, setSelectedAgencyId] = useState('');
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [currentSub, setCurrentSub] = useState(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const [statusData, planData, agencyData] = await Promise.all([api.billingStatus(), api.plans(), api.agencies()]);
    setBillingStatus(statusData);
    setPlans(planData.plans);
    setAgencies(agencyData.agencies);
  }

  async function loadSubscription(agencyId) {
    setSelectedAgencyId(agencyId);
    if (!agencyId) { setCurrentSub(null); return; }
    const data = await api.agencySubscription(agencyId);
    setCurrentSub(data.subscription);
  }

  async function createPlan(e) {
    e.preventDefault();
    try {
      await api.createPlan({ ...planForm, priceCents: Math.round(parseFloat(planForm.priceCents || 0) * 100) });
      setPlanForm({ name: '', priceCents: '', interval: 'MONTHLY', crmEnabled: true, transfersEnabled: false, coachingEnabled: false });
      setShowPlanForm(false);
      await load();
    } catch (err) {
      alert(err.data?.message || 'Failed to create plan.');
    }
  }

  async function togglePlanActive(plan) {
    await api.updatePlan(plan.id, { isActive: !plan.isActive });
    await load();
  }

  async function assign() {
    if (!selectedAgencyId || !selectedPlanId) return;
    setStatus('Assigning…');
    try {
      await api.assignSubscription(selectedAgencyId, { planId: selectedPlanId, status: 'ACTIVE' });
      setStatus('Assigned. Agency entitlements updated immediately.');
      await loadSubscription(selectedAgencyId);
    } catch (err) {
      setStatus(err.data?.message || 'Failed to assign.');
    }
  }

  async function cancel() {
    if (!selectedAgencyId) return;
    if (!confirm('Cancel this agency\'s subscription? Transfers and Coaching will be disabled immediately.')) return;
    await api.cancelSubscription(selectedAgencyId);
    await loadSubscription(selectedAgencyId);
  }

  if (!billingStatus) return <div style={{ color: '#666' }}>Loading…</div>;

  return (
    <div style={s.wrap}>
      <div style={s.modeBanner(billingStatus.mode)}>
        {billingStatus.mode === 'MANUAL' ? billingStatus.note : 'Payment processor connected, automated billing active.'}
      </div>

      <section style={s.section}>
        <div style={s.headerRow}>
          <h3 style={s.h3}>PLANS ({plans.length})</h3>
          <button style={s.smallButton} onClick={() => setShowPlanForm(!showPlanForm)}>+ NEW PLAN</button>
        </div>

        {showPlanForm && (
          <form onSubmit={createPlan} style={s.form}>
            <input style={s.input} placeholder="Plan name" value={planForm.name} onChange={(e) => setPlanForm({ ...planForm, name: e.target.value })} required />
            <input style={s.input} type="number" step="0.01" min="0" placeholder="Price ($/interval)" value={planForm.priceCents} onChange={(e) => setPlanForm({ ...planForm, priceCents: e.target.value })} required />
            <select style={s.input} value={planForm.interval} onChange={(e) => setPlanForm({ ...planForm, interval: e.target.value })}>
              <option value="MONTHLY">Monthly</option>
              <option value="ANNUAL">Annual</option>
            </select>
            <label style={s.checkboxRow}>
              <input type="checkbox" checked={planForm.crmEnabled} onChange={(e) => setPlanForm({ ...planForm, crmEnabled: e.target.checked })} /> CRM
            </label>
            <label style={s.checkboxRow}>
              <input type="checkbox" checked={planForm.transfersEnabled} onChange={(e) => setPlanForm({ ...planForm, transfersEnabled: e.target.checked })} /> Yield Transfers
            </label>
            <label style={s.checkboxRow}>
              <input type="checkbox" checked={planForm.coachingEnabled} onChange={(e) => setPlanForm({ ...planForm, coachingEnabled: e.target.checked })} /> Sales Coaching
            </label>
            <button style={s.submitButton} type="submit">Create Plan</button>
          </form>
        )}

        {plans.map((p) => (
          <div key={p.id} style={s.planRow}>
            <div>
              <div style={s.rowTitle}>{p.name} — ${(p.priceCents / 100).toFixed(2)}/{p.interval === 'MONTHLY' ? 'mo' : 'yr'}</div>
              <div style={s.rowSub}>
                {[p.crmEnabled && 'CRM', p.transfersEnabled && 'Transfers', p.coachingEnabled && 'Coaching'].filter(Boolean).join(' · ')}
              </div>
            </div>
            <button style={s.smallButtonOutline} onClick={() => togglePlanActive(p)}>{p.isActive ? 'DEACTIVATE' : 'ACTIVATE'}</button>
          </div>
        ))}
      </section>

      <section style={s.section}>
        <h3 style={s.h3}>ASSIGN PLAN TO AGENCY</h3>
        <div style={s.assignForm}>
          <select style={s.input} value={selectedAgencyId} onChange={(e) => loadSubscription(e.target.value)}>
            <option value="">Select agency…</option>
            {agencies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>

          {selectedAgencyId && (
            <>
              <div style={s.currentSubBox}>
                {currentSub ? (
                  <>Current plan: <strong>{currentSub.plan.name}</strong> ({currentSub.status})</>
                ) : (
                  <span style={{ color: '#888' }}>No active subscription, agency is on default (CRM only) access.</span>
                )}
              </div>
              <select style={s.input} value={selectedPlanId} onChange={(e) => setSelectedPlanId(e.target.value)}>
                <option value="">Select new plan…</option>
                {plans.filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={s.submitButton} onClick={assign} disabled={!selectedPlanId}>ASSIGN PLAN</button>
                {currentSub && <button style={s.cancelButton} onClick={cancel}>CANCEL SUBSCRIPTION</button>}
              </div>
              {status && <div style={s.status}>{status}</div>}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

const s = {
  wrap: {},
  modeBanner: (mode) => ({
    background: mode === 'MANUAL' ? '#1a1610' : '#0d1a1a', border: `1px solid ${mode === 'MANUAL' ? '#ffb84d55' : '#00e5ff55'}`,
    color: mode === 'MANUAL' ? '#ffb84d' : '#00e5ff', padding: 12, borderRadius: 8, fontSize: 12, marginBottom: 20,
  }),
  section: { marginBottom: 28 },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  h3: { color: '#888', fontSize: 12, letterSpacing: 2 },
  smallButton: { padding: '8px 14px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  smallButtonOutline: { padding: '6px 12px', background: 'transparent', border: '1px solid #333', color: '#aaa', borderRadius: 6, cursor: 'pointer', fontSize: 11 },
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: '#111', padding: 16, borderRadius: 8, marginBottom: 12, border: '1px solid #222' },
  input: { padding: '10px 12px', background: '#000', border: '1px solid #333', borderRadius: 6, color: '#fff' },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#ccc' },
  submitButton: { padding: '10px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  cancelButton: { padding: '10px 16px', background: 'transparent', border: '1px solid #ff4d4d', color: '#ff4d4d', borderRadius: 6, cursor: 'pointer' },
  status: { color: '#00e5ff', fontSize: 13 },
  planRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#111', border: '1px solid #1a1a1a', borderRadius: 8, padding: 14, marginBottom: 8 },
  rowTitle: { fontWeight: 600, fontSize: 14 },
  rowSub: { color: '#666', fontSize: 12, marginTop: 2 },
  assignForm: { display: 'flex', flexDirection: 'column', gap: 10, background: '#111', padding: 16, borderRadius: 8, border: '1px solid #222' },
  currentSubBox: { color: '#ccc', fontSize: 13, padding: '8px 0' },
};
