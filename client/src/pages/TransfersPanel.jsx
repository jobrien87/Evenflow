import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const DISPOSITIONS = ['CONTACTED', 'QUOTE_STARTED', 'QUOTED', 'SOLD', 'FOLLOW_UP', 'NOT_INTERESTED', 'BAD_CONTACT', 'DUPLICATE', 'NOT_ELIGIBLE', 'DISCONNECTED', 'OTHER'];

export default function TransfersPanel() {
  const [transfers, setTransfers] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    load();
    const interval = setInterval(load, 8000); // near-real-time refresh for offered transfers
    return () => clearInterval(interval);
  }, []);

  async function load() {
    const data = await api.transfers();
    setTransfers(data.transfers);
  }

  async function act(fn, id, ...args) {
    setBusyId(id);
    setError('');
    try {
      await fn(id, ...args);
      await load();
    } catch (err) {
      setError(err.data?.message || err.data?.error || 'Action failed.');
    } finally {
      setBusyId(null);
    }
  }

  const offered = transfers.filter((t) => t.status === 'OFFERED');
  const active = transfers.filter((t) => ['ACCEPTED', 'CONNECTED', 'COMPLETED'].includes(t.status));
  const rest = transfers.filter((t) => !offered.includes(t) && !active.includes(t));

  return (
    <div style={s.wrap}>
      {error && <div style={s.error}>{error}</div>}

      {offered.length > 0 && (
        <section style={s.section}>
          <h3 style={s.h3}>TRANSFER ALERT{offered.length > 1 ? 'S' : ''}</h3>
          {offered.map((t) => (
            <div key={t.id} style={s.alertCard}>
              <div style={s.alertTitle}>{t.firstName} {t.lastName}</div>
              <div style={s.alertSub}>{t.product} · {t.state} · {t.createdByTM?.firstName} {t.createdByTM?.lastName}</div>
              {t.notes && <div style={s.alertNotes}>{t.notes}</div>}
              <div style={s.actionsRow}>
                <button style={s.acceptButton} disabled={busyId === t.id} onClick={() => act(api.acceptTransfer, t.id)}>
                  ACCEPT
                </button>
                <button
                  style={s.rejectButton}
                  disabled={busyId === t.id}
                  onClick={() => {
                    const reason = prompt('Reason for rejecting this transfer:');
                    if (reason) act(api.rejectTransfer, t.id, reason);
                  }}
                >
                  REJECT
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {active.length > 0 && (
        <section style={s.section}>
          <h3 style={s.h3}>ACTIVE</h3>
          {active.map((t) => (
            <div key={t.id} style={s.row}>
              <div>
                <div style={s.rowTitle}>{t.firstName} {t.lastName}</div>
                <div style={s.rowSub}>{t.product} · {t.state} · {t.status}</div>
              </div>
              <div style={s.actionsRow}>
                {t.status === 'ACCEPTED' && (
                  <button style={s.smallButton} disabled={busyId === t.id} onClick={() => act(api.connectTransfer, t.id)}>
                    MARK CONNECTED
                  </button>
                )}
                {t.status === 'CONNECTED' && (
                  <button style={s.smallButton} disabled={busyId === t.id} onClick={() => act(api.completeTransfer, t.id)}>
                    MARK COMPLETE
                  </button>
                )}
                {t.status === 'COMPLETED' && (
                  <DispositionForm transferId={t.id} onDone={load} />
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      <section style={s.section}>
        <h3 style={s.h3}>ALL TRANSFERS ({rest.length})</h3>
        {rest.map((t) => (
          <div key={t.id} style={s.row}>
            <div>
              <div style={s.rowTitle}>{t.firstName} {t.lastName}</div>
              <div style={s.rowSub}>{t.product} · {t.state}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={s.badge}>{t.status.replace(/_/g, ' ')}{t.disposition ? ` · ${t.disposition}` : ''}</div>
              {t.status === 'DISPOSITIONED' && <CreditRequestForm transferId={t.id} onDone={load} />}
            </div>
          </div>
        ))}
        {rest.length === 0 && offered.length === 0 && active.length === 0 && <div style={s.empty}>No transfers yet.</div>}
      </section>
    </div>
  );
}

function DispositionForm({ transferId, onDone }) {
  const [disposition, setDisposition] = useState('SOLD');
  const [premium, setPremium] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.dispositionTransfer(transferId, {
        disposition,
        salePremiumCents: disposition === 'SOLD' && premium ? Math.round(parseFloat(premium) * 100) : undefined,
      });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <select style={s.miniInput} value={disposition} onChange={(e) => setDisposition(e.target.value)}>
        {DISPOSITIONS.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
      {disposition === 'SOLD' && (
        <input style={s.miniInput} placeholder="Premium $" value={premium} onChange={(e) => setPremium(e.target.value)} />
      )}
      <button style={s.smallButton} disabled={busy} onClick={submit}>SAVE</button>
    </div>
  );
}

function CreditRequestForm({ transferId, onDone }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (done) return <span style={{ fontSize: 11, color: '#ffb84d' }}>Credit requested</span>;

  if (!open) {
    return (
      <button style={s.smallButtonOutline} onClick={() => setOpen(true)}>
        REQUEST CREDIT
      </button>
    );
  }

  async function submit() {
    setBusy(true);
    try {
      await api.requestCredit(transferId, { reason });
      setDone(true);
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input style={s.miniInput} placeholder="Reason for credit" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button style={s.smallButton} disabled={busy || !reason} onClick={submit}>SUBMIT</button>
    </div>
  );
}

const s = {
  wrap: {},
  section: { marginBottom: 24 },
  h3: { color: '#888', fontSize: 12, letterSpacing: 2, marginBottom: 12 },
  error: { color: '#ff4d4d', marginBottom: 12, fontSize: 13 },
  alertCard: { background: '#1a0d0d', border: '1px solid #ff4d4d55', borderRadius: 10, padding: 16, marginBottom: 10 },
  alertTitle: { fontWeight: 700, fontSize: 18 },
  alertSub: { color: '#aaa', fontSize: 13, marginTop: 2 },
  alertNotes: { color: '#888', fontSize: 12, marginTop: 6, fontStyle: 'italic' },
  actionsRow: { display: 'flex', gap: 8, marginTop: 12 },
  acceptButton: { flex: 1, padding: '10px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  rejectButton: { padding: '10px 16px', background: 'transparent', border: '1px solid #ff4d4d', color: '#ff4d4d', borderRadius: 6, cursor: 'pointer' },
  smallButton: { padding: '6px 12px', background: '#00e5ff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  smallButtonOutline: { padding: '6px 12px', background: 'transparent', border: '1px solid #333', color: '#aaa', borderRadius: 6, cursor: 'pointer', fontSize: 11 },
  miniInput: { padding: '6px 8px', background: '#000', border: '1px solid #333', borderRadius: 6, color: '#fff', fontSize: 12 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#111', border: '1px solid #1a1a1a', borderRadius: 8, padding: 14, marginBottom: 8 },
  rowTitle: { fontWeight: 600, fontSize: 14 },
  rowSub: { color: '#666', fontSize: 12 },
  badge: { fontSize: 11, color: '#888', border: '1px solid #333', padding: '4px 8px', borderRadius: 4 },
  empty: { color: '#666', fontStyle: 'italic' },
};
