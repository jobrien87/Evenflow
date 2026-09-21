import { useState } from 'react';
import { api } from '../lib/api';
import { Button, Modal } from '../ui';

// Shared by AgencyDetailPage.jsx (Platform Owner editing any agency) and
// AgencyOwnerDashboard.jsx (an Agency Owner editing their own agency) —
// same PATCH /agencies/:id, same form, scoped only by who's allowed to
// open it.
export default function AgencySettingsModal({ agency, onClose, onSaved }) {
  const [form, setForm] = useState({ name: agency.name, timezone: agency.timezone, products: agency.products.join(', ') });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.updateAgency(agency.id, {
        name: form.name,
        timezone: form.timezone,
        products: form.products.split(',').map((p) => p.trim()).filter(Boolean),
      });
      onSaved();
    } catch (error) {
      setErr(error.data?.message || 'Failed to save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="EDIT AGENCY SETTINGS" onClose={onClose}>
      <form onSubmit={submit} style={s.form}>
        <label style={s.fieldLabel}>Name<input style={s.input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
        <label style={s.fieldLabel}>Timezone<input style={s.input} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} /></label>
        <label style={s.fieldLabel}>Products (comma-separated)<input style={s.input} value={form.products} onChange={(e) => setForm({ ...form, products: e.target.value })} /></label>
        {err && <div style={s.error}>{err}</div>}
        <Button variant="primary" type="submit" disabled={busy}>{busy ? 'SAVING…' : 'SAVE'}</Button>
      </form>
    </Modal>
  );
}

const s = {
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  fieldLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--text-muted)' },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)' },
  error: { color: 'var(--danger)', fontSize: 13 },
};
