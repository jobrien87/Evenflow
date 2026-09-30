import { useState } from 'react';
import { api } from '../lib/api';
import { Button, Modal, SectionHeader, LeadTypeIcon } from '../ui';
import { LEAD_TYPE_LABELS } from '../lib/leadTypeMeta';
import BulkLeadUploadBox from './BulkLeadUploadBox';

// Mirrors lib/priority.js's DEFAULT_TYPE_RANK/DEFAULT_STATUS_RULES exactly
// — what an agency that's never touched this section is already getting.
const DEFAULT_TYPE_RANK = ['TRANSFER', 'REFERRAL', 'PAID_AD', 'META_AD', 'INTERNET', 'DIRECT_MAIL', 'MANUAL', 'WINBACK', 'CROSS_SELL'];
const DEFAULT_STATUS_RULES = {
  SOLD: { afterDays: 0, action: 'DROP_OFF' },
  QUOTED: { afterDays: 3, action: 'BUMP_UP' },
  LEFT_VM: { afterDays: 2, action: 'BUMP_UP' },
};
const STATUS_OPTIONS = [
  'NEW', 'CONTACTED', 'LEFT_VM', 'APPOINTMENT',
  'QUOTED', 'QUOTED_HOT', 'FOLLOW_UP', 'SOLD', 'LOST', 'NOT_INTERESTED', 'BAD_CONTACT',
  'DUPLICATE', 'DO_NOT_CONTACT', 'INELIGIBLE', 'ARCHIVED',
];
const ACTION_LABELS = { BUMP_UP: 'Bump up', BUMP_DOWN: 'Bump down', DROP_OFF: 'Drop off' };

