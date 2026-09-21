import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Badge, Button, SectionHeader } from '../ui';

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

  if (!billingStatus) return <div style={{ color: 'var(--text-muted)' }}>Loading…</div>;

  return (
    <div style={s.wrap}>
      <div style={s.modeBanner(billingStatus.mode)}>
        {billingStatus.mode === 'MANUAL' ? billingStatus.note : 'Payment processor connected, automated billing active.'}
      </div>

      <section style={s.section}>
        <SectionHeader
          right={<Button variant="primary" size="sm" onClick={() => setShowPlanForm(!showPlanForm)}>+ NEW PLAN</Button>}
        >
          PLANS ({plans.length})
        </SectionHeader>

        {showPlanForm && (
          <Card style={s.formCard}>
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
              <Button variant="primary" type="submit">Create Plan</Button>
            </form>
          </Card>
        )}

        {plans.map((p) => (
          <Card key={p.id} style={s.planCard} className="ui-row-stack">
            <div style={s.planRow}>
              <div>
                <div style={s.rowTitle}>{p.name} — ${(p.priceCents / 100).toFixed(2)}/{p.interval === 'MONTHLY' ? 'mo' : 'yr'}</div>
                <div style={s.rowSub}>
                  {[p.crmEnabled && 'CRM', p.transfersEnabled && 'Transfers', p.coachingEnabled && 'Coaching'].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Badge tone={p.isActive ? 'accent' : 'neutral'}>{p.isActive ? 'ACTIVE' : 'INACTIVE'}</Badge>
                <Button variant="secondary" size="sm" onClick={() => togglePlanActive(p)}>{p.isActive ? 'DEACTIVATE' : 'ACTIVATE'}</Button>
              </div>
            </div>
          </Card>
        ))}
      </section>

      <section style={s.section}>
        <SectionHeader>ASSIGN PLAN TO AGENCY</SectionHeader>
        <Card style={s.assignForm}>
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
                  <span style={{ color: 'var(--text-secondary)' }}>No active subscription, agency is on default (CRM only) access.</span>
                )}
              </div>
              <select style={s.input} value={selectedPlanId} onChange={(e) => setSelectedPlanId(e.target.value)}>
                <option value="">Select new plan…</option>
                {plans.filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="primary" onClick={assign} disabled={!selectedPlanId}>ASSIGN PLAN</Button>
                {currentSub && <Button variant="danger" onClick={cancel}>CANCEL SUBSCRIPTION</Button>}
              </div>
              {status && <div style={s.status}>{status}</div>}
            </>
          )}
        </Card>
      </section>
    </div>
  );
}

const s = {
  wrap: {},
  modeBanner: (mode) => ({
    background: mode === 'MANUAL' ? 'var(--warning-soft)' : 'var(--accent-gradient-soft)', border: `1px solid ${mode === 'MANUAL' ? 'rgba(255, 184, 77, 0.4)' : 'var(--border-accent)'}`,
    color: mode === 'MANUAL' ? 'var(--warning)' : 'var(--accent)', padding: 12, borderRadius: 8, fontSize: 12, marginBottom: 20,
  }),
  section: { marginBottom: 28 },
  formCard: { marginBottom: 12 },
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  checkboxRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)' },
  status: { color: 'var(--accent)', fontSize: 13 },
  planCard: { marginBottom: 8 },
  planRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  rowTitle: { fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' },
  rowSub: { color: 'var(--text-muted)', fontSize: 12, marginTop: 2 },
  assignForm: { display: 'flex', flexDirection: 'column', gap: 10 },
  currentSubBox: { color: 'var(--text-secondary)', fontSize: 13, padding: '8px 0' },
};
