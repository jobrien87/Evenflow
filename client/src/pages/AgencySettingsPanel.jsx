import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';

const PRODUCTS = ['Auto', 'Home', 'Life', 'Health'];

export default function AgencySettingsPanel() {
  const { user } = useAuth();
  const [agency, setAgency] = useState(null);
  const [form, setForm] = useState(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const data = await api.agencies();
    const mine = data.agencies.find((a) => a.id === user.agencyId) || data.agencies[0];
    setAgency(mine);
    if (mine) {
      setForm({
        transfersEnabled: mine.transfersEnabled,
        transferPaused: mine.transferPaused,
        products: mine.products || [],
        transferStates: mine.transferStates || [],
        transferDailyCap: mine.transferDailyCap || '',
        transferFeeCents: mine.transferFeeCents ? (mine.transferFeeCents / 100).toString() : '',
      });
    }
  }

  function toggleProduct(p) {
    setForm((f) => ({
      ...f,
      products: f.products.includes(p) ? f.products.filter((x) => x !== p) : [...f.products, p],
    }));
  }

  async function save(e) {
    e.preventDefault();
    setStatus('Saving…');
    try {
      await api.updateTransferSettings(agency.id, {
        transfersEnabled: form.transfersEnabled,
        transferPaused: form.transferPaused,
        products: form.products,
        transferStates: form.transferStates,
        transferDailyCap: form.transferDailyCap ? parseInt(form.transferDailyCap, 10) : null,
        transferFeeCents: form.transferFeeCents ? Math.round(parseFloat(form.transferFeeCents) * 100) : null,
      });
      setStatus('Saved. These settings now control real transfer routing.');
      await load();
    } catch (err) {
      setStatus(err.data?.message || 'Failed to save settings.');
    }
  }

  if (!agency || !form) return <div style={{ color: '#666' }}>Loading…</div>;

  return (
    <div style={s.wrap}>
      <h3 style={s.h3}>YIELD TRANSFERS AVAILABILITY</h3>
      <p style={s.helpText}>
        This is what the routing engine actually checks before offering your agency a transfer.
        Nothing here is cosmetic. If "Accept Transfers" is off, this agency will never be routed a lead.
      </p>

      <form onSubmit={save} style={s.form}>
        <label style={s.toggleRow}>
          <input type="checkbox" checked={form.transfersEnabled} onChange={(e) => setForm({ ...form, transfersEnabled: e.target.checked })} />
          <span>Accept Yield Transfers</span>
        </label>

        <label style={s.toggleRow}>
          <input type="checkbox" checked={form.transferPaused} onChange={(e) => setForm({ ...form, transferPaused: e.target.checked })} />
          <span>Temporarily pause (keeps transfers enabled, but routes around this agency for now)</span>
        </label>

        <div style={s.fieldGroup}>
          <label style={s.label}>Products accepted (none selected = accept all)</label>
          <div style={s.chipRow}>
            {PRODUCTS.map((p) => (
              <button type="button" key={p} style={s.chip(form.products.includes(p))} onClick={() => toggleProduct(p)}>
                {p}
              </button>
            ))}
          </div>
        </div>

        <div style={s.fieldGroup}>
          <label style={s.label}>States accepted, comma-separated 2-letter codes (blank = accept all)</label>
          <input
            style={s.input}
            placeholder="e.g. FL, GA, TX"
            value={form.transferStates.join(', ')}
            onChange={(e) =>
              setForm({
                ...form,
                transferStates: e.target.value.split(',').map((x) => x.trim().toUpperCase()).filter((x) => x.length === 2),
              })
            }
          />
        </div>

        <div style={s.fieldGroup}>
          <label style={s.label}>Daily transfer cap (blank = unlimited)</label>
          <input style={s.input} type="number" min="1" value={form.transferDailyCap} onChange={(e) => setForm({ ...form, transferDailyCap: e.target.value })} />
        </div>

        <div style={s.fieldGroup}>
          <label style={s.label}>Fee charged per accepted transfer, in dollars (blank = no fee tracked)</label>
          <input style={s.input} type="number" step="0.01" min="0" value={form.transferFeeCents} onChange={(e) => setForm({ ...form, transferFeeCents: e.target.value })} />
        </div>

        <button style={s.saveButton} type="submit">SAVE SETTINGS</button>
      </form>

      {status && <div style={s.status}>{status}</div>}
    </div>
  );
}

const s = {
  wrap: { maxWidth: 480 },
  h3: { color: '#888', fontSize: 12, letterSpacing: 2, marginBottom: 8 },
  helpText: { color: '#666', fontSize: 12, marginBottom: 16, lineHeight: 1.5 },
  form: { display: 'flex', flexDirection: 'column', gap: 16, background: '#111', padding: 20, borderRadius: 8, border: '1px solid #222' },
  toggleRow: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#fff', cursor: 'pointer' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { color: '#999', fontSize: 12 },
  input: { padding: '10px 12px', background: '#000', border: '1px solid #333', borderRadius: 6, color: '#fff' },
  chipRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  chip: (active) => ({
    padding: '6px 12px', borderRadius: 6, border: active ? 'none' : '1px solid #333', cursor: 'pointer', fontSize: 12,
    background: active ? '#00e5ff' : 'transparent', color: active ? '#000' : '#aaa', fontWeight: active ? 700 : 400,
  }),
  saveButton: { padding: '12px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  status: { color: '#00e5ff', marginTop: 12, fontSize: 13 },
};
