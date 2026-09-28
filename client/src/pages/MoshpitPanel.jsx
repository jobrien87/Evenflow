import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Card, Badge, Button, SectionHeader, EmptyState } from '../ui';

// Polls the claimable pool the same way NotificationBell polls unread
// counts — new Moshpit leads (and other producers claiming them) need to
// show up without a manual refresh, since this is a first-come-first-
// served race by design.
const POLL_MS = 15000;

function InfoRow({ icon, children }) {
  if (!children) return null;
  return <div style={s.infoRow}><span style={s.infoIcon}>{icon}</span>{children}</div>;
}

export default function MoshpitPanel() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [claimingId, setClaimingId] = useState(null);
  const [conflictMessage, setConflictMessage] = useState('');
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get('highlight');
  const handledHighlightRef = useRef(false);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  // Destination side of notification deep-linking — a lead.moshpit_available
  // notification only makes sense to jump to while the lead is still
  // unclaimed; if it's gone by the time the producer clicks, there's simply
  // nothing to scroll to (already handled by another producer).
  useEffect(() => {
    if (!highlightId || handledHighlightRef.current || leads.length === 0) return;
    if (!leads.some((l) => l.id === highlightId)) return;
    handledHighlightRef.current = true;
    document.getElementById(`moshpit-lead-${highlightId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightId, leads]);

  async function load() {
    setError('');
    try {
      const data = await api.moshpitLeads();
      setLeads(data.leads);
    } catch (err) {
      setError(err.data?.message || 'Could not load the Moshpit. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }

  async function claim(leadId) {
    setClaimingId(leadId);
    setConflictMessage('');
    try {
      await api.claimLead(leadId);
      await load();
    } catch (err) {
      if (err.status === 409) {
        setConflictMessage('Too slow — another producer already claimed that one.');
        await load();
      } else {
        setConflictMessage(err.data?.message || 'Could not claim this lead. Try again.');
      }
    } finally {
      setClaimingId(null);
    }
  }

  if (loading) return <div style={s.wrap}>Loading…</div>;

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <h3 style={s.h3}>MOSHPIT ({leads.length})</h3>
      </div>
      <div style={s.subhead}>
        First to claim it gets it. These leads aren't assigned to anyone — grab one before someone else does.
      </div>

      {error && (
        <div style={s.loadErrorBox}>
          {error}
          <button style={s.retryButton} onClick={load}>RETRY</button>
        </div>
      )}
      {conflictMessage && <div style={s.conflictBox}>{conflictMessage}</div>}

      {leads.length === 0 && !error && (
        <EmptyState
          title="Nothing in the Moshpit right now"
          description="No leads tracking to it yet — 0 unclaimed leads. New ones will show up here the moment a Moshpit vendor sends one in."
        />
      )}

      <div style={s.grid}>
        {leads.map((lead) => {
          const c = lead.customer;
          return (
            <Card key={lead.id} id={`moshpit-lead-${lead.id}`} style={lead.id === highlightId ? { ...s.card, ...s.cardHighlighted } : s.card}>
              <div style={s.cardTop}>
                <div>
                  <div style={s.name}>{c ? `${c.firstName} ${c.lastName}` : 'Lead'}</div>
                  <div style={s.meta}>{lead.vendor?.name || 'Unknown vendor'} · {new Date(lead.receivedAt).toLocaleString()}</div>
                </div>
                {lead.product && <Badge tone="neutral">{lead.product}</Badge>}
              </div>

              <div style={s.infoGrid}>
                <InfoRow icon="📞">{c?.phone || null}</InfoRow>
                <InfoRow icon="✉️">{c?.email || null}</InfoRow>
                <InfoRow icon="📍">{[c?.state, c?.zip].filter(Boolean).join(' ') || null}</InfoRow>
              </div>

              <Button
                variant="primary"
                style={s.claimButton}
                disabled={claimingId === lead.id}
                onClick={() => claim(lead.id)}
              >
                {claimingId === lead.id ? 'CLAIMING…' : 'CLAIM'}
              </Button>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

const s = {
  wrap: {},
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  h3: { color: 'var(--text-secondary)', fontSize: 12, letterSpacing: 2 },
  subhead: { color: 'var(--text-muted)', fontSize: 12, marginBottom: 20 },
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16 },
  retryButton: { padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11 },
  conflictBox: { background: 'var(--warning-soft)', border: '1px solid rgba(255, 184, 77, 0.4)', color: 'var(--warning)', padding: '10px 14px', borderRadius: 8, fontSize: 12, marginBottom: 16 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 },
  card: { display: 'flex', flexDirection: 'column', gap: 12 },
  cardHighlighted: { outline: '2px solid var(--accent)', boxShadow: 'var(--shadow-glow-accent)' },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  name: { fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' },
  meta: { color: 'var(--text-muted)', fontSize: 11, marginTop: 2 },
  infoGrid: { display: 'flex', flexDirection: 'column', gap: 4 },
  infoRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)' },
  infoIcon: { fontSize: 12, width: 16, textAlign: 'center' },
  claimButton: { width: '100%' },
};
