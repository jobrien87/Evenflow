import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Modal, Button } from '../ui';
import { LEAD_TYPE_LABELS } from '../lib/leadTypeMeta';

// A Producer's own, simpler "Add a Lead" — mirrors AgencyLeadsPanel.jsx's
// inline form fields (First/Last name, phone, email, product, Lead
// Source), but deliberately drops what an Owner/Manager's version has
// that doesn't apply here: the live-transfer checkbox (server already
// ignores it for this role), the vendor picker (GET /vendors is
// Owner/Manager/Platform-Owner-only and carries cost-per-lead data), and
// any assignee picker (a Producer has no reason to hand a lead to someone
// else). Always self-assigns — createLeadRecord has no auto-assign-to-self
// fallback, so omitting assignedToId here would create an unassigned lead
// that never shows up in the Producer's own "My Leads" list.
export default function AddLeadModal({ onClose, onSaved }) {
  const { user } = useAuth();
  const [form, setForm] = useState({ firstName: '', lastName: '', phone: '', email: '', product: 'Auto', leadTypeOverride: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.createLead({ ...form, assignedToId: user.id });
      onSaved();
      onClose();
    } catch (err) {
      setError(err.data?.message || 'Failed to create lead.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="ADD A LEAD" onClose={onClose}>
      <form onSubmit={submit} style={s.form}>
        <input style={s.input} placeholder="First name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required autoFocus />
        <input style={s.input} placeholder="Last name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} required />
        <input style={s.input} placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <input style={s.input} type="email" placeholder="Email (optional)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <select style={s.input} value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })}>
          <option>Auto</option><option>Home</option><option>Home and Auto Bundle</option><option>Life</option><option>Health</option><option>Boat</option><option>Motorcycle</option>
        </select>
        <select style={s.input} value={form.leadTypeOverride} onChange={(e) => setForm({ ...form, leadTypeOverride: e.target.value })}>
          <option value="">Lead Source — auto-detect</option>
          {Object.entries(LEAD_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {error && <div style={s.error}>{error}</div>}
        <Button type="submit" disabled={busy}>{busy ? 'CREATING…' : 'CREATE LEAD'}</Button>
      </form>
    </Modal>
  );
}

const s = {
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  error: { color: 'var(--danger)', fontSize: 12 },
};
