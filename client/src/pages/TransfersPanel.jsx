import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import ChatThread from './ChatThread';

const DISPOSITIONS = ['CONTACTED', 'QUOTE_STARTED', 'QUOTED', 'SOLD', 'FOLLOW_UP', 'NOT_INTERESTED', 'BAD_CONTACT', 'DUPLICATE', 'NOT_ELIGIBLE', 'DISCONNECTED', 'OTHER'];

export default function TransfersPanel() {
  const [transfers, setTransfers] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [discussTransfer, setDiscussTransfer] = useState(null);
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight');
  const handledHighlightRef = useRef(false);

  useEffect(() => {
    load();
    const interval = setInterval(load, 8000); // near-real-time refresh for offered transfers
    return () => clearInterval(interval);
  }, []);

  // Destination side of notification deep-linking: scroll to and highlight
  // the specific transfer a notification pointed at, opening the chat
  // thread directly for a "new message" notification instead of making the
  // person hunt for the row and click DISCUSS themselves.
  useEffect(() => {
    if (!highlightId || handledHighlightRef.current || transfers.length === 0) return;
    const match = transfers.find((t) => t.id === highlightId);
    if (!match) return;
    handledHighlightRef.current = true;
    document.getElementById(`transfer-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (searchParams.get('action') === 'chat') setDiscussTransfer(match);
  }, [highlightId, transfers, searchParams]);

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
            <div key={t.id} id={`transfer-${t.id}`} style={t.id === highlightId ? { ...s.alertCard, ...s.rowHighlighted } : s.alertCard}>
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
                <button style={s.smallButtonOutline} onClick={() => setDiscussTransfer(t)}>
                  DISCUSS
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
            <div key={t.id} id={`transfer-${t.id}`} style={t.id === highlightId ? { ...s.row, ...s.rowHighlighted } : s.row} className="ui-row-stack">
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
                <button style={s.smallButtonOutline} onClick={() => setDiscussTransfer(t)}>
                  DISCUSS
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section style={s.section}>
        <h3 style={s.h3}>ALL TRANSFERS ({rest.length})</h3>
        {rest.map((t) => (
          <div key={t.id} id={`transfer-${t.id}`} style={t.id === highlightId ? { ...s.row, ...s.rowHighlighted } : s.row} className="ui-row-stack">
            <div>
              <div style={s.rowTitle}>{t.firstName} {t.lastName}</div>
              <div style={s.rowSub}>{t.product} · {t.state}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={s.badge}>{t.status.replace(/_/g, ' ')}{t.disposition ? ` · ${t.disposition}` : ''}</div>
              {t.status === 'DISPOSITIONED' && <CreditRequestForm transferId={t.id} onDone={load} />}
              <button style={s.smallButtonOutline} onClick={() => setDiscussTransfer(t)}>
                DISCUSS
              </button>
            </div>
          </div>
        ))}
        {rest.length === 0 && offered.length === 0 && active.length === 0 && <div style={s.empty}>No transfers yet.</div>}
      </section>

      {discussTransfer && (
        <ChatThread
          entityType="TRANSFER"
          entityId={discussTransfer.id}
          title={`DISCUSS · ${discussTransfer.firstName} ${discussTransfer.lastName}`}
          onClose={() => setDiscussTransfer(null)}
        />
      )}
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

  if (done) return <span style={{ fontSize: 11, color: 'var(--warning)' }}>Credit requested</span>;

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
  h3: { color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 2, marginBottom: 12 },
  error: { color: 'var(--danger)', marginBottom: 12, fontSize: 13 },
  // The destination side of notification deep-linking — briefly draws the
  // eye to whichever transfer a notification pointed at.
  rowHighlighted: { outline: '2px solid var(--accent)', boxShadow: 'var(--shadow-glow-accent)', borderRadius: 'var(--radius-md)' },
  alertCard: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', borderRadius: 10, padding: 16, marginBottom: 10 },
  alertTitle: { fontWeight: 700, fontSize: 18 },
  alertSub: { color: 'var(--text-secondary)', fontSize: 13, marginTop: 2 },
  alertNotes: { color: 'var(--text-secondary)', fontSize: 12, marginTop: 6, fontStyle: 'italic' },
  actionsRow: { display: 'flex', gap: 8, marginTop: 12 },
  acceptButton: { flex: 1, padding: '10px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer' },
  rejectButton: { padding: '10px 16px', background: 'transparent', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: 6, cursor: 'pointer' },
  smallButton: { padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12 },
  smallButtonOutline: { padding: '6px 12px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, cursor: 'pointer', fontSize: 11 },
  miniInput: { padding: '6px 8px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 14, marginBottom: 8 },
  rowTitle: { fontWeight: 600, fontSize: 14 },
  rowSub: { color: 'var(--text-muted)', fontSize: 12 },
  badge: { fontSize: 11, color: 'var(--text-secondary)', border: '1px solid var(--border-strong)', padding: '4px 8px', borderRadius: 4 },
  empty: { color: 'var(--text-muted)', fontStyle: 'italic' },
};
