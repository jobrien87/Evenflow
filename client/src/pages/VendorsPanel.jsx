import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function VendorsPanel() {
  const [vendors, setVendors] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', product: 'Auto', costPerLeadCents: '' });
  const [newKeyResult, setNewKeyResult] = useState(null);
  const [selectedVendor, setSelectedVendor] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [instructionsVendor, setInstructionsVendor] = useState(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const data = await api.vendors();
    setVendors(data.vendors);
  }

  async function submit(e) {
    e.preventDefault();
    try {
      const res = await api.createVendor({
        ...form,
        costPerLeadCents: form.costPerLeadCents ? Math.round(parseFloat(form.costPerLeadCents) * 100) : undefined,
      });
      setNewKeyResult(res);
      setForm({ name: '', email: '', product: 'Auto', costPerLeadCents: '' });
      setShowForm(false);
      await load();
    } catch (err) {
      alert(err.data?.message || 'Failed to create vendor.');
    }
  }

  async function viewDetail(vendor) {
    setSelectedVendor(vendor);
    const data = await api.vendorTransactions(vendor.id);
    setTransactions(data.transactions);
  }

  async function rotate(id) {
    const res = await api.rotateVendorCredential(id);
    setNewKeyResult({ vendor: vendors.find((v) => v.id === id), apiKey: res.apiKey, instructions: null });
    await load();
  }

  async function setStatus(id, status) {
    await api.setVendorStatus(id, status);
    await load();
  }

  async function viewInstructions(id) {
    const data = await api.vendorDetail(id);
    setInstructionsVendor(data);
  }

  async function revoke(id) {
    if (!confirm('Revoke this vendor\'s API credential? They will not be able to post leads until you rotate a new one.')) return;
    await api.revokeVendorCredential(id);
    await load();
  }

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <h3 style={s.h3}>VENDORS ({vendors.length})</h3>
        <button style={s.button} onClick={() => setShowForm(!showForm)}>+ SEND POSTING INSTRUCTIONS</button>
      </div>

      {showForm && (
        <form onSubmit={submit} style={s.form}>
          <input style={s.input} placeholder="Vendor name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <input style={s.input} type="email" placeholder="Vendor email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          <select style={s.input} value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })}>
            <option>Auto</option><option>Home</option><option>Life</option><option>Health</option>
          </select>
          <input
            style={s.input}
            type="number"
            step="0.01"
            min="0"
            placeholder="Cost per lead in dollars (optional — leave blank if not tracked)"
            value={form.costPerLeadCents}
            onChange={(e) => setForm({ ...form, costPerLeadCents: e.target.value })}
          />
          <button style={s.submitButton} type="submit">Create Vendor & Send Instructions</button>
        </form>
      )}

      {newKeyResult && (
        <div style={s.keyBox}>
          <div style={s.keyWarning}>⚠ This API key is shown once. Copy it now — it cannot be retrieved again.</div>
          <code style={s.keyCode}>{newKeyResult.apiKey}</code>
          <div style={s.keySub}>Email status: {newKeyResult.emailStatus || 'n/a'}</div>
          <button style={s.dismissButton} onClick={() => setNewKeyResult(null)}>Dismiss</button>
        </div>
      )}

      {vendors.map((v) => (
        <div key={v.id} style={s.row}>
          <div style={{ flex: 1 }}>
            <div style={s.rowTitle}>{v.name} · {v.product}</div>
            <div style={s.rowSub}>{v.email}</div>
          </div>
          <select style={s.miniInput} value={v.status} onChange={(e) => setStatus(v.id, e.target.value)}>
            <option value="PENDING">PENDING</option>
            <option value="TESTING">TESTING</option>
            <option value="VERIFIED">VERIFIED</option>
            <option value="LIVE">LIVE</option>
            <option value="PAUSED">PAUSED</option>
          </select>
          <button style={s.smallButton} onClick={() => rotate(v.id)}>ROTATE KEY</button>
          <button style={s.smallButtonOutline} onClick={() => viewInstructions(v.id)}>VIEW INSTRUCTIONS</button>
          <button style={s.smallButtonOutline} onClick={() => revoke(v.id)}>REVOKE</button>
          <button style={s.smallButtonOutline} onClick={() => viewDetail(v)}>LOGS</button>
        </div>
      ))}
      {vendors.length === 0 && <div style={s.empty}>No vendors connected yet.</div>}

      {selectedVendor && (
        <div style={s.section}>
          <h3 style={s.h3}>API TRANSACTIONS — {selectedVendor.name}</h3>
          {transactions.map((t) => (
            <div key={t.id} style={s.txRow}>
              <span style={s.txCode(t.resultCode)}>{t.resultCode}</span>
              <span style={s.txMeta}>{t.statusCode} · {t.latencyMs}ms · {new Date(t.createdAt).toLocaleString()}</span>
            </div>
          ))}
          {transactions.length === 0 && <div style={s.empty}>No API activity yet.</div>}
        </div>
      )}

      {instructionsVendor && (
        <div style={s.modalOverlay} onClick={() => setInstructionsVendor(null)}>
          <div style={s.modal} onClick={(e) => e.stopPropagation()}>
            <div style={s.headerRow}>
              <h3 style={s.h3}>POSTING INSTRUCTIONS — {instructionsVendor.vendor.name}</h3>
              <button style={s.smallButtonOutline} onClick={() => setInstructionsVendor(null)}>CLOSE</button>
            </div>
            <div style={s.instructionsBlock}>
              <div><strong>Endpoint:</strong> {instructionsVendor.instructions.method} {instructionsVendor.instructions.endpoint}</div>
              <div style={{ marginTop: 8 }}><strong>Auth:</strong> {instructionsVendor.instructions.authentication}</div>
              <div style={{ marginTop: 12 }}><strong>curl example:</strong></div>
              <pre style={s.pre}>{instructionsVendor.instructions.curlExample}</pre>
              <div style={{ marginTop: 12 }}><strong>Test procedure:</strong></div>
              <ol style={{ color: '#aaa', fontSize: 12, paddingLeft: 20 }}>
                {instructionsVendor.instructions.testProcedure.map((step, i) => <li key={i} style={{ marginBottom: 4 }}>{step}</li>)}
              </ol>
              <div style={{ color: '#ffb84d', fontSize: 11, marginTop: 12 }}>
                Note: the API key shown here is a placeholder — the real key was only ever shown once, at creation or last rotation.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const txColor = (code) => (code === 'SUCCESS' ? '#00e5ff' : code === 'DUPLICATE' ? '#ffb84d' : '#ff4d4d');

const s = {
  wrap: {},
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  h3: { color: '#888', fontSize: 12, letterSpacing: 2 },
  button: { padding: '10px 16px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  form: { display: 'flex', flexDirection: 'column', gap: 10, background: '#111', padding: 16, borderRadius: 8, marginBottom: 16, border: '1px solid #222' },
  input: { padding: '10px 12px', background: '#000', border: '1px solid #333', borderRadius: 6, color: '#fff' },
  submitButton: { padding: '10px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  keyBox: { background: '#0d1a1a', border: '1px solid #00e5ff55', borderRadius: 8, padding: 16, marginBottom: 16 },
  keyWarning: { color: '#ffb84d', fontSize: 12, marginBottom: 8, fontWeight: 700 },
  keyCode: { display: 'block', background: '#000', padding: 10, borderRadius: 6, color: '#00e5ff', fontSize: 12, wordBreak: 'break-all', marginBottom: 8 },
  keySub: { color: '#888', fontSize: 12, marginBottom: 8 },
  dismissButton: { padding: '6px 12px', background: 'transparent', border: '1px solid #333', color: '#aaa', borderRadius: 6, cursor: 'pointer', fontSize: 11 },
  row: { display: 'flex', alignItems: 'center', gap: 8, background: '#111', border: '1px solid #1a1a1a', borderRadius: 8, padding: 14, marginBottom: 8 },
  rowTitle: { fontWeight: 600, fontSize: 14 },
  rowSub: { color: '#666', fontSize: 12 },
  miniInput: { padding: '6px 8px', background: '#000', border: '1px solid #333', borderRadius: 6, color: '#fff', fontSize: 11 },
  smallButton: { padding: '6px 10px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11 },
  smallButtonOutline: { padding: '6px 10px', background: 'transparent', border: '1px solid #333', color: '#aaa', borderRadius: 6, cursor: 'pointer', fontSize: 11 },
  empty: { color: '#666', fontStyle: 'italic' },
  section: { marginTop: 24 },
  txRow: { display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #1a1a1a', fontSize: 12 },
  txCode: (code) => ({ color: txColor(code), fontWeight: 700 }),
  txMeta: { color: '#666' },
  modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000 },
  modal: { background: '#111', border: '1px solid #333', borderRadius: 12, padding: 20, maxWidth: 560, width: '90%', maxHeight: '80vh', overflowY: 'auto' },
  instructionsBlock: { color: '#ccc', fontSize: 13, lineHeight: 1.6 },
  pre: { background: '#000', border: '1px solid #222', borderRadius: 6, padding: 12, fontSize: 11, color: '#00e5ff', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
};