// Shared by AgencyDetailPage.jsx (Platform Owner editing any agency) and
// AgencyOwnerDashboard.jsx (an Agency Owner editing their own agency) —
// same PATCH /agencies/:id, same form, scoped only by who's allowed to
// open it.
export default function AgencySettingsModal({ agency, onClose, onSaved }) {
  const [form, setForm] = useState({ name: agency.name, timezone: agency.timezone, products: agency.products.join(', ') });
  const [typeRank, setTypeRank] = useState(agency.priorityRules?.typeRank || DEFAULT_TYPE_RANK);
  const [ruleRows, setRuleRows] = useState(() =>
    Object.entries(agency.priorityRules?.statusRules || DEFAULT_STATUS_RULES)
      .map(([status, r]) => ({ status, afterDays: r.afterDays, action: r.action }))
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function moveType(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= typeRank.length) return;
    const next = [...typeRank];
    [next[index], next[target]] = [next[target], next[index]];
    setTypeRank(next);
  }

  function addRule() {
    const used = new Set(ruleRows.map((r) => r.status));
    const status = STATUS_OPTIONS.find((s) => !used.has(s)) || STATUS_OPTIONS[0];
    setRuleRows([...ruleRows, { status, afterDays: 3, action: 'BUMP_UP' }]);
  }
  function updateRule(i, patch) {
    setRuleRows(ruleRows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeRule(i) {
    setRuleRows(ruleRows.filter((_, idx) => idx !== i));
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const statusRules = Object.fromEntries(
        ruleRows.map((r) => [r.status, { afterDays: Number(r.afterDays) || 0, action: r.action }])
      );
      await api.updateAgency(agency.id, {
        name: form.name,
        timezone: form.timezone,
        products: form.products.split(',').map((p) => p.trim()).filter(Boolean),
        priorityRules: { typeRank, statusRules },
      });
      onSaved();
    } catch (error) {
      setErr(error.data?.message || 'Failed to save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="EDIT AGENCY SETTINGS" onClose={onClose} maxWidth={640}>
      <form onSubmit={submit} style={s.form}>
        <label style={s.fieldLabel}>Name<input style={s.input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
        <label style={s.fieldLabel}>Timezone<input style={s.input} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} /></label>
        <label style={s.fieldLabel}>Products (comma-separated)<input style={s.input} value={form.products} onChange={(e) => setForm({ ...form, products: e.target.value })} /></label>

        <div style={s.divider} />
        <SectionHeader>Lead Priority</SectionHeader>
        <div style={s.helpText}>Which kind of lead your team should work first — reorder from highest (top) to lowest priority.</div>
        <div style={s.typeList}>
          {typeRank.map((type, i) => (
            <div key={type} style={s.typeRow}>
              <span style={s.typeRank}>{i + 1}</span>
              <LeadTypeIcon type={type} style={{ marginRight: 6 }} />
              <span style={s.typeName}>{LEAD_TYPE_LABELS[type] || type}</span>
              <div style={s.typeArrows}>
                <button type="button" style={s.arrowButton} disabled={i === 0} onClick={() => moveType(i, -1)}>▲</button>
                <button type="button" style={s.arrowButton} disabled={i === typeRank.length - 1} onClick={() => moveType(i, 1)}>▼</button>
              </div>
            </div>
          ))}
        </div>

        <div style={s.helpText}>Automatic status rules — bump a lead up, bump it down, or drop it off the active queue after it's sat in that status for N days.</div>
        <div style={s.rulesTable}>
          {ruleRows.map((rule, i) => (
            <div key={i} style={s.ruleRow}>
              <select style={s.select} value={rule.status} onChange={(e) => updateRule(i, { status: e.target.value })}>
                {STATUS_OPTIONS.map((st) => <option key={st} value={st}>{st.replace(/_/g, ' ')}</option>)}
              </select>
              <span style={s.ruleLabel}>after</span>
              <input style={s.miniInput} type="number" min={0} value={rule.afterDays} onChange={(e) => updateRule(i, { afterDays: e.target.value })} />
              <span style={s.ruleLabel}>day(s)</span>
              <select style={s.select} value={rule.action} onChange={(e) => updateRule(i, { action: e.target.value })}>
                {Object.entries(ACTION_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <button type="button" style={s.removeButton} onClick={() => removeRule(i)}>✕</button>
            </div>
          ))}
          <button type="button" style={s.addRuleButton} onClick={addRule}>+ ADD RULE</button>
        </div>

        {err && <div style={s.error}>{err}</div>}
        <Button variant="primary" type="submit" disabled={busy}>{busy ? 'SAVING…' : 'SAVE'}</Button>
      </form>

      <div style={s.divider} />
      <SectionHeader>Upload Leads</SectionHeader>
      <BulkLeadUploadBox agencyId={agency.id} />
    </Modal>
  );
}

const s = {
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-muted)' },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  error: { color: 'var(--danger)', fontSize: 13 },
  divider: { borderTop: '1px solid var(--border-hairline)', margin: '20px 0 16px' },
  helpText: { color: 'var(--text-muted)', fontSize: 11, marginBottom: 8, lineHeight: 1.5 },
  typeList: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 },
  typeRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 6 },
  typeRank: { color: 'var(--text-muted)', fontSize: 11, width: 16 },
  typeName: { flex: 1, color: 'var(--text-primary)', fontSize: 13 },
  typeArrows: { display: 'flex', gap: 4 },
  arrowButton: { background: 'none', border: '1px solid var(--border-strong)', borderRadius: 4, color: 'var(--text-secondary)', cursor: 'pointer', width: 22, height: 22, fontSize: 10 },
  rulesTable: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 },
  ruleRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  ruleLabel: { color: 'var(--text-muted)', fontSize: 11 },
  select: { padding: '6px 8px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 },
  miniInput: { padding: '6px 8px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, width: 56 },
  removeButton: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 },
  addRuleButton: { alignSelf: 'flex-start', background: 'none', border: '1px dashed var(--border-strong)', borderRadius: 6, color: 'var(--accent)', cursor: 'pointer', fontSize: 11, padding: '6px 10px' },
};
