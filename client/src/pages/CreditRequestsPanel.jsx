import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function CreditRequestsPanel() {
  const [requests, setRequests] = useState([]);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const data = await api.creditRequests();
    setRequests(data.creditRequests);
  }

  async function decide(id, decision) {
    setBusyId(id);
    try {
      const notes = decision === 'DENIED' ? (prompt('Reason for denial (optional):') || '') : '';
      await api.decideCredit(id, { decision, notes });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  const pending = requests.filter((r) => r.status === 'REQUESTED');
  const decided = requests.filter((r) => r.status !== 'REQUESTED');

  return (
    <div style={s.wrap}>
      <section style={s.section}>
        <h3 style={s.h3}>PENDING CREDIT REQUESTS ({pending.length})</h3>
        {pending.map((r) => (
          <div key={r.id} style={s.card}>
            <div style={s.cardTitle}>{r.transfer.firstName} {r.transfer.lastName} · {r.transfer.product}</div>
            <div style={s.reason}>{r.reason}</div>
            <div style={s.meta}>Requested {new Date(r.createdAt).toLocaleString()}</div>
            <div style={s.actionsRow}>
              <button style={s.approveButton} disabled={busyId === r.id} onClick={() => decide(r.id, 'APPROVED')}>
                APPROVE
              </button>
              <button style={s.denyButton} disabled={busyId === r.id} onClick={() => decide(r.id, 'DENIED')}>
                DENY
              </button>
            </div>
          </div>
        ))}
        {pending.length === 0 && <div style={s.empty}>No pending credit requests.</div>}
      </section>

      <section style={s.section}>
        <h3 style={s.h3}>DECIDED ({decided.length})</h3>
        {decided.map((r) => (
          <div key={r.id} style={s.row} className="ui-row-stack">
            <div>
              <div style={s.rowTitle}>{r.transfer.firstName} {r.transfer.lastName}</div>
              <div style={s.rowSub}>{r.reason}</div>
            </div>
            <div style={s.badge(r.status)}>{r.status}</div>
          </div>
        ))}
        {decided.length === 0 && <div style={s.empty}>No decided requests yet.</div>}
      </section>
    </div>
  );
}

const s = {
  wrap: {},
  section: { marginBottom: 28 },
  h3: { color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 2, marginBottom: 12 },
  card: { background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 16, marginBottom: 10 },
  cardTitle: { fontWeight: 700, fontSize: 15 },
  reason: { color: 'var(--text-secondary)', fontSize: 13, marginTop: 6 },
  meta: { color: 'var(--text-muted)', fontSize: 11, marginTop: 6 },
  actionsRow: { display: 'flex', gap: 8, marginTop: 12 },
  approveButton: { flex: 1, padding: '8px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  denyButton: { padding: '8px 14px', background: 'transparent', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: 6, cursor: 'pointer', fontSize: 12 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 14, marginBottom: 8 },
  rowTitle: { fontWeight: 600, fontSize: 14 },
  rowSub: { color: 'var(--text-muted)', fontSize: 12 },
  badge: (status) => ({
    fontSize: 11, padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border-strong)',
    color: status === 'APPROVED' ? 'var(--accent)' : status === 'DENIED' ? 'var(--danger)' : 'var(--text-secondary)',
  }),
  empty: { color: 'var(--text-muted)', fontStyle: 'italic' },
};
